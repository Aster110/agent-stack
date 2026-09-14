#!/usr/bin/env python3
"""
mesh_redact.py —— 落盘前脱敏的**唯一收口点**。

这份规则原本内嵌在 scripts/mesh-seat-forensics.sh 的 emit() heredoc 里。
relay 取证（P2）也要用同一套规则，于是抽出来独立成模块。

🔴 **不要在别处重写这些正则。** 复制一份 = 两边各自演化 = 某天一边补了新规则另一边没补，
   而"漏"的那一边不会报错，只会安静地把密钥写进日志。
   scripts/mesh_redact_parity.test.py 会逐字比对本文件与 mesh-seat-forensics.sh 里的规则段，
   任何一边改了另一边没跟，测试立刻红。

口径（沿用原注释）：宁可多剔不可漏。顺序有讲究：先打最具体的（header / 已知前缀 / 赋值），
再打泛化启发式，最后才是长数字串。替换文本本身不含 24 字符以上 token 串，不会被后续规则二次啃。

用法：
    库：  from mesh_redact import redact;  text, hits = redact(raw)
    CLI： cat raw | python3 mesh_redact.py        # 脱敏后文本走 stdout，命中数走 stderr
"""
import re
import sys

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

RULES = [
    # PEM 私钥：整行铲掉
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*", re.S), "[REDACTED:pem]"),
    # Authorization / Proxy-Authorization 头（含 Bearer / Basic / Token 前缀）
    (re.compile(r"(?i)\b((?:proxy-)?authorization)\s*[:=]\s*(?:bearer\s+|basic\s+|token\s+)?\S+"),
     r"\1: [REDACTED:auth]"),
    # 裸 Bearer / Basic 片段
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}"), r"\1 [REDACTED:auth]"),
    # 已知厂商 key 前缀
    (re.compile(
        r"\b(?:sk-ant-[A-Za-z0-9._\-]{8,}"
        r"|sk-[A-Za-z0-9._\-]{16,}"
        r"|gh[pousr]_[A-Za-z0-9]{16,}"
        r"|github_pat_[A-Za-z0-9_]{20,}"
        r"|xox[abprse]-[A-Za-z0-9-]{10,}"
        r"|xapp-[0-9]-[A-Za-z0-9-]{10,}"
        r"|A(?:KIA|SIA)[0-9A-Z]{16}"
        r"|AIza[0-9A-Za-z_\-]{20,}"
        r"|npm_[A-Za-z0-9]{20,}"
        r"|hf_[A-Za-z0-9]{20,}"
        r"|glpat-[A-Za-z0-9_\-]{16,})"), "[REDACTED:key]"),
    # JWT
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}"), "[REDACTED:jwt]"),
    # URL 内嵌口令  scheme://user:pass@host
    (re.compile(r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^\s/:@]+:[^\s/@]+@"), r"\1[REDACTED:urlcred]@"),
    # 具名赋值：key=value / key: value / key is value
    # 前缀用 (?<![A-Za-z0-9]) 而不是 \b —— \b 在 `ANTHROPIC_API_KEY` 这种下划线拼接里
    # 不成立（`_` 是单词字符），会让最常见的环境变量泄漏形态整个漏掉。
    (re.compile(
        r"(?i)(?<![A-Za-z0-9])(api[_\-]?key|apikey|access[_\-]?key|secret[a-z_\-]*|token[a-z_\-]*"
        r"|passwd|password|passphrase|private[_\-]?key|credentials?|auth[_\-]?token"
        r"|refresh[_\-]?token|session[_\-]?key|cookie|set-cookie)"
        r"(\s*[:=]\s*|\s+is\s+)"
        r"(\"[^\"]*\"|'[^']*'|\S+)"), r"\1\2[REDACTED:assign]"),
    # 邮箱
    (re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), "[REDACTED:email]"),
    # 长 hex（指纹 / hash / 十六进制密钥）
    (re.compile(r"\b[0-9a-fA-F]{32,}\b"), "[REDACTED:hex]"),
    # 经典 base64 块（含 / 与 +，但要求字母数字混排，免得吃掉纯字母路径）
    (re.compile(r"(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Za-z])"
                r"[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])"), "[REDACTED:b64]"),
    # 泛化长随机串：不含 / 与 .（保住文件路径的可读性，路径对取证有用）
    #   ≥32 字符一律剔；24-31 字符要求字母+数字混排才剔
    (re.compile(r"(?<![A-Za-z0-9_\-+=])[A-Za-z0-9_\-+=]{32,}(?![A-Za-z0-9_\-+=])"), "[REDACTED:rand]"),
    (re.compile(r"(?<![A-Za-z0-9_\-+=])(?=[A-Za-z0-9_\-+=]*[0-9])(?=[A-Za-z0-9_\-+=]*[A-Za-z])"
                r"[A-Za-z0-9_\-+=]{24,31}(?![A-Za-z0-9_\-+=])"), "[REDACTED:rand]"),
    # 长数字串（手机号 / 卡号 / 身份证片段）
    (re.compile(r"(?<!\d)\d{11,}(?!\d)"), "[REDACTED:num]"),
]

def redact(text):
    """返回 (脱敏后文本, 命中次数)。这是隐私红线的唯一收口点。"""
    if not text:
        return text, 0
    hits = 0
    out = ANSI.sub("", text)
    out = CTRL.sub(" ", out)
    for pat, repl in RULES:
        out, n = pat.subn(repl, out)
        hits += n
    return out, hits


def main() -> int:
    raw = sys.stdin.read()
    out, hits = redact(raw)
    sys.stdout.write(out)
    # 命中数走 stderr，免得污染被脱敏的正文（调用方常直接管道接走 stdout）
    sys.stderr.write("redaction_hits=%d\n" % hits)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
