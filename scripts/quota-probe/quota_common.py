#!/usr/bin/env python3
"""cc-mesh 额度探针 · 公共库

两个探针（probe_codex / probe_claude）共用的：
  - 统一输出契约（envelope）的构造
  - 窗口分类（5h / 7d / 7d_scoped）
  - 时间归一化（epoch 秒 / ISO 串 → 带时区的 ISO8601）
  - 非敏感指纹（把 email 等 PII 单向哈希成短指纹）

纯标准库，无第三方依赖。凭证/PII 绝不落盘、绝不打印——本模块只接收已经脱敏或
仅用于哈希的输入，输出里只留额度百分比、窗口、重置时间等非敏感字段。
"""
from __future__ import annotations

import hashlib
import socket
from datetime import datetime, timezone

SCHEMA_VERSION = "1"


# ---------------------------------------------------------------------------
# 时间
# ---------------------------------------------------------------------------
# probed_at（采样时刻）一律输出 **UTC ISO8601 带 Z**，如 2026-08-27T17:52:10Z。
#
# 为什么不再用本机时区偏移（2026-08-27 生产实测修正）：
# 带偏移确实"无歧义"，但**只有先解析才无歧义**。云端账本把 probed_at 当字符串存、
# 看板按字符串排序，于是同一时刻的两条快照——
#   server(UTC+8)  2026-08-28T01:30:02+08:00
#   测试设备(UTC-7) 2026-08-27T10:30:01-07:00
# 字典序里 server 永远排在前面，"最新快照"这一列彻底不可信（哪怕 server 的数据更陈旧）。
# 统一 UTC+Z 之后字典序 == 时间序，排序不再需要任何解析器配合。
#
# 注意：resets_at 仍走 epoch_to_iso / iso_to_iso 输出**本机时区带显式偏移**——
# 那个字段是给人看重置点的，且始终带偏移，解析后可比。两者格式不同是有意的，
# 别顺手"统一"掉：probed_at 的消费者是排序器，resets_at 的消费者是人。
def now_iso() -> str:
    """当前采样时刻，UTC ISO8601 带 Z（跨机可直接按字符串排序）。"""
    return (datetime.now(timezone.utc).replace(microsecond=0)
            .isoformat().replace("+00:00", "Z"))


def epoch_to_iso(epoch_seconds) -> str | None:
    """epoch 秒（int/float）→ ISO8601（本机时区）。None/非法 → None。"""
    if epoch_seconds is None:
        return None
    try:
        return (datetime.fromtimestamp(float(epoch_seconds), timezone.utc)
                .astimezone().replace(microsecond=0).isoformat())
    except (ValueError, OSError, TypeError):
        return None


def iso_to_iso(iso_str) -> str | None:
    """任意 ISO8601 串 → 归一到本机时区的 ISO8601。解析不了就原样返回。"""
    if not iso_str:
        return None
    try:
        s = str(iso_str).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone().replace(microsecond=0).isoformat()
    except ValueError:
        return str(iso_str)


# ---------------------------------------------------------------------------
# 窗口分类：把 codex（按分钟）和 claude（按 kind）统一成同一套词汇
# ---------------------------------------------------------------------------
def classify_window(window_minutes, has_model: bool = False) -> str:
    """按窗口时长归一成跨源可比的 kind。

    5h        滚动 5 小时窗（codex primary≈300min / claude session）
    7d        7 天总量窗（codex 10080min 无模型 / claude weekly_all）
    7d_scoped 7 天按模型专项（codex 带 limitName 的桶 / claude weekly_scoped）
    other     无法归类
    """
    if window_minutes is None:
        return "other"
    try:
        m = int(window_minutes)
    except (ValueError, TypeError):
        return "other"
    if m <= 360:                       # ≤6h → 5h 滚动窗
        return "5h"
    if 1440 * 6 <= m <= 1440 * 8:      # 6~8 天 → 7 天窗
        return "7d_scoped" if has_model else "7d"
    return "other"


def make_limit(kind, used_percent, window_minutes=None, resets_at_iso=None,
               bucket=None, model=None) -> dict:
    """构造 limits[] 里的一条。"""
    return {
        "kind": kind,
        "bucket": bucket,
        "model": model,
        "used_percent": used_percent,
        "window_minutes": window_minutes,
        "resets_at": resets_at_iso,
    }


# ---------------------------------------------------------------------------
# 指纹：单向哈希，绝不可逆，输出安全
# ---------------------------------------------------------------------------
def fingerprint(prefix: str, secret: str | None) -> str:
    """把 email 等标识哈希成 `<prefix>-<12hex>` 短指纹。secret 为空 → `<prefix>-unknown`。

    secret 只进哈希函数，绝不出现在返回值或任何输出里。
    """
    if not secret:
        return f"{prefix}-unknown"
    h = hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}-{h}"


def host_short() -> str:
    try:
        return socket.gethostname().split(".")[0]
    except Exception:
        return "unknown-host"


# ---------------------------------------------------------------------------
# 统一输出契约
# ---------------------------------------------------------------------------
def envelope(source, status, *, account_id=None, plan_type=None,
             limits=None, reason=None, extra=None, raw=None,
             host=None, probed_at=None) -> dict:
    """构造统一输出信封。两个探针的唯一出口，保证 schema 一致。

    source     "codex" | "claude"
    status     "ok" | "unavailable"
    account_id 非敏感账号指纹（见 fingerprint）
    plan_type  订阅档，源相关，可空
    limits     make_limit(...) 列表；unavailable 时为空
    reason     status=unavailable 时的原因（非敏感）
    extra      源相关非敏感补充（credits / reset credits / extra_usage 等）
    raw        可选，原始额度快照（只放非敏感的额度数值，不放任何凭证）
    """
    env = {
        "schema_version": SCHEMA_VERSION,
        "source": source,
        "host": host or host_short(),
        "account_id": account_id,
        "probed_at": probed_at or now_iso(),
        "status": status,
        "plan_type": plan_type,
        "limits": limits or [],
    }
    if reason:
        env["reason"] = reason
    if extra:
        env["extra"] = extra
    if raw is not None:
        env["raw"] = raw
    return env
