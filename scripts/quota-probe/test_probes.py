#!/usr/bin/env python3
"""cc-mesh 额度探针 · 单元测试（纯标准库 unittest）

覆盖:
  ① codex 探针对 mock app-server JSON-RPC 响应能正确 parse（used_percent/resets/per-model）
  ② claude 探针对 mock usage JSON 能正确解析三档 kind
  ③ 探针遇凭证缺失输出 status:unavailable 且不抛异常
  ④ 上报脚本 --dry-run 输出的 mesh send JSON 结构正确
  + codex 兼容 rollout 的 snake_case 快照；两源 envelope schema 一致

跑: python3 test_probes.py -v
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import quota_common as qc
import probe_codex
import probe_claude

FIX = os.path.join(HERE, "fixtures")


def load_fix(name):
    with open(os.path.join(FIX, name), "r", encoding="utf-8") as f:
        return json.load(f)


def by_kind(env, kind):
    return [x for x in env["limits"] if x["kind"] == kind]


class TestCodexParse(unittest.TestCase):
    def test_appserver_parse(self):
        """① app-server 响应 → 正确的 used_percent / resets / per-model。"""
        result = load_fix("codex_appserver_ratelimits.json")
        env = probe_codex.parse_rate_limits(result, account_id="chatgpt-testfp")

        self.assertEqual(env["source"], "codex")
        self.assertEqual(env["status"], "ok")
        self.assertEqual(env["plan_type"], "pro")
        self.assertEqual(env["account_id"], "chatgpt-testfp")

        # 逐桶拆，不双计顶层 mirror：codex(7d) + codex_bengalfox(5h + 7d_scoped) = 3 条
        self.assertEqual(len(env["limits"]), 3)

        # 5h 窗来自 codex_bengalfox，used 42%，带模型名
        h5 = by_kind(env, "5h")
        self.assertEqual(len(h5), 1)
        self.assertEqual(h5[0]["used_percent"], 42)
        self.assertEqual(h5[0]["window_minutes"], 300)
        self.assertEqual(h5[0]["model"], "GPT-5.3-Codex-Spark")
        self.assertEqual(h5[0]["bucket"], "codex_bengalfox")
        # resets_at 归一成 ISO 串
        self.assertIsInstance(h5[0]["resets_at"], str)
        self.assertIn("T", h5[0]["resets_at"])

        # 7d 总量窗（codex 桶，无模型）
        d7 = by_kind(env, "7d")
        self.assertEqual(len(d7), 1)
        self.assertEqual(d7[0]["used_percent"], 14)
        self.assertIsNone(d7[0]["model"])

        # 7d_scoped（codex_bengalfox 的 secondary，带模型）
        d7s = by_kind(env, "7d_scoped")
        self.assertEqual(len(d7s), 1)
        self.assertEqual(d7s[0]["used_percent"], 7)
        self.assertEqual(d7s[0]["model"], "GPT-5.3-Codex-Spark")

        # extra：credits + 重置券
        self.assertIn("credits", env["extra"])
        self.assertEqual(env["extra"]["credits"]["has_credits"], False)
        self.assertEqual(env["extra"]["reset_credits_available"], 1)

    def test_rollout_snakecase(self):
        """codex 兼容 rollout 的 snake_case 单快照。"""
        snap = load_fix("codex_rollout_snapshot.json")
        env = probe_codex.parse_rate_limits(snap, account_id="chatgpt-unknown")
        self.assertEqual(env["status"], "ok")
        self.assertEqual(env["plan_type"], "pro")
        self.assertEqual(len(env["limits"]), 1)
        self.assertEqual(env["limits"][0]["kind"], "7d")
        self.assertEqual(env["limits"][0]["used_percent"], 9.0)


class TestClaudeParse(unittest.TestCase):
    def test_usage_three_kinds(self):
        """② usage 响应 → 三档 kind 正确解析。"""
        data = load_fix("claude_usage.json")
        env = probe_claude.parse_usage(data, account_id="claude-abc")

        self.assertEqual(env["source"], "claude")
        self.assertEqual(env["status"], "ok")
        self.assertEqual(len(env["limits"]), 3)

        h5 = by_kind(env, "5h")[0]
        self.assertEqual(h5["used_percent"], 23)
        self.assertEqual(h5["window_minutes"], 300)
        self.assertEqual(h5["bucket"], "session")

        d7 = by_kind(env, "7d")[0]
        self.assertEqual(d7["used_percent"], 61)

        scoped = by_kind(env, "7d_scoped")[0]
        self.assertEqual(scoped["used_percent"], 88)
        self.assertEqual(scoped["model"], "Claude Opus 4.8")

        # resets_at 归一成带显式时区偏移的 ISO（偏移量取决于探针所在机器的时区，
        # 断言"带偏移可解析"而非某个固定偏移，否则换时区的机器上会假失败）
        self.assertIsNotNone(datetime.fromisoformat(h5["resets_at"]).tzinfo)

        # extra_usage
        self.assertTrue(env["extra"]["extra_usage"]["is_enabled"])
        self.assertEqual(env["extra"]["extra_usage"]["used_credits"], 1250)


class TestProbedAtIsUtc(unittest.TestCase):
    """Bug A（生产实测）：probed_at 过去输出本机时区偏移，云端按**字符串**排序，
    于是同一时刻的两条快照在字典序里差 15 小时——server(UTC+8) 永远排在测试设备(UTC-7) 前面，
    看板「最新快照」这一列彻底不可信。统一 UTC+Z 后字典序 == 时间序。"""

    def _now_iso_under_tz(self, tz):
        code = ("import sys; sys.path.insert(0, %r); "
                "import quota_common as q; print(q.now_iso())" % HERE)
        proc = subprocess.run([sys.executable, "-c", code], capture_output=True,
                              text=True, timeout=30, env={**os.environ, "TZ": tz})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.strip()

    def test_now_iso_is_utc_with_z(self):
        s = qc.now_iso()
        self.assertTrue(s.endswith("Z"), f"必须带 Z: {s}")
        self.assertNotIn("+", s, f"不许再带本地偏移: {s}")
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        self.assertEqual(dt.utcoffset().total_seconds(), 0)

    def test_identical_across_timezones(self):
        """同一时刻、两个时区，输出必须是同一个字符串表示（这正是过去差 15 小时的地方）。"""
        sh = self._now_iso_under_tz("Asia/Shanghai")
        la = self._now_iso_under_tz("America/Los_Angeles")
        for tz, s in (("Asia/Shanghai", sh), ("America/Los_Angeles", la)):
            self.assertTrue(s.endswith("Z"), f"{tz}: {s}")
        # 同一小时（两次子进程调用间隔远小于 1 小时）
        self.assertEqual(sh[:13], la[:13], f"跨时区必须同刻: {sh} vs {la}")
        a = datetime.fromisoformat(sh.replace("Z", "+00:00"))
        b = datetime.fromisoformat(la.replace("Z", "+00:00"))
        self.assertLess(abs((a - b).total_seconds()), 30)

    def test_envelope_probed_at_is_utc(self):
        env = qc.envelope("codex", "ok")
        self.assertTrue(env["probed_at"].endswith("Z"), env["probed_at"])

    def test_string_sort_equals_chronological_sort(self):
        """字典序 == 时间序：看板不解析也能排对。"""
        earlier = "2026-08-27T17:30:00Z"   # UTC-7 10:30
        later = "2026-08-27T17:52:00Z"     # UTC+8次日 01:52
        self.assertLess(earlier, later)
        rows = sorted([later, earlier])
        self.assertEqual(rows[0], earlier, "最早的必须排最前")


class TestCodexAccountFingerprint(unittest.TestCase):
    """Bug B（生产实测）：测试设备的 accountFp 退化成 chatgpt-unknown，而 server 是
    chatgpt-fixture0000——**同一个油箱被拆成两个账号**，"多机共用一个池子"的
    视图失真，正好毁掉 用户用来防超发的那块。

    根因：app-server 路径挂掉后，降级分支**硬编码** account_id="chatgpt-unknown"，
    从不尝试别处取 email；而且 app-server 即使成功、email 为 None 时
    fingerprint() 也会静默返回 "chatgpt-unknown"。三种失败长得一模一样。
    """

    @staticmethod
    def _jwt(claims):
        def b64(d):
            return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
        return f"{b64({'alg':'none'})}.{b64(claims)}.sig"

    def _home(self, tmp, claims=None, tokens_extra=None):
        """造一个假 CODEX_HOME，里面放 auth.json。"""
        if claims is not None:
            tokens = {"id_token": self._jwt(claims)}
            if tokens_extra:
                tokens.update(tokens_extra)
            with open(os.path.join(tmp, "auth.json"), "w", encoding="utf-8") as f:
                json.dump({"auth_mode": "chatgpt", "tokens": tokens}, f)
        return tmp

    def test_email_gives_stable_fp_across_machines(self):
        """同一 email → 同一指纹，这是「多机一个池子」成立的前提。"""
        a = qc.fingerprint("chatgpt", "owner@example.com")
        b = qc.fingerprint("chatgpt", "owner@example.com")
        self.assertEqual(a, b)
        self.assertTrue(a.startswith("chatgpt-"))
        self.assertNotEqual(a, "chatgpt-unknown")

    def test_fallback_recovers_email_from_auth_json(self):
        """app-server 挂了也要从 auth.json 的 id_token 恢复出**同一个**指纹。
        这就是测试设备该有的行为。"""
        with tempfile.TemporaryDirectory() as tmp:
            self._home(tmp, {"email": "owner@example.com"})
            os.environ["CODEX_HOME"] = tmp
            try:
                acct, resolved, diags = probe_codex.resolve_account_id(None)
            finally:
                del os.environ["CODEX_HOME"]
            self.assertTrue(resolved, diags)
            self.assertEqual(acct, qc.fingerprint("chatgpt", "owner@example.com"),
                             "降级路径的指纹必须和 app-server 路径一模一样")

    def test_appserver_email_preferred(self):
        acct, resolved, _ = probe_codex.resolve_account_id("owner@example.com")
        self.assertTrue(resolved)
        self.assertEqual(acct, qc.fingerprint("chatgpt", "owner@example.com"))

    def test_unresolved_is_flagged_not_silent(self):
        """取不到就要如实标记 + 可诊断，不许静默写 unknown 混进正常数据。"""
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["CODEX_HOME"] = tmp   # 空目录，没有 auth.json
            try:
                acct, resolved, diags = probe_codex.resolve_account_id(None)
            finally:
                del os.environ["CODEX_HOME"]
            self.assertFalse(resolved)
            self.assertTrue(diags, "必须留下可诊断线索")
            self.assertIn("unresolved", acct,
                          "要一眼看出是没解析出来，不能和真账号混为一谈")

    def test_auth_without_email_claim_is_diagnosable(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._home(tmp, {"sub": "user-123"})   # 有 JWT 但没 email claim
            os.environ["CODEX_HOME"] = tmp
            try:
                acct, resolved, diags = probe_codex.resolve_account_id(None)
            finally:
                del os.environ["CODEX_HOME"]
            self.assertFalse(resolved)
            joined = " ".join(diags)
            self.assertIn("email", joined, f"诊断要说清缺的是什么: {diags}")

    def test_diagnostics_never_leak_secrets(self):
        """诊断只许出现路径和 claim 名，绝不许出现 token / email 本身。"""
        with tempfile.TemporaryDirectory() as tmp:
            self._home(tmp, {"sub": "u", "name": "n"},
                       tokens_extra={"access_token": "SECRET-ACCESS-TOKEN",
                                     "refresh_token": "SECRET-REFRESH"})
            os.environ["CODEX_HOME"] = tmp
            try:
                _, _, diags = probe_codex.resolve_account_id(None)
            finally:
                del os.environ["CODEX_HOME"]
            blob = " ".join(diags)
            self.assertNotIn("SECRET-ACCESS-TOKEN", blob)
            self.assertNotIn("SECRET-REFRESH", blob)

    def test_email_never_appears_in_envelope(self):
        """email 只进哈希，绝不出现在输出里。"""
        with tempfile.TemporaryDirectory() as tmp:
            self._home(tmp, {"email": "owner@example.com"})
            os.environ["CODEX_HOME"] = tmp
            try:
                env = probe_codex.probe(codex_bin="/nonexistent/codex-xyz", timeout=1)
            finally:
                del os.environ["CODEX_HOME"]
            self.assertNotIn("owner@example.com", json.dumps(env, ensure_ascii=False))

    def test_codex_home_env_is_honored(self):
        """CODEX_HOME 必须被尊重——test-account 上就是 ~/.codex-custom，写死 ~/.codex 直接取不到。"""
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["CODEX_HOME"] = tmp
            try:
                self.assertTrue(probe_codex.auth_json_path().startswith(tmp))
                self.assertTrue(probe_codex.sessions_glob().startswith(tmp))
            finally:
                del os.environ["CODEX_HOME"]

    def test_explicit_codex_bin_is_not_silently_replaced(self):
        """显式指定的二进制路径不许被 PATH 上的同名程序偷偷顶替。"""
        self.assertEqual(probe_codex.resolve_codex_bin("/nonexistent/codex-xyz"),
                         "/nonexistent/codex-xyz")

    def test_default_codex_bin_falls_back_to_path(self):
        """默认路径不存在时才退回 PATH（Linux 机上 /usr/local/bin/codex 常常没有）。"""
        resolved = probe_codex.resolve_codex_bin(probe_codex.DEFAULT_CODEX_BIN)
        if not os.path.isfile(probe_codex.DEFAULT_CODEX_BIN):
            which = shutil.which("codex")
            if which:
                self.assertEqual(resolved, which)

    def test_unresolved_marked_in_envelope_extra(self):
        """envelope 层面也要看得见：extra.account_fp_status。"""
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["CODEX_HOME"] = tmp
            try:
                env = probe_codex.probe(codex_bin="/nonexistent/codex-xyz", timeout=1)
            finally:
                del os.environ["CODEX_HOME"]
            self.assertEqual(env["extra"]["account_fp_status"], "unresolved")
            self.assertIn("account_fp_diagnostic", env["extra"])


class TestClaudeAccountFp(unittest.TestCase):
    """席位 computer1/claude-main 的 accountFp 是 null → 看板按 accountFp
    把额度聚合成"油箱"，席位没指纹就认领不了自己的额度。

    关键事实：claude 的稳定账号标识在 **~/.claude.json 的 oauthAccount.accountUuid**，
    是明文配置、**不在 keychain 里**——所以此刻 claudeAiOauth 虽然没了，
    指纹照样取得到。凭证缺失 ≠ 指纹缺失，两件事别混。
    """

    def _cfg(self, tmp, payload):
        p = os.path.join(tmp, "claude.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        return p

    def test_fp_from_account_uuid(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._cfg(tmp, {"oauthAccount": {"accountUuid": "06539c51-fad0-4aa2",
                                                 "emailAddress": "a@b.com"}})
            fp, diags = probe_claude.resolve_account_fp(p)
            self.assertEqual(fp, "claude-06539c51-fad0-4aa2")
            self.assertTrue(diags)

    def test_fp_is_stable_across_machines(self):
        """同账号不同机器必须同指纹——否则"多机一个池子"又散架。"""
        with tempfile.TemporaryDirectory() as tmp:
            p = self._cfg(tmp, {"oauthAccount": {"accountUuid": "same-uuid"}})
            self.assertEqual(probe_claude.resolve_account_fp(p)[0],
                             probe_claude.resolve_account_fp(p)[0])

    def test_missing_returns_none_not_fabricated(self):
        """取不到就如实 None，绝不瞎编一个（席位宁可留 null）。"""
        with tempfile.TemporaryDirectory() as tmp:
            p = self._cfg(tmp, {"someOtherKey": 1})
            fp, diags = probe_claude.resolve_account_fp(p)
            self.assertIsNone(fp)
            self.assertTrue(diags, "必须留可诊断线索")
            self.assertIn("oauthAccount", " ".join(diags))

    def test_missing_file_diagnosable(self):
        fp, diags = probe_claude.resolve_account_fp("/nonexistent/claude.json")
        self.assertIsNone(fp)
        self.assertIn("不存在", " ".join(diags))

    def test_fp_never_leaks_email(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._cfg(tmp, {"oauthAccount": {"accountUuid": "u1",
                                                 "emailAddress": "secret@example.com"}})
            fp, diags = probe_claude.resolve_account_fp(p)
            self.assertNotIn("secret@example.com", fp + " ".join(diags))

    def test_account_id_cli_prints_bare_fp(self):
        """--account-id 只吐指纹，供席位登记直接用（PUT /api/ledger/seats 的 accountFp）。"""
        proc = subprocess.run(
            [sys.executable, os.path.join(HERE, "probe_claude.py"), "--account-id"],
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
        out = proc.stdout.strip()
        if proc.returncode == 0:
            self.assertTrue(out.startswith("claude-"), out)
            self.assertNotIn(" ", out, "必须是纯指纹，别带装饰")
        else:
            self.assertEqual(out, "", "取不到时 stdout 必须为空，别让调用方拿到假值")
            self.assertTrue(proc.stderr.strip(), "取不到要在 stderr 留诊断")

    def test_envelope_marks_unresolved_instead_of_silent_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._cfg(tmp, {})
            env = probe_claude.probe(claude_json_path=p)
            self.assertEqual(env["extra"]["account_fp_status"], "unresolved")
            self.assertIn("account_fp_diagnostic", env["extra"])
            # 快照仍要能落地（account_id 非空），但一眼看得出没解析出来
            self.assertIn("unresolved", env["account_id"])

    def test_envelope_fp_matches_seat_fp(self):
        """席位指纹和快照指纹必须是同一个字符串，否则看板挂不上。"""
        with tempfile.TemporaryDirectory() as tmp:
            p = self._cfg(tmp, {"oauthAccount": {"accountUuid": "uuid-xyz"}})
            seat_fp, _ = probe_claude.resolve_account_fp(p)
            env = probe_claude.probe(claude_json_path=p)
            self.assertEqual(env["account_id"], seat_fp)


class TestClaudeTimeout(unittest.TestCase):
    """report-quota.sh 文档写着 `--timeout N  探针/请求超时秒`，codex 一直收得到，
    claude 这一路却把它吞了（probe_claude.py 压根没这个参数，超时恒 15s 写死）。
    文档承诺 ≠ 实际行为，这是真 bug，不是风格差异。"""

    def test_cli_accepts_timeout(self):
        """probe_claude.py 必须认 --timeout（report-quota.sh 要传给它）。"""
        proc = subprocess.run(
            [sys.executable, os.path.join(HERE, "probe_claude.py"), "--help"],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--timeout", proc.stdout)

    def test_timeout_reaches_http_call(self):
        """--timeout 要真传到 HTTP 请求，不是收下就扔。"""
        seen = {}

        def fake_fetch(token, timeout=15):
            seen["timeout"] = timeout
            return load_fix("claude_usage.json")

        orig_token, orig_fetch = probe_claude.get_token, probe_claude.fetch_usage
        probe_claude.get_token = lambda: ("tok-not-real", None, [])
        probe_claude.fetch_usage = fake_fetch
        try:
            env = probe_claude.probe(timeout=7)
        finally:
            probe_claude.get_token, probe_claude.fetch_usage = orig_token, orig_fetch
        self.assertEqual(seen["timeout"], 7, "--timeout 必须传到 fetch_usage")
        self.assertEqual(env["status"], "ok")

    def test_report_script_passes_timeout_to_probe(self):
        """两个源共用同一句探针调用，--timeout 必须在里面（codex/claude 一视同仁）。"""
        with open(os.path.join(HERE, "report-quota.sh"), "r", encoding="utf-8") as f:
            body = f.read()
        invoke = [ln for ln in body.splitlines()
                  if 'PROBE_JSON="$("$PY" "$PROBE_SCRIPT"' in ln]
        self.assertEqual(len(invoke), 1, f"没找到探针调用行:\n{body}")
        self.assertIn("--timeout", invoke[0], "探针调用漏传 --timeout")
        # 两个源都要落到这句上，不许某一路自己另起炉灶
        for src in ("probe_codex.py", "probe_claude.py"):
            self.assertIn(src, body)


class TestClaudeAccountFingerprint(unittest.TestCase):
    """额度是**账号级**不是机器级（多机同账号 = 一个池子）。
    account_id 必须是账号身份，不能掺 hostname，否则云端按机器建索引就会超发。"""

    def test_account_id_is_account_scoped_not_host_scoped(self):
        env = probe_claude.parse_usage(load_fix("claude_usage.json"),
                                       account_id="claude-abc", host="some-laptop")
        self.assertEqual(env["account_id"], "claude-abc")
        # host 是旁路属性，绝不能混进账号标识
        self.assertNotIn("some-laptop", env["account_id"])
        self.assertEqual(env["host"], "some-laptop")

    def test_account_id_stable_across_hosts(self):
        """同一账号在两台机器上探针，account_id 必须一致（云端才能合成一个池子）。"""
        a = probe_claude.parse_usage(load_fix("claude_usage.json"),
                                     account_id="claude-abc", host="macbook")
        b = probe_claude.parse_usage(load_fix("claude_usage.json"),
                                     account_id="claude-abc", host="mini")
        self.assertEqual(a["account_id"], b["account_id"])
        self.assertNotEqual(a["host"], b["host"])


class TestUnavailableNoCrash(unittest.TestCase):
    def test_claude_no_token_unavailable(self):
        """③ claude 凭证缺失 → unavailable，不抛异常，带非敏感诊断。"""
        orig = probe_claude.get_token
        probe_claude.get_token = lambda: (None, None,
                                          ["keychain[.../aster]: 顶层keys=['mcpOAuth']，无 claudeAiOauth.accessToken"])
        try:
            env = probe_claude.probe()  # 不得抛
        finally:
            probe_claude.get_token = orig
        self.assertEqual(env["status"], "unavailable")
        self.assertEqual(env["source"], "claude")
        self.assertIn("reason", env)
        self.assertIn("diagnostic", env["extra"])
        # 诊断里不得含任何疑似 token 明文（这里只断言是布局描述）
        self.assertTrue(all("accessToken" not in d or "无" in d or "顶层keys" in d
                            for d in env["extra"]["diagnostic"]))

    def test_codex_bad_bin_unavailable(self):
        """③ codex 二进制不存在且无兜底 → unavailable，不抛异常。"""
        orig = probe_codex.latest_rollout_snapshot
        probe_codex.latest_rollout_snapshot = lambda: (None, None)
        try:
            env = probe_codex.probe(codex_bin="/nonexistent/codex-xyz", timeout=5)
        finally:
            probe_codex.latest_rollout_snapshot = orig
        self.assertEqual(env["status"], "unavailable")
        self.assertEqual(env["source"], "codex")
        self.assertIn("reason", env)


class TestSchemaConsistency(unittest.TestCase):
    def test_both_envelopes_same_top_keys(self):
        """两源 ok envelope 顶层 schema 一致。"""
        cx = probe_codex.parse_rate_limits(load_fix("codex_appserver_ratelimits.json"))
        cl = probe_claude.parse_usage(load_fix("claude_usage.json"))
        base = {"schema_version", "source", "host", "account_id", "probed_at",
                "status", "plan_type", "limits"}
        self.assertTrue(base.issubset(set(cx.keys())))
        self.assertTrue(base.issubset(set(cl.keys())))
        # limits 条目字段一致
        lk = {"kind", "bucket", "model", "used_percent", "window_minutes", "resets_at"}
        for env in (cx, cl):
            for lim in env["limits"]:
                self.assertEqual(set(lim.keys()), lk)


class TestReportSurvivesUnavailableProbe(unittest.TestCase):
    """report-quota.sh 有 `set -euo pipefail`，而探针在 status=unavailable 时**按设计**
    返回退出码 1（main 的 `return 0 if ok else 1`）。于是命令替换一失败，整个脚本当场
    静默死掉——一个字都不输出，本该上报的 unavailable 快照凭空蒸发。

    这不是假想：本机此刻 keychain 里 claudeAiOauth 已不在，claude 探针就是 unavailable，
    `bash report-quota.sh --source claude --dry-run` 退出码 1、零输出。

    「探针不可用」是**正常业务结果**，必须照样上报（云端才知道这台机没凭证）；
    只有「探针没吐出可解析的信封」才算真失败。
    """

    ENVELOPE = ('{"schema_version":"1","source":"%s","host":"testhost",'
                '"account_id":"%s-fp","probed_at":"2026-08-27T10:00:00+08:00",'
                '"status":"unavailable","plan_type":null,"limits":[],'
                '"reason":"未找到凭证"}')

    def _stage(self, tmp, source, body, exit_code):
        """把真脚本原样搬进临时目录，旁边放假探针——SCRIPT_DIR 就会指向假的，
        而 $PY 仍是真 python3（脚本还要用它组装 body）。不给生产代码加测试钩子。"""
        shutil.copy(os.path.join(HERE, "report-quota.sh"), os.path.join(tmp, "report-quota.sh"))
        fake = os.path.join(tmp, f"probe_{source}.py")
        with open(fake, "w", encoding="utf-8") as f:
            f.write("import sys\n")
            f.write(f"sys.stdout.write({body!r})\n")
            f.write(f"sys.exit({exit_code})\n")
        return os.path.join(tmp, "report-quota.sh")

    def _run(self, script, source):
        # stdin 给 DEVNULL：脚本的 --input - 分支会 cat stdin，继承测试进程的 tty
        # 会让失败路径挂死而不是报错（第一版就是这么超时的）。
        return subprocess.run(
            ["bash", script, "--source", source, "--dry-run"],
            capture_output=True, text=True, timeout=60,
            stdin=subprocess.DEVNULL,
            env={**os.environ, "PYTHON": sys.executable},
        )

    def _body_of(self, out):
        return TestReportDryRun._extract_body(out)

    def test_claude_unavailable_still_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = self._stage(tmp, "claude", self.ENVELOPE % ("claude", "claude"), 1)
            proc = self._run(script, "claude")
            self.assertEqual(proc.returncode, 0,
                             f"探针 unavailable 不该让脚本静默死\nstderr={proc.stderr}")
            self.assertIn("DRY-RUN", proc.stdout)
            body = self._body_of(proc.stdout)
            self.assertIsNotNone(body, f"body 丢了:\n{proc.stdout}")
            inner = json.loads(body["message"])
            self.assertEqual(inner["status"], "unavailable")
            self.assertEqual(inner["source"], "claude")

    def test_codex_unavailable_still_reported(self):
        """codex 分支同病同治。"""
        with tempfile.TemporaryDirectory() as tmp:
            script = self._stage(tmp, "codex", self.ENVELOPE % ("codex", "chatgpt"), 1)
            proc = self._run(script, "codex")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            inner = json.loads(self._body_of(proc.stdout)["message"])
            self.assertEqual(inner["status"], "unavailable")
            self.assertEqual(inner["source"], "codex")

    def test_probe_ok_still_works(self):
        """退出码 0 的正常路径不许被这次修复带坏。"""
        ok = ('{"schema_version":"1","source":"claude","host":"h","account_id":"a",'
              '"probed_at":"2026-08-27T10:00:00+08:00","status":"ok","plan_type":null,'
              '"limits":[{"kind":"5h","bucket":"session","model":null,"used_percent":23,'
              '"window_minutes":300,"resets_at":"2026-08-27T18:00:00+08:00"}]}')
        with tempfile.TemporaryDirectory() as tmp:
            script = self._stage(tmp, "claude", ok, 0)
            proc = self._run(script, "claude")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            inner = json.loads(self._body_of(proc.stdout)["message"])
            self.assertEqual(inner["status"], "ok")
            self.assertEqual(inner["limits"][0]["used_percent"], 23)

    def test_garbage_probe_fails_loudly(self):
        """探针吐不出可解析信封 = 真故障，必须响亮失败，不许把空 body 发出去。"""
        with tempfile.TemporaryDirectory() as tmp:
            script = self._stage(tmp, "claude", "", 1)
            proc = self._run(script, "claude")
            self.assertNotEqual(proc.returncode, 0, "空输出必须报错，不能当正常上报")
            self.assertNotIn("DRY-RUN", proc.stdout)

    def test_non_json_probe_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = self._stage(tmp, "claude", "Traceback (most recent call last): boom", 1)
            proc = self._run(script, "claude")
            self.assertNotEqual(proc.returncode, 0, "非 JSON 输出必须报错")


class TestReportDryRun(unittest.TestCase):
    def test_dry_run_body_structure(self):
        """④ report-quota.sh --dry-run 输出的 mesh send body 结构正确。"""
        probe_json = json.dumps({
            "schema_version": "1", "source": "codex", "status": "ok",
            "account_id": "chatgpt-testfp", "limits": [
                {"kind": "5h", "used_percent": 42, "window_minutes": 300,
                 "resets_at": "2026-08-26T20:00:00+08:00", "bucket": "codex_bengalfox",
                 "model": "GPT-5.3-Codex-Spark"}]
        }, ensure_ascii=False)

        script = os.path.join(HERE, "report-quota.sh")
        proc = subprocess.run(
            ["bash", script, "--input", "-", "--dry-run",
             "--from", "computer2-quota", "--to", "main-brain"],
            input=probe_json, capture_output=True, text=True, timeout=30,
            env={**os.environ, "PYTHON": "python3"},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = proc.stdout
        self.assertIn("DRY-RUN", out)
        self.assertIn("POST http://localhost:19800/api/send", out)

        # 抽出 --- body --- 与 --- 等价 curl --- 之间的 JSON 块并解析
        body = self._extract_body(out)
        self.assertIsNotNone(body, f"未能从输出抽出 body:\n{out}")
        # relay POST /api/send 只认 {to, message, type?}；发送方走 X-Mesh-Node 头。
        # 早先这里断言的是 {from, content}，relay 会 400
        # "missing required fields: to, message"（2026-08-26 测试设备实测踩到）。
        self.assertEqual(body["to"], "main-brain")
        self.assertEqual(body["type"], "quota_report")
        self.assertNotIn("from", body, "from 必须走请求头，不进 body")
        self.assertNotIn("content", body, "正文字段名是 message，不是 content")
        self.assertIn("X-Mesh-Node: computer2-quota", out, "等价 curl 要带发送方请求头")
        # message 是探针 JSON 的字符串，能反解回来
        inner = json.loads(body["message"])
        self.assertEqual(inner["source"], "codex")
        self.assertEqual(inner["limits"][0]["model"], "GPT-5.3-Codex-Spark")

    @staticmethod
    def _extract_body(out):
        lines = out.splitlines()
        try:
            start = lines.index("--- body ---") + 1
        except ValueError:
            return None
        buf = []
        for line in lines[start:]:
            if line.startswith("--- ") or line.strip() == "":
                if buf:
                    break
                continue
            buf.append(line)
        try:
            return json.loads("\n".join(buf))
        except json.JSONDecodeError:
            return None


if __name__ == "__main__":
    unittest.main(verbosity=2)
