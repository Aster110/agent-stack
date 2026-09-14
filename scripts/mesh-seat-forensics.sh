#!/usr/bin/env bash
# mesh-seat-forensics.sh — 席位死亡取证（seat death forensics）
#
# 为什么存在：computer2 的 codex-main 席位在 45 分钟里死了三次，每次都是 tmux 会话消失、
# 进程不存在、relay 注册记录变僵尸，**零线索**。不做取证就重建，第四代大概率还是死。
#
# 子命令
#   birth  ...   席位起来时留出生档（记 pid 链与起始时间，死时才算得出寿命）
#   death  ...   席位退出时留死亡档（退出码/信号/进程链/系统资源/pane 尾部）
#   reap   ...   守尸人：盯 wrapper pid，pid 没了但 trap 没写过档 → 补一条
#                （SIGKILL / tmux kill-server 这类**trap 根本不会跑**的死法，只有它抓得到）
#
# 🔴 隐私红线（比取证价值优先）
#   - 只取 pane **尾部有限行**，且**先脱敏再落盘**
#   - 进程链只记 comm（可执行名），**绝不记完整命令行**——argv 里可能有任务正文/密钥
#   - 落盘一律 600，超阈值轮转，代数封顶
#   宁可多剔不可漏：脱敏规则见下方 redact()，命中数写进 redaction_hits 可审计。
#
# 🟢 可靠性红线：取证是尽力而为的旁路，**任何情况下都 exit 0**，绝不把 wrapper 拖下水。
#
# 环境变量
#   MESH_FORENSICS=0                  全局关停（一个字节都不落）
#   MESH_FORENSICS_LOG                默认 ~/.ccmesh/seat-deaths.log
#   MESH_FORENSICS_STATE_DIR          默认 ~/.ccmesh/seat-forensics
#   MESH_FORENSICS_PANE_LINES         pane 尾部行数，默认 40；0 = 完全不采
#   MESH_FORENSICS_PANE_LINE_CHARS    单行截断长度，默认 200
#   MESH_FORENSICS_MAX_BYTES          轮转阈值，默认 1048576（1MiB）
#   MESH_FORENSICS_KEEP               保留代数，默认 3（.1/.2/.3）
#   MESH_FORENSICS_REAP_INTERVAL_S    守尸人轮询间隔，默认 5
#   MESH_FORENSICS_REAP_GRACE_S       pid 消失后等 trap 落档的宽限，默认 3
#   MESH_FORENSICS_REAP_TTL_S         守尸人自杀 TTL，默认 86400

# 故意不用 set -e：取证任何一步失败都不许中断，更不许把调用方（wrapper）带崩。
set -u

SUBCMD="${1:-}"
[ $# -gt 0 ] && shift

EVENT=""
SESSION=""
NODE_ID=""
SHORT_ID=""
ROLE=""
LAUNCHER=""
DESC=""
PROJECT_DIR=""
PID=""
EXIT_CODE=""
SIGNAL=""
DEATH_KIND=""

while [ $# -gt 0 ]; do
  case "$1" in
    --session)     SESSION="${2:-}"; shift 2 || break ;;
    --node-id)     NODE_ID="${2:-}"; shift 2 || break ;;
    --short-id)    SHORT_ID="${2:-}"; shift 2 || break ;;
    --role)        ROLE="${2:-}"; shift 2 || break ;;
    --launcher)    LAUNCHER="${2:-}"; shift 2 || break ;;
    --desc)        DESC="${2:-}"; shift 2 || break ;;
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 || break ;;
    --pid)         PID="${2:-}"; shift 2 || break ;;
    --exit-code)   EXIT_CODE="${2:-}"; shift 2 || break ;;
    --signal)      SIGNAL="${2:-}"; shift 2 || break ;;
    --death-kind)  DEATH_KIND="${2:-}"; shift 2 || break ;;
    *)             shift ;;
  esac
done

[ "${MESH_FORENSICS:-1}" = "0" ] && exit 0

