#!/usr/bin/env python3
"""cc-mesh 额度探针 · Codex（A 路，必须打通）

主路径：驱动 `codex app-server` 的 stdio JSON-RPC（换行分隔 JSON-RPC 2.0），
握手 initialize → initialized(通知) → account/rateLimits/read，解析出各窗口的
used_percent / 窗口时长 / 重置时间 / 按模型拆分，输出统一契约 JSON。

降级路径：app-server 不可用时，扫 $CODEX_HOME/sessions/**/rollout-*.jsonl 里最近一条
token_count 事件的 rate_limits 快照（滞后，仅兜底，会在 extra.note 标注 stale）。

凭证：token 由 app-server 自己读，本脚本**不读也不输出任何 token**。
唯一例外是 auth.json 里 tokens.id_token 的 **email claim**：降级路径拿不到
account/read 时，用它算账号指纹（只进单向哈希，绝不输出、绝不落盘）。
JWT 不验签——这里不做鉴权，只要一个跨机稳定的账号标识。

用法:
  python3 probe_codex.py                 # 主路径，输出统一 JSON
  python3 probe_codex.py --pretty        # 缩进输出
  python3 probe_codex.py --raw           # 附原始额度快照（非敏感）
  python3 probe_codex.py --fallback-only # 跳过 app-server，只走 rollout 兜底
  python3 probe_codex.py --timeout 90    # 冷启超时（默认 90s）
  CODEX_BIN=/usr/local/bin/codex python3 probe_codex.py
  CODEX_HOME=~/.codex-custom python3 probe_codex.py   # 非默认 codex 家目录
"""
from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time

import quota_common as qc

# 注意：用户 shell 里 `codex` 是会 cd 并强塞 bypass 旗的 function，必须用绝对路径二进制
DEFAULT_CODEX_BIN = os.environ.get("CODEX_BIN", "/usr/local/bin/codex")


# ---------------------------------------------------------------------------
# 路径：一律**调用时**读 env，不在 import 期定死
# ---------------------------------------------------------------------------
# CODEX_HOME 必须被尊重——test-account 上就是 CODEX_HOME=~/.codex-custom。
# 写死 ~/.codex 的后果不是报错，是"扫不到 rollout、读不到 auth"然后一路静默降级到
# account_id=chatgpt-unknown，看板上同一个油箱被拆成两个账号（2026-08-27 测试设备实测）。
def codex_home() -> str:
    return os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")


def auth_json_path() -> str:
    return os.path.join(codex_home(), "auth.json")


def sessions_glob() -> str:
    return os.path.join(codex_home(), "sessions", "**", "rollout-*.jsonl")


def resolve_codex_bin(codex_bin: str) -> str:
    """**默认**路径不存在时退回 PATH 上的 codex。

    为什么要有：默认写死 /usr/local/bin/codex，Linux 机上常不在这儿，
    于是 app-server 路径整条失效 → 一路静默降级到 unknown 指纹。
    为什么只对默认值生效：显式传进来的路径不偷偷替换——用户说用哪个就用哪个，
    找不到就如实失败，否则「我指定了 A 却跑了 B」比找不到更难查。
    """
    if os.path.isfile(codex_bin):
        return codex_bin
    if codex_bin != DEFAULT_CODEX_BIN:
        return codex_bin
    return shutil.which("codex") or codex_bin


# ---------------------------------------------------------------------------
# 双拼读取：app-server 是 camelCase，rollout 是 snake_case
# ---------------------------------------------------------------------------
def _get(d, camel, snake, default=None):
    if not isinstance(d, dict):
        return default
    if camel in d:
        return d[camel]
    if snake in d:
        return d[snake]
    return default


def _window_to_limits(win, has_model, bucket, model, out):
    """把一个 RateLimitWindow（primary/secondary）转成一条 limit，追加到 out。"""
    if not isinstance(win, dict):
        return
    used = _get(win, "usedPercent", "used_percent")
    if used is None:
        return
    wmin = _get(win, "windowDurationMins", "window_minutes")
    resets = _get(win, "resetsAt", "resets_at")
    out.append(qc.make_limit(
        kind=qc.classify_window(wmin, has_model=has_model),
        used_percent=used,
        window_minutes=wmin,
        resets_at_iso=qc.epoch_to_iso(resets),
        bucket=bucket,
        model=model,
    ))


