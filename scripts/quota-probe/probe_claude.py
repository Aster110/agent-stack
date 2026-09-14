#!/usr/bin/env python3
"""cc-mesh 额度探针 · Claude Code（B 路，尽力项）

入口：GET https://api.anthropic.com/api/oauth/usage
头：Authorization: Bearer <token> + anthropic-beta: oauth-2025-04-20
返回 limits[]：每项 {kind, scope, percent, resets_at}
  kind = session(5h) / weekly_all(7天) / weekly_scoped(按模型，名在 scope.model.display_name)
另有 extra_usage{is_enabled, used_credits}

凭证来源按序尝试（token 只用于发请求，绝不落盘、绝不打印）：
  1. macOS keychain service "Claude Code-credentials" 的若干 account → claudeAiOauth.accessToken
  2. ~/.claude/.credentials.json → claudeAiOauth.accessToken
  3. env CLAUDE_CODE_OAUTH_TOKEN
全找不到 → status=unavailable + 非敏感诊断（各源顶层 key 布局，不含任何值）。

account_id 从 ~/.claude.json oauthAccount.accountUuid 取（本就是不透明标识，非 PII）。

用法:
  python3 probe_claude.py            # 输出统一 JSON
  python3 probe_claude.py --pretty
  python3 probe_claude.py --raw
  python3 probe_claude.py --timeout 30   # usage 接口超时秒（默认 15）
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

import quota_common as qc

KEYCHAIN_SERVICE = "Claude Code-credentials"
KEYCHAIN_ACCOUNTS = [os.environ.get("USER", ""), "unknown", "Claude"]
CREDENTIALS_JSON = os.path.expanduser("~/.claude/.credentials.json")
CLAUDE_JSON = os.path.expanduser("~/.claude.json")
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
# usage 接口超时秒。codex 那路一直收 --timeout，这边过去写死 15、
# report-quota.sh 传下来的值被静默吞掉（脚本 --help 里却写着支持）。
DEFAULT_TIMEOUT = 15

KIND_MAP = {
    # claude kind -> (统一 kind, 窗口分钟)
    "session": ("5h", 300),
    "weekly_all": ("7d", 10080),
    "weekly_scoped": ("7d_scoped", 10080),
}


# ---------------------------------------------------------------------------
# 账号指纹（非敏感）
# ---------------------------------------------------------------------------
# 指纹取自 ~/.claude.json 的 oauthAccount.accountUuid —— **明文配置，不在 keychain**。
# 所以「凭证没了」和「指纹取不到」是两件独立的事：claudeAiOauth 消失时额度采不到，
# 但账号指纹照样拿得到，席位仍该挂得上自己的油箱。别把两者绑在一起判。
#
# accountUuid 本身就是不透明标识（非 PII），直接用作指纹；**不再哈希**——
# 必须和 quota 快照里的 account_id 逐字节相同，看板才认领得上（seats.account_fp
# 与 quota_snapshots.account_fp 是同一个键）。
def resolve_account_fp(claude_json_path=None):
    """返回 (account_fp_or_None, diagnostics)。

    取不到就**如实 None**，绝不编一个 "claude-unknown" 混进正常数据——
    席位宁可留 null，也不要一个假指纹把两个账号并成一个（codex 侧刚踩过这个坑）。
    diagnostics 只含路径和 key 名，不含任何值。
    """
    path = claude_json_path or CLAUDE_JSON
    diags = []
    if not os.path.isfile(path):
        return None, [f"{path}: 不存在"]
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        return None, [f"{path}: 读取失败({type(e).__name__})"]

    oauth = d.get("oauthAccount") if isinstance(d, dict) else None
    if not isinstance(oauth, dict):
        top = sorted(d.keys())[:12] if isinstance(d, dict) else type(d).__name__
        return None, [f"{path}: 无 oauthAccount 段，顶层keys(前12)={top}"]

    uuid = oauth.get("accountUuid")
    if not uuid:
        return None, [f"{path}: oauthAccount 无 accountUuid，keys={sorted(oauth.keys())}"]
    diags.append(f"{path}: 命中 oauthAccount.accountUuid")
    return f"claude-{uuid}", diags


def get_account_id(claude_json_path=None):
    """向后兼容的薄封装：拿不到时返回 None（调用方自己决定怎么标记）。"""
    fp, _ = resolve_account_fp(claude_json_path)
    return fp


# ---------------------------------------------------------------------------
# 凭证获取：多源尝试 + 非敏感诊断
# ---------------------------------------------------------------------------
def _keychain_raw(account):
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
            capture_output=True, text=True, timeout=10,
        )
    except (subprocess.SubprocessError, OSError) as e:
        return None, f"security 调用失败({type(e).__name__})"
    if out.returncode != 0:
        return None, "item-not-found"
    return out.stdout, None


def _extract_oauth_token(raw_json_str):
    """从一段 JSON 文本里取 claudeAiOauth.accessToken，同时返回顶层 key 布局（非敏感）。"""
    try:
        d = json.loads(raw_json_str)
    except (json.JSONDecodeError, TypeError):
        return None, None, "非 JSON"
    layout = sorted(d.keys()) if isinstance(d, dict) else type(d).__name__
    oauth = d.get("claudeAiOauth") if isinstance(d, dict) else None
    if isinstance(oauth, dict) and oauth.get("accessToken"):
        return oauth["accessToken"], oauth.get("expiresAt"), layout
    return None, None, layout


def get_token():
    """返回 (token, expires_at, diagnostics)。找不到 token 时 token=None。

    diagnostics 是非敏感的布局清单（只含顶层 key 名，绝无任何值/token）。
    """
    diags = []

    # 1) keychain 各 account
    seen = set()
    for acct in KEYCHAIN_ACCOUNTS:
        if not acct or acct in seen:
            continue
        seen.add(acct)
        raw, err = _keychain_raw(acct)
        if err:
            diags.append(f"keychain[{KEYCHAIN_SERVICE}/{acct}]: {err}")
            continue
        token, exp, layout = _extract_oauth_token(raw)
        if token:
            diags.append(f"keychain[{KEYCHAIN_SERVICE}/{acct}]: 命中 claudeAiOauth")
            return token, exp, diags
        diags.append(f"keychain[{KEYCHAIN_SERVICE}/{acct}]: 顶层keys={layout}，无 claudeAiOauth.accessToken")

    # 2) ~/.claude/.credentials.json
    if os.path.isfile(CREDENTIALS_JSON):
        try:
            with open(CREDENTIALS_JSON, "r", encoding="utf-8") as f:
                token, exp, layout = _extract_oauth_token(f.read())
            if token:
                diags.append(f"{CREDENTIALS_JSON}: 命中 claudeAiOauth")
                return token, exp, diags
            diags.append(f"{CREDENTIALS_JSON}: 顶层keys={layout}，无 claudeAiOauth.accessToken")
        except OSError as e:
            diags.append(f"{CREDENTIALS_JSON}: 读取失败({type(e).__name__})")
    else:
        diags.append(f"{CREDENTIALS_JSON}: 不存在")

    # 3) 环境变量
    env_tok = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if env_tok:
        diags.append("env CLAUDE_CODE_OAUTH_TOKEN: 已设置")
        return env_tok, None, diags
    diags.append("env CLAUDE_CODE_OAUTH_TOKEN: 未设置")

    return None, None, diags


def _expired(expires_at):
    if not expires_at:
        return False
    try:
        return expires_at / 1000 < datetime.now(timezone.utc).timestamp()
    except (TypeError, ValueError):
        return False


# ---------------------------------------------------------------------------
# 拉取 + 解析
# ---------------------------------------------------------------------------
def fetch_usage(token, timeout=DEFAULT_TIMEOUT):
    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def parse_usage(data, account_id=None, host=None, probed_at=None,
                include_raw=False, fp_extra=None) -> dict:
    """把 oauth/usage 响应解析成统一契约（纯函数，可用 fixture 测）。"""
    limits = []
    for lim in data.get("limits", []) if isinstance(data, dict) else []:
        raw_kind = lim.get("kind")
        kind, wmin = KIND_MAP.get(raw_kind, ("other", None))
        scope = lim.get("scope") or {}
        model = (scope.get("model") or {}).get("display_name")
        limits.append(qc.make_limit(
            kind=kind,
            used_percent=lim.get("percent", 0),
            window_minutes=wmin,
            resets_at_iso=qc.iso_to_iso(lim.get("resets_at")),
            bucket=raw_kind,
            model=model,
        ))

    extra = {}
    eu = data.get("extra_usage") if isinstance(data, dict) else None
    if isinstance(eu, dict):
        extra["extra_usage"] = {
            "is_enabled": eu.get("is_enabled"),
            "used_credits": eu.get("used_credits"),
        }

    if fp_extra:
        extra.update(fp_extra)

    return qc.envelope(
        "claude", "ok",
        account_id=account_id,
        plan_type=None,
        limits=limits,
        extra=extra or None,
        raw=data if include_raw else None,
        host=host,
        probed_at=probed_at,
    )


# ---------------------------------------------------------------------------
# 编排：永远返回 envelope，绝不抛
# ---------------------------------------------------------------------------
def probe(include_raw=False, timeout=DEFAULT_TIMEOUT, claude_json_path=None):
    account_fp, fp_diags = resolve_account_fp(claude_json_path)
    # 指纹解析失败不许静默：账本要求 account_id 非空（否则整条快照被丢），
    # 所以给一个**一眼看得出没解析出来**的哨兵值，同时把状态和诊断显式入账。
    account_id = account_fp or "claude-unresolved"
    fp_extra = {"account_fp_status": "resolved" if account_fp else "unresolved"}
    if not account_fp:
        fp_extra["account_fp_diagnostic"] = fp_diags

    token, expires_at, diags = get_token()

    if not token:
        env = qc.envelope(
            "claude", "unavailable",
            account_id=account_id,
            reason="未找到有效 claudeAiOauth accessToken（凭证链已变更/未登录）",
            extra={"diagnostic": diags, **fp_extra},
        )
        return env

    if _expired(expires_at):
        # token 过期仍尝试，可能 401；标注一下
        pass

    try:
        data = fetch_usage(token, timeout)
    except urllib.error.HTTPError as e:
        return qc.envelope(
            "claude", "unavailable",
            account_id=account_id,
            reason=f"usage 接口 HTTP {e.code}（token 可能已失效/过期）",
            extra={"diagnostic": diags, **fp_extra},
        )
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return qc.envelope(
            "claude", "unavailable",
            account_id=account_id,
            reason=f"usage 接口网络失败: {type(e).__name__}",
            extra={"diagnostic": diags, **fp_extra},
        )

    return parse_usage(data, account_id=account_id, include_raw=include_raw,
                       fp_extra=fp_extra)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Claude Code 额度探针")
    ap.add_argument("--raw", action="store_true", help="附带原始 usage 响应")
    ap.add_argument("--pretty", action="store_true")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                    help=f"usage 接口超时秒（默认 {DEFAULT_TIMEOUT}）")
    ap.add_argument("--account-id", action="store_true",
                    help="只打印账号指纹（供 PUT /api/ledger/seats 的 accountFp 用）；"
                         "取不到则 stdout 为空、诊断走 stderr、退出码 1")
    args = ap.parse_args(argv)

    # 席位登记用：只要指纹，不碰凭证、不发网络请求。
    # 取不到时**什么都不打印**——调用方拿到空串就该写 null，而不是被塞一个假指纹。
    if args.account_id:
        fp, diags = resolve_account_fp()
        if fp:
            print(fp)
            return 0
        for d in diags:
            print(d, file=sys.stderr)
        return 1

    env = probe(include_raw=args.raw, timeout=args.timeout)
    indent = 2 if args.pretty else None
    print(json.dumps(env, ensure_ascii=False, indent=indent))
    return 0 if env["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