LOG_PATH="${MESH_FORENSICS_LOG:-$HOME/.ccmesh/seat-deaths.log}"
STATE_DIR="${MESH_FORENSICS_STATE_DIR:-$HOME/.ccmesh/seat-forensics}"
PANE_LINES="${MESH_FORENSICS_PANE_LINES:-40}"

# state key：优先 session；session 缺失（注册就失败的席位也要留档）退回 pid
state_key() {
  local k="${SESSION:-}"
  [ -z "$k" ] && k="pid${PID:-0}"
  printf '%s' "$k" | tr -c 'A-Za-z0-9._-' '_'
}
KEY="$(state_key)"
MARKER="$STATE_DIR/$KEY.reaped"

# ---------------------------------------------------------------------------
# pane 尾部：tmux capture-pane。取原始文本落临时文件，脱敏在 python 里做。
# 超时 3s 兜底——tmux server 半死时 capture-pane 会挂住，挂住就等于取证吃掉 wrapper 退出。
# ---------------------------------------------------------------------------
PANE_FILE=""
capture_pane() {
  [ "${PANE_LINES:-0}" = "0" ] && return 0
  [ -z "$SESSION" ] && return 0
  [ "$SESSION" = "unknown" ] && return 0
  command -v tmux >/dev/null 2>&1 || return 0
  PANE_FILE="$(mktemp "${TMPDIR:-/tmp}/mesh-pane.XXXXXX" 2>/dev/null)" || { PANE_FILE=""; return 0; }
  chmod 600 "$PANE_FILE" 2>/dev/null
  # 多抓一倍历史行，尾部裁剪交给 python（tmux -S 的行数语义各版本不完全一致）
  local back=$(( PANE_LINES * 2 ))
  (
    tmux capture-pane -p -t "$SESSION" -S "-$back" > "$PANE_FILE" 2>/dev/null
  ) &
  local cpid=$!
  local waited=0
  while kill -0 "$cpid" 2>/dev/null; do
    [ "$waited" -ge 30 ] && { kill -9 "$cpid" 2>/dev/null; break; }
    sleep 0.1
    waited=$(( waited + 1 ))
  done
  wait "$cpid" 2>/dev/null
  return 0
}

