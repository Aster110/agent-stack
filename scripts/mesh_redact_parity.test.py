#!/usr/bin/env python3
"""
脱敏规则**同源检查**。

为什么要有：`scripts/mesh_redact.py` 的规则段是从 `scripts/mesh-seat-forensics.sh`
的 emit() heredoc 里逐字抽出来的。两处各留一份，就一定会漂 ——
某天有人给席位取证补了一条新规则，relay 取证这边没补，
而**"漏"的那一边不会报错，只会安静地把密钥写进日志**。

所以这里逐字比对两边的规则源码。谁改了另一边没跟，立刻红。

它不测"脱敏正确"（那是 mesh_redact.behaviour.test.py 的事），只测"两边是同一套"。
"""
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
FORENSICS_SH = HERE / "mesh-seat-forensics.sh"
REDACT_PY = HERE / "mesh_redact.py"

START_MARK = "ANSI = re.compile("
END_MARK = "return out, hits"


def extract_rules_block(path: pathlib.Path) -> str:
    """切出从 ANSI 定义到 redact() 结尾的整段规则源码。"""
    src = path.read_text(encoding="utf-8")
    if START_MARK not in src:
        raise AssertionError(
            f"{path.name} 里找不到规则段起点 {START_MARK!r} —— "
            "文件结构变了，请同步修本测试的标记，别让同源检查静默失效。"
        )
    start = src.index(START_MARK)
    if END_MARK not in src[start:]:
        raise AssertionError(f"{path.name} 里找不到规则段终点 {END_MARK!r}")
    end = start + src[start:].index(END_MARK) + len(END_MARK)
    return src[start:end]


class RuleParity(unittest.TestCase):
    def test_两份规则逐字一致(self):
        a = extract_rules_block(FORENSICS_SH)
        b = extract_rules_block(REDACT_PY)
        if a != b:
            import difflib

            diff = "\n".join(
                difflib.unified_diff(
                    a.splitlines(), b.splitlines(),
                    fromfile="mesh-seat-forensics.sh", tofile="mesh_redact.py", lineterm="",
                )
            )
            self.fail(
                "🔴 两处脱敏规则已经漂了。漏的那一边不会报错，只会安静地把密钥写进日志。\n"
                "把改动同步到两边（或把 forensics 改成直接 import mesh_redact）后再跑。\n" + diff
            )

    def test_规则段不是空的(self):
        # 防呆：万一 extract 逻辑退化成返回空串，上面那条会「两个空串相等」而假绿。
        block = extract_rules_block(REDACT_PY)
        self.assertGreater(len(block), 1500, "规则段短得不正常，extract 逻辑可能坏了")
        self.assertIn("REDACTED:pem", block)
        self.assertIn("REDACTED:jwt", block)
        self.assertIn("REDACTED:assign", block)


class RedactBehaviour(unittest.TestCase):
    """抽取动作本身没改变行为 —— 拿一组已知敏感样本过一遍。"""

    def setUp(self):
        sys.path.insert(0, str(HERE))
        from mesh_redact import redact  # noqa: PLC0415

        self.redact = redact

    def test_各类密钥都被剔掉(self):
        cases = [
            ("Authorization: Bearer abcdefgh12345678", "REDACTED:auth"),
            ("sk-ant-api03-AAAAAAAABBBBBBBBCCCCCCCC", "REDACTED:key"),
            ("ghp_0123456789abcdef0123456789abcdef", "REDACTED:key"),
            ("eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM", "REDACTED:jwt"),
            ("https://user:hunter2@example.com/x", "REDACTED:urlcred"),
            ("ANTHROPIC_API_KEY=zzzzzzzzzzzzzzzz", "REDACTED:assign"),
            ("联系 someone@example.com 处理", "REDACTED:email"),
            ("sha 0123456789abcdef0123456789abcdef", "REDACTED:hex"),
            ("手机 13800138000", "REDACTED:num"),
        ]
        for raw, marker in cases:
            with self.subTest(raw=raw[:30]):
                out, hits = self.redact(raw)
                self.assertIn(marker, out, f"{raw[:40]!r} 没被剔干净：{out!r}")
                self.assertGreater(hits, 0)

    def test_原文里的敏感值不再出现(self):
        # 只看有没有 [REDACTED:*] 标记是不够的——标记出现了、原值也还在，那等于没脱。
        raw = "token=SUPERSECRETVALUE123456 邮箱 a@b.com"
        out, _ = self.redact(raw)
        self.assertNotIn("SUPERSECRETVALUE123456", out)
        self.assertNotIn("a@b.com", out)

    def test_正常路径不被误伤(self):
        # 过度脱敏会把取证价值也一起剔掉，所以两个方向都要盯。
        raw = "/Users/example/AIproject/cc-mesh/packages/relay/dist/index.js exit_code=1"
        out, hits = self.redact(raw)
        self.assertIn("packages/relay/dist/index.js", out)
        self.assertEqual(hits, 0, f"正常路径被误剔了：{out!r}")

    def test_ansi_与控制字符被清掉(self):
        out, _ = self.redact("\x1b[31m红字\x1b[0m\x07")
        self.assertNotIn("\x1b", out)
        self.assertNotIn("\x07", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