def _snapshot_to_limits(snap, out):
    """把一个 RateLimitSnapshot（含 primary/secondary）拆成 limits。"""
    model = _get(snap, "limitName", "limit_name")
    bucket = _get(snap, "limitId", "limit_id")
    has_model = bool(model)
    _window_to_limits(_get(snap, "primary", "primary"), has_model, bucket, model, out)
    _window_to_limits(_get(snap, "secondary", "secondary"), has_model, bucket, model, out)


def parse_rate_limits(result, account_id=None, host=None, probed_at=None,
                      include_raw=False, extra_note=None,
                      account_fp_resolved=None, account_fp_diagnostic=None) -> dict:
    """把 account/rateLimits/read 的 result（或 rollout 快照）解析成统一契约。

    支持两种输入：
      - app-server: {rateLimits, rateLimitsByLimitId, rateLimitResetCredits}
      - rollout   : 单个 RateLimitSnapshot（snake_case）
    """
    limits: list = []
    plan_type = None
    extra: dict = {}

    by_id = result.get("rateLimitsByLimitId") if isinstance(result, dict) else None
    top = result.get("rateLimits") if isinstance(result, dict) else None

    if isinstance(by_id, dict) and by_id:
        # 权威多桶视图：逐桶拆，不用顶层 mirror（避免重复计 codex 桶）
        for bucket, snap in by_id.items():
            _snapshot_to_limits(snap, limits)
            if plan_type is None:
                plan_type = _get(snap, "planType", "plan_type")
    elif isinstance(top, dict):
        # 只有顶层单桶
        _snapshot_to_limits(top, limits)
        plan_type = _get(top, "planType", "plan_type")
    else:
        # rollout 快照本身就是一个 snapshot
        _snapshot_to_limits(result, limits)
        plan_type = _get(result, "planType", "plan_type")
        top = result

    # credits（非敏感：是否有额度包 / 余额）
    credits = _get(top, "credits", "credits") if isinstance(top, dict) else None
    if isinstance(credits, dict):
        extra["credits"] = {
            "has_credits": _get(credits, "hasCredits", "has_credits"),
            "unlimited": _get(credits, "unlimited", "unlimited"),
            "balance": _get(credits, "balance", "balance"),
        }
    # 免费重置券数量（非敏感）
    rrc = result.get("rateLimitResetCredits") if isinstance(result, dict) else None
    if isinstance(rrc, dict) and rrc.get("availableCount") is not None:
        extra["reset_credits_available"] = rrc.get("availableCount")
    if extra_note:
        extra["note"] = extra_note
    # 账号指纹解析结果显式入账：解析失败绝不静默混进正常数据
    if account_fp_resolved is not None:
        extra["account_fp_status"] = "resolved" if account_fp_resolved else "unresolved"
    if account_fp_diagnostic:
        extra["account_fp_diagnostic"] = account_fp_diagnostic

    return qc.envelope(
        "codex", "ok",
        account_id=account_id,
        plan_type=plan_type,
        limits=limits,
        extra=extra or None,
        raw=result if include_raw else None,
        host=host,
        probed_at=probed_at,
    )


# ---------------------------------------------------------------------------
# 主路径：驱动 app-server
# ---------------------------------------------------------------------------
class AppServerError(Exception):
    pass


