#!/usr/bin/env bash
# wake-e2e-sampler.sh — 冷睡三证 + 零 turn 四证的外部采样器（架构定稿 §10.3 / §10.4 / §9）
#
# 干什么：每 60s 在**会话外部**采一次样，把「席位到底冷没冷」「空闲期有没有偷偷烧 turn」
# 留成可核对的流水。这是 X0/X1 实验的取证工具，不是运行时组件。
#
# 为什么必须外部采样：让席位自己报告"我睡着了"是自欺——报告这个动作本身就是一个 turn。
# 所以三证全部从进程/文件系统/只读 HTTP 取，采样器一个模型 API 都不碰。
#
# 用法:
#   wake-e2e-sampler.sh <nodeId> [--label X1-主线] [--interval 60] [--out FILE]
#
# 环境:
#   MESH_RELAY_URL     缺省 http://localhost:19800
#   MESH_WAKE_MAP      缺省 ~/.ccmesh/wake-map.json（读 cwd/sessionName 做判活）
#   MESH_TRANSCRIPT    席位 transcript jsonl 路径（给了才采 mtime/size 那一证）
#
# 输出：每行一条 JSON（jsonl），字段：
#   ts, iso, phase(hot|cold), pids, socks, lastSyncAt, parkedCount, status,
#   transcriptMtime, transcriptSize
#
# ⚠️ 只读纪律：采样一律走 /api/status。**绝不可**碰 /api/sync——
#    它入口即 registry.touchSync()，采样器一探测就把 lastSyncAt 刷新鲜，
#    ①把"冷"采成"热"（实验结论直接反过来）②压制之后 90s 内所有真 wake。
#    这是本文件最容易犯、后果最隐蔽的错误（架构定稿 §7.2）。
set -u

NODE_ID="${1:-}"
if [ -z "$NODE_ID" ]; then
  echo "usage: wake-e2e-sampler.sh <nodeId> [--label X] [--interval N] [--out FILE]" >&2
  exit 1
fi
shift

LABEL="sample"
INTERVAL=60
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label)    LABEL="${2:-sample}"; shift 2 ;;
    --interval) INTERVAL="${2:-60}"; shift 2 ;;
    --out)      OUT="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

RELAY_URL="${MESH_RELAY_URL:-http://localhost:19800}"
WAKE_MAP="${MESH_WAKE_MAP:-$HOME/.ccmesh/wake-map.json}"
SESSIONS_DIR="${MESH_SESSIONS_DIR:-$HOME/.claude/sessions}"
SOCKS_DIR="${MESH_SOCKS_DIR:-/tmp/cc-socks}"
TRANSCRIPT="${MESH_TRANSCRIPT:-}"

SAFE="$(printf '%s' "${NODE_ID##*:}" | tr -c 'A-Za-z0-9._-' '_')"
[ -z "$OUT" ] && OUT="$HOME/.ccmesh/e2e-${LABEL}-${SAFE}.jsonl"
mkdir -p "$(dirname "$OUT")" 2>/dev/null || true

CWD="$(node -e '
  const fs=require("fs"); const [,f,n]=process.argv
  try{const m=JSON.parse(fs.readFileSync(f,"utf8")); process.stdout.write(String((m[n]&&m[n].cwd)||""))}catch(e){}
' "$WAKE_MAP" "$NODE_ID" 2>/dev/null)"
SESSION_NAME="$(node -e '
  const fs=require("fs"); const [,f,n]=process.argv
  try{const m=JSON.parse(fs.readFileSync(f,"utf8")); process.stdout.write(String((m[n]&&m[n].sessionName)||""))}catch(e){}
' "$WAKE_MAP" "$NODE_ID" 2>/dev/null)"

echo "[sampler] node=$NODE_ID label=$LABEL interval=${INTERVAL}s out=$OUT" >&2
echo "[sampler] 判活匹配: cwd=${CWD:-<any>} name=${SESSION_NAME:-<any>}" >&2
[ -n "$TRANSCRIPT" ] && echo "[sampler] transcript=$TRANSCRIPT" >&2

sample_once() {
  # 证一：活引擎注册表里有没有匹配行（只登记活引擎）
  pids="$(node -e '
    const fs=require("fs"), path=require("path")
    const [,dir,cwd,name]=process.argv
    let out=[]
    try{
      for(const f of fs.readdirSync(dir).filter(x=>x.endsWith(".json"))){
        let j; try{ j=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8")) }catch(e){ continue }
        if(!j||!j.pid) continue
        if(cwd && j.cwd!==cwd) continue
        if(name && j.name!==name) continue
        out.push(j.pid)
      }
    }catch(e){}
    process.stdout.write(out.join(","))
  ' "$SESSIONS_DIR" "$CWD" "$SESSION_NAME" 2>/dev/null)"

  # 证二：总线 sock（只对活引擎存在）
  socks=""
  if [ -n "$pids" ]; then
    for p in $(printf '%s' "$pids" | tr ',' ' '); do
      [ -S "${SOCKS_DIR}/${p}.sock" ] && socks="${socks}${p},"
    done
  fi
  socks="${socks%,}"

  phase="cold"
  [ -n "$pids" ] && phase="hot"

  # 只读 presence（绝不碰 /api/sync）
  st="$(curl -sS --noproxy '*' -m 10 "${RELAY_URL}/api/status" 2>/dev/null | node -e '
    const [,nodeId]=process.argv
    let raw=""; process.stdin.on("data",d=>raw+=d)
    process.stdin.on("end",()=>{
      let j; try{ j=JSON.parse(raw) }catch(e){ process.stdout.write("||"); return }
      const n=((j&&j.data&&j.data.nodes)||[]).find(x=>x&&x.identity&&x.identity.nodeId===nodeId)
      if(!n){ process.stdout.write("||"); return }
      process.stdout.write([n.lastSyncAt||"", n.parkedCount==null?"":n.parkedCount, n.status||""].join("|"))
    })
  ' "$NODE_ID")"
  last_sync="$(printf '%s' "$st" | cut -d'|' -f1)"
  parked="$(printf '%s' "$st" | cut -d'|' -f2)"
  status="$(printf '%s' "$st" | cut -d'|' -f3)"

  # 证三：transcript jsonl 的 mtime/size（整个冷睡窗口零变化 = 真的没跑过 turn）
  tm=0; tsz=0
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    tm="$(stat -f %m "$TRANSCRIPT" 2>/dev/null || stat -c %Y "$TRANSCRIPT" 2>/dev/null || echo 0)"
    tsz="$(stat -f %z "$TRANSCRIPT" 2>/dev/null || stat -c %s "$TRANSCRIPT" 2>/dev/null || echo 0)"
  fi

  node -e '
    const [,ts,iso,phase,pids,socks,ls,pc,st,tm,tsz,node_,label]=process.argv
    process.stdout.write(JSON.stringify({
      ts:Number(ts), iso, label, node:node_, phase,
      pids, socks, lastSyncAt:ls||null,
      parkedCount:pc===""?null:Number(pc), status:st||null,
      transcriptMtime:Number(tm), transcriptSize:Number(tsz),
    })+"\n")
  ' "$(date +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$phase" "$pids" "$socks" \
    "$last_sync" "$parked" "$status" "$tm" "$tsz" "$NODE_ID" "$LABEL" >> "$OUT"

  echo "[sampler] $(date +%H:%M:%S) phase=$phase pids=${pids:-none} parked=${parked:-?} lastSync=${last_sync:-none}" >&2
}

trap 'echo "[sampler] 停止，样本在 $OUT" >&2; exit 0' INT TERM

while : ; do
  sample_once
  sleep "$INTERVAL"
done