TMUX_SESSION_ALIVE="unknown"
TMUX_SERVER_ALIVE="unknown"
probe_tmux() {
  command -v tmux >/dev/null 2>&1 || return 0
  if tmux list-sessions >/dev/null 2>&1; then TMUX_SERVER_ALIVE="true"; else TMUX_SERVER_ALIVE="false"; fi
  if [ -n "$SESSION" ] && [ "$SESSION" != "unknown" ]; then
    if tmux has-session -t "$SESSION" >/dev/null 2>&1; then TMUX_SESSION_ALIVE="true"; else TMUX_SESSION_ALIVE="false"; fi
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 记录组装 + 脱敏 + 轮转 + 追加（全在 python 里，正则可读、可测、可变异）
# ---------------------------------------------------------------------------
emit() {
  python3 - <<'PY' 2>/dev/null
import json, os, re, socket, subprocess, sys, time

# ---- 配置 ------------------------------------------------------------------
def envi(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except Exception:
        return default

LOG        = os.environ.get("FX_LOG") or ""
STATE_DIR  = os.environ.get("FX_STATE_DIR") or ""
PANE_LINES = envi("MESH_FORENSICS_PANE_LINES", 40)
LINE_CHARS = envi("MESH_FORENSICS_PANE_LINE_CHARS", 200)
MAX_BYTES  = envi("MESH_FORENSICS_MAX_BYTES", 1048576)
KEEP       = envi("MESH_FORENSICS_KEEP", 3)

def env(name):
    v = os.environ.get(name, "")
    return v if v != "" else None

# ---- 脱敏 ------------------------------------------------------------------
# 口径：宁可多剔不可漏。pane 尾部是最危险的地方——任务正文、密钥、账号都可能在那。
# 顺序有讲究：先打最具体的（header / 已知前缀 / 赋值），再打泛化启发式，
# 最后才是长数字串。替换文本本身不含 24 字符以上 token 串，不会被后续规则二次啃。
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

# ---- 进程链 ----------------------------------------------------------------
def run(cmd, timeout=3):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""

def ps_one(pid):
    # 只取 comm（可执行名），**绝不取 command/args**——argv 里可能有任务正文和密钥
    out = run(["ps", "-o", "pid=,ppid=,stat=,comm=", "-p", str(pid)])
    line = out.strip().splitlines()
    if not line:
        return None
    parts = line[0].split(None, 3)
    if len(parts) < 3:
        return None
    comm = parts[3] if len(parts) > 3 else ""
    comm = os.path.basename(comm.strip()) or comm.strip()
    comm, _ = redact(comm)
    try:
        return {"pid": int(parts[0]), "ppid": int(parts[1]), "state": parts[2], "comm": comm}
    except Exception:
        return None

def proc_chain(pid):
    chain, seen = [], set()
    try:
        cur = int(pid)
    except Exception:
        return chain
    for _ in range(12):
        if cur <= 0 or cur in seen:
            break
        seen.add(cur)
        info = ps_one(cur)
        if not info:
            break
        chain.append(info)
        cur = info["ppid"]
        if cur <= 1:
            if cur == 1:
                info1 = ps_one(1)
                if info1:
                    chain.append(info1)
            break
    return chain

def children_of(pid):
    out = run(["pgrep", "-P", str(pid)])
    kids = []
    for tok in out.split():
        info = ps_one(tok)
        if info:
            kids.append(info)
    return kids

# ---- 系统资源摘要 ----------------------------------------------------------
def system_summary():
    s = {"load": None, "mem_total_mb": None, "mem_free_mb": None, "mem_free_pct": None,
         "swap_used_mb": None, "proc_count": None, "disk_free_mb": None, "uptime_raw": None}
    try:
        la = os.getloadavg()
        s["load"] = [round(x, 2) for x in la]
    except Exception:
        pass
    # 内存：先试 macOS，再退 Linux
    try:
        total = int(run(["sysctl", "-n", "hw.memsize"]).strip() or 0)
        if total:
            s["mem_total_mb"] = total // (1024 * 1024)
            vm = run(["vm_stat"])
            m = re.search(r"page size of (\d+)", vm)
            page = int(m.group(1)) if m else 4096
            def pages(label):
                mm = re.search(r"Pages %s:\s+(\d+)" % label, vm)
                return int(mm.group(1)) if mm else 0
            free_pages = pages("free") + pages("inactive") + pages("speculative")
            s["mem_free_mb"] = (free_pages * page) // (1024 * 1024)
    except Exception:
        pass
    if s["mem_total_mb"] is None:
        try:
            mi = open("/proc/meminfo", encoding="utf-8").read()
            def kb(label):
                mm = re.search(r"^%s:\s+(\d+) kB" % label, mi, re.M)
                return int(mm.group(1)) if mm else 0
            s["mem_total_mb"] = kb("MemTotal") // 1024
            s["mem_free_mb"] = (kb("MemAvailable") or kb("MemFree")) // 1024
            st, sf = kb("SwapTotal"), kb("SwapFree")
            s["swap_used_mb"] = (st - sf) // 1024
        except Exception:
            pass
    else:
        try:
            sw = run(["sysctl", "-n", "vm.swapusage"])
            mm = re.search(r"used\s*=\s*([\d.]+)M", sw)
            if mm:
                s["swap_used_mb"] = round(float(mm.group(1)))
        except Exception:
            pass
    try:
        if s["mem_total_mb"] and s["mem_free_mb"] is not None:
            s["mem_free_pct"] = round(100.0 * s["mem_free_mb"] / s["mem_total_mb"], 1)
    except Exception:
        pass
    try:
        s["proc_count"] = len([l for l in run(["ps", "-A", "-o", "pid="]).splitlines() if l.strip()])
    except Exception:
        pass
    try:
        st = os.statvfs(os.path.expanduser("~"))
        s["disk_free_mb"] = (st.f_bavail * st.f_frsize) // (1024 * 1024)
    except Exception:
        pass
    try:
        s["uptime_raw"] = run(["uptime"]).strip()[:200] or None
    except Exception:
        pass
    return s

# ---- 退出码 → 信号 ---------------------------------------------------------
def signal_of(code, explicit):
    if explicit:
        return explicit.replace("SIG", ""), True
    if code is None:
        return None, False
    if 128 < code < 160:
        try:
            import signal as sg
            return sg.Signals(code - 128).name.replace("SIG", ""), True
        except Exception:
            return "SIG%d" % (code - 128), True
    return None, False

# ---- 轮转 + 追加 -----------------------------------------------------------
def rotate(path):
    try:
        if MAX_BYTES <= 0 or KEEP <= 0 or not os.path.exists(path):
            return
        if os.path.getsize(path) < MAX_BYTES:
            return
        oldest = "%s.%d" % (path, KEEP)
        if os.path.exists(oldest):
            os.remove(oldest)
        for i in range(KEEP - 1, 0, -1):
            src, dst = "%s.%d" % (path, i), "%s.%d" % (path, i + 1)
            if os.path.exists(src):
                os.replace(src, dst)
                os.chmod(dst, 0o600)
        os.replace(path, "%s.1" % path)
        os.chmod("%s.1" % path, 0o600)
    except Exception:
        pass

def append(path, rec):
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, mode=0o700, exist_ok=True)
        rotate(path)
        old = os.umask(0o077)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        finally:
            os.umask(old)
        os.chmod(path, 0o600)   # 有人手动改宽过也纠回来
    except Exception:
        pass

# ---- 组装 ------------------------------------------------------------------
event      = os.environ.get("FX_EVENT", "death")
session    = env("FX_SESSION")
node_id    = env("FX_NODE_ID")
short_id   = env("FX_SHORT_ID")
role       = env("FX_ROLE")
launcher   = env("FX_LAUNCHER")
desc       = env("FX_DESC")
project    = env("FX_PROJECT_DIR")
death_kind = env("FX_DEATH_KIND")
key        = os.environ.get("FX_KEY", "") or "unknown"

try:
    pid = int(os.environ.get("FX_PID", "") or 0) or None
except Exception:
    pid = None
try:
    code = int(os.environ.get("FX_EXIT_CODE", "").strip())
except Exception:
    code = None

sig, by_sig = signal_of(code, env("FX_SIGNAL"))

pane, pane_hits = [], 0
pane_file = os.environ.get("FX_PANE_FILE", "")
if PANE_LINES > 0 and pane_file and os.path.exists(pane_file):
    try:
        raw = open(pane_file, encoding="utf-8", errors="replace").read()
        clean, pane_hits = redact(raw)
        lines = [l.rstrip() for l in clean.splitlines()]
        while lines and not lines[-1].strip():
            lines.pop()
        pane = [l[:LINE_CHARS] for l in lines[-PANE_LINES:]]
    except Exception:
        pane = []

desc_red, d_hits = redact(desc or "")
hits = pane_hits + d_hits

started_at = None
state_path = os.path.join(STATE_DIR, key + ".json") if STATE_DIR else ""
if event == "death" and state_path and os.path.exists(state_path):
    try:
        started_at = json.load(open(state_path, encoding="utf-8")).get("started_at")
    except Exception:
        pass

now = time.time()
rec = {
    "schema": "seat-death/1",
    "event": event,
    "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)) + time.strftime("%z"),
    "ts_epoch": round(now, 3),
    "host": socket.gethostname(),
    "session": session,
    "node_id": node_id,
    "short_id": short_id,
    "role": role,
    "launcher": launcher,
    "description": desc_red or None,
    "project_dir": project,
    "wrapper_pid": pid,
    "exit_code": code,
    "signal": sig,
    "killed_by_signal": bool(by_sig),
    "death_kind": death_kind or ("trapped" if event == "death" else None),
    "started_at": started_at,
    "uptime_s": round(now - started_at, 3) if started_at else None,
    "tmux": {
        "session_alive": os.environ.get("FX_TMUX_SESSION_ALIVE") or "unknown",
        "server_alive": os.environ.get("FX_TMUX_SERVER_ALIVE") or "unknown",
    },
    "proc_chain": proc_chain(pid) if pid else [],
    "children": children_of(pid) if pid else [],
    "system": system_summary(),
    "pane_tail": pane,
    "pane_tail_lines": len(pane),
    "redacted": True,
    "redaction_hits": hits,
}

if event == "birth" and state_path:
    try:
        os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
        old = os.umask(0o077)
        try:
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump({"started_at": round(now, 3), "session": session, "node_id": node_id,
                           "short_id": short_id, "pid": pid, "launcher": launcher}, f,
                          ensure_ascii=False)
        finally:
            os.umask(old)
        os.chmod(state_path, 0o600)
    except Exception:
        pass

if LOG:
    append(LOG, rec)
PY
  return 0
}

write_marker() {
  [ -z "$STATE_DIR" ] && return 0
  mkdir -p "$STATE_DIR" 2>/dev/null
  chmod 700 "$STATE_DIR" 2>/dev/null
  : > "$MARKER" 2>/dev/null
  chmod 600 "$MARKER" 2>/dev/null
  return 0
}

record() {
  EVENT="$1"
  probe_tmux
  capture_pane
  FX_EVENT="$EVENT" \
  FX_SESSION="$SESSION" FX_NODE_ID="$NODE_ID" FX_SHORT_ID="$SHORT_ID" \
  FX_ROLE="$ROLE" FX_LAUNCHER="$LAUNCHER" FX_DESC="$DESC" FX_PROJECT_DIR="$PROJECT_DIR" \
  FX_PID="$PID" FX_EXIT_CODE="$EXIT_CODE" FX_SIGNAL="$SIGNAL" FX_DEATH_KIND="$DEATH_KIND" \
  FX_KEY="$KEY" FX_PANE_FILE="${PANE_FILE:-}" FX_LOG="$LOG_PATH" FX_STATE_DIR="$STATE_DIR" \
  FX_TMUX_SESSION_ALIVE="$TMUX_SESSION_ALIVE" FX_TMUX_SERVER_ALIVE="$TMUX_SERVER_ALIVE" \
    emit
  [ -n "${PANE_FILE:-}" ] && rm -f "$PANE_FILE" 2>/dev/null
  return 0
}

case "$SUBCMD" in
  birth)
    rm -f "$MARKER" 2>/dev/null      # 清掉上一代的残标，免得守尸人误认
    record birth
    ;;

  death)
    write_marker                      # 先立标：告诉守尸人 trap 跑过了，别重复补档
    record death
    ;;

  reap)
    # 守尸人：SIGKILL / tmux kill-server 这类死法 trap 根本不会跑，只有它能留下线索。
    # 必须被 nohup 起（忽略 SIGHUP），否则 pane 一没它自己也跟着走。
    INTERVAL="${MESH_FORENSICS_REAP_INTERVAL_S:-5}"
    GRACE="${MESH_FORENSICS_REAP_GRACE_S:-3}"
    TTL="${MESH_FORENSICS_REAP_TTL_S:-86400}"
    [ -z "$PID" ] && exit 0
    rm -f "$MARKER" 2>/dev/null
    START="$(date +%s)"
    while kill -0 "$PID" 2>/dev/null; do
      sleep "$INTERVAL"
      NOW="$(date +%s)"
      [ $(( NOW - START )) -ge "$TTL" ] && exit 0
    done
    sleep "$GRACE"                    # 给 trap 一点落档时间
    [ -f "$MARKER" ] && exit 0        # trap 已经写过 → 不重复
    DEATH_KIND="untrapped"
    [ -z "$EXIT_CODE" ] && EXIT_CODE="-1"
    write_marker
    record death
    ;;

  *)
    # 未知子命令也 exit 0：取证是旁路，绝不成为调用方的失败源
    :
    ;;
esac

exit 0