def run_appserver(codex_bin=DEFAULT_CODEX_BIN, timeout=90):
    """启动 app-server，握手，返回 (rate_result_dict, account_email_or_None)。

    account_email 仅用于上层算指纹，绝不输出；拿不到就 None。
    """
    if not (os.path.isfile(codex_bin) or _which(codex_bin)):
        raise AppServerError(f"codex 二进制不存在: {codex_bin}")

    proc = subprocess.Popen(
        [codex_bin, "app-server"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1,
    )
    q: queue.Queue = queue.Queue()

    def reader():
        try:
            for line in proc.stdout:
                q.put(line)
        finally:
            q.put(None)  # EOF 哨兵

    threading.Thread(target=reader, daemon=True).start()

    def send(obj):
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    def wait_for_id(want_id, sub_timeout):
        deadline = time.time() + sub_timeout
        while time.time() < deadline:
            try:
                line = q.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                return None
            if line is None:
                return None  # 进程 EOF
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue  # 忽略非 JSON 日志行
            if isinstance(msg, dict) and msg.get("id") == want_id:
                return msg
            # 其余为通知/其它响应，跳过
        return None

    try:
        # 1) initialize（冷启慢，给足超时）
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"clientInfo": {"name": "cc-mesh-quota-probe", "version": "0.1.0"}}})
        init = wait_for_id(1, timeout)
        if init is None:
            raise AppServerError("initialize 无响应（可能冷启超时）")
        if "error" in init:
            raise AppServerError(f"initialize 报错: {init['error']}")

        # 2) initialized 通知
        send({"jsonrpc": "2.0", "method": "initialized"})

        # 3) account/rateLimits/read
        send({"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {}})
        rl = wait_for_id(2, 30)
        if rl is None:
            raise AppServerError("account/rateLimits/read 无响应")
        if "error" in rl:
            raise AppServerError(f"rateLimits 报错: {rl['error']}")
        rate_result = rl.get("result") or {}

        # 4) account/read —— 仅为拿 email 算指纹（best-effort，失败不致命）
        email = None
        try:
            send({"jsonrpc": "2.0", "id": 3, "method": "account/read", "params": {}})
            ar = wait_for_id(3, 15)
            if ar and "result" in ar:
                acct = (ar["result"] or {}).get("account") or {}
                email = acct.get("email")  # 只进指纹哈希，不输出
        except Exception:
            email = None

        return rate_result, email
    finally:
        _kill(proc)


def _which(name):
    from shutil import which
    return which(name)


def _kill(proc):
    """干净关闭子进程，绝不留孤儿。"""
    try:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()
    except Exception:
        pass
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=3)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 账号指纹解析：额度是**账号级**的，指纹错了「多机共用一个池子」就散架
# ---------------------------------------------------------------------------
def account_email_from_auth():
    """从 $CODEX_HOME/auth.json 的 tokens.id_token 里取 email claim。

    返回 (email_or_None, diagnostic)。email **只**用于算单向指纹，
    绝不进返回的 envelope、绝不打印。diagnostic 只含路径和 claim **名**，不含任何值。
    JWT 不验签：此处不做鉴权，只要一个跨机稳定的账号标识。
    """
    path = auth_json_path()
    if not os.path.isfile(path):
        return None, f"{path}: 不存在"
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        return None, f"{path}: 读取失败({type(e).__name__})"

    tok = (d.get("tokens") or {}).get("id_token") if isinstance(d, dict) else None
    if not isinstance(tok, str) or tok.count(".") != 2:
        top = sorted(d.keys()) if isinstance(d, dict) else type(d).__name__
        return None, f"{path}: 无 tokens.id_token(JWT)，顶层keys={top}"

    payload = tok.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except Exception as e:
        return None, f"{path}: id_token payload 解不开({type(e).__name__})"

    email = claims.get("email") if isinstance(claims, dict) else None
    if not email:
        names = sorted(claims.keys()) if isinstance(claims, dict) else "?"
        return None, f"{path}: id_token 无 email claim，claim名={names}"
    return email, f"{path}: 命中 id_token.email"


def resolve_account_id(appserver_email=None):
    """解析账号指纹。返回 (account_id, resolved: bool, diagnostics: list[str])。

    过去这里的失败是**静默**的：降级分支硬编码 "chatgpt-unknown"，
    app-server 拿不到 email 时 fingerprint(None) 也返回 "chatgpt-unknown"——
    三种完全不同的失败长成同一个值，且和真账号混在一张表里，
    于是「同一油箱多机共用」的视图直接失真（2026-08-27 测试设备实测）。
    现在：能解析就给真指纹，解析不了就明确标成 unresolved 并带诊断。
    """
    diags = []
    if appserver_email:
        return qc.fingerprint("chatgpt", appserver_email), True, ["app-server account/read: 命中 email"]
    diags.append("app-server account/read: 未拿到 email")

    email, d = account_email_from_auth()
    diags.append(d)
    if email:
        return qc.fingerprint("chatgpt", email), True, diags

    # 绝不静默：调用方会把它写进 extra.account_fp_status/diagnostic
    return "chatgpt-unresolved", False, diags


# ---------------------------------------------------------------------------
# 降级路径：rollout 快照
# ---------------------------------------------------------------------------
def latest_rollout_snapshot():
    """扫 sessions 找最近一条带 rate_limits 的 token_count，返回 (snapshot, mtime) 或 (None, None)。"""
    files = glob.glob(sessions_glob(), recursive=True)
    if not files:
        return None, None
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for path in files[:40]:  # 只看最近 40 个文件，避免全盘扫
        snap = _scan_file_for_rate_limits(path)
        if snap is not None:
            return snap, os.path.getmtime(path)
    return None, None


def _scan_file_for_rate_limits(path):
    found = None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or "token_count" not in line:
                    continue
                try:
                    o = json.loads(line)
                except json.JSONDecodeError:
                    continue
                p = o.get("payload") if isinstance(o, dict) else None
                if isinstance(p, dict) and p.get("type") == "token_count" and p.get("rate_limits"):
                    found = p["rate_limits"]  # 取文件内最后一条（最新）
    except OSError:
        return None
    return found


# ---------------------------------------------------------------------------
# 编排：永远返回 envelope，绝不抛
# ---------------------------------------------------------------------------
def probe(codex_bin=DEFAULT_CODEX_BIN, timeout=90, fallback_only=False,
          include_raw=False):
    if not fallback_only:
        try:
            rate_result, email = run_appserver(resolve_codex_bin(codex_bin), timeout)
            # email 可能是 None（account/read 失败）——那也要走完整解析链去 auth.json 捞，
            # 不能像过去那样直接 fingerprint(None) 静默退化成 chatgpt-unknown。
            account_id, resolved, diags = resolve_account_id(email)
            return parse_rate_limits(rate_result, account_id=account_id,
                                     include_raw=include_raw,
                                     account_fp_resolved=resolved,
                                     account_fp_diagnostic=None if resolved else diags)
        except Exception as e:
            appserver_reason = f"app-server 路径失败: {e}"
    else:
        appserver_reason = "已指定 --fallback-only，跳过 app-server"

    # 降级：额度数据退到 rollout 快照，但**账号指纹另有来路**（auth.json），
    # 不该跟着一起退化成 unknown——指纹错了整张「多机共用一个池子」的表就废了。
    account_id, resolved, diags = resolve_account_id(None)

    snap, mtime = latest_rollout_snapshot()
    if snap is not None:
        stale = qc.epoch_to_iso(mtime)
        return parse_rate_limits(
            snap, account_id=account_id, include_raw=include_raw,
            account_fp_resolved=resolved,
            account_fp_diagnostic=None if resolved else diags,
            extra_note=f"来自 rollout 快照（滞后），采样于 {stale}；{appserver_reason}")

    extra = {"account_fp_status": "resolved" if resolved else "unresolved"}
    if not resolved:
        extra["account_fp_diagnostic"] = diags
    return qc.envelope(
        "codex", "unavailable",
        account_id=account_id,
        reason=f"{appserver_reason}；且无可用 rollout 兜底快照",
        extra=extra,
    )


def main(argv=None):
    ap = argparse.ArgumentParser(description="Codex 额度探针")
    ap.add_argument("--codex-bin", default=DEFAULT_CODEX_BIN)
    ap.add_argument("--timeout", type=int, default=90, help="app-server 冷启超时秒（默认 90）")
    ap.add_argument("--fallback-only", action="store_true", help="跳过 app-server，只走 rollout")
    ap.add_argument("--raw", action="store_true", help="附带原始额度快照（非敏感）")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args(argv)

    env = probe(codex_bin=args.codex_bin, timeout=args.timeout,
                fallback_only=args.fallback_only, include_raw=args.raw)
    indent = 2 if args.pretty else None
    print(json.dumps(env, ensure_ascii=False, indent=indent))
    return 0 if env["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
