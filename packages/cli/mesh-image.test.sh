#!/usr/bin/env bash
# mesh send --image 红测：PNG-only；raw 上传；精确 JSON；失败保正文且不泄路径。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_SH="$SCRIPT_DIR/mesh.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CALLS="$TMP_DIR/calls.jsonl"
WECHAT_CALLS="$TMP_DIR/wechat.log"
PNG="$TMP_DIR/private test image.png"

python3 -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))' "$PNG"

cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
python3 - "$MESH_TEST_CALLS" "$@" <<'PY'
import json,sys
out,args=sys.argv[1],sys.argv[2:]
def after(*names):
    for i,a in enumerate(args[:-1]):
        if a in names: return args[i+1]
    return None
urls=[a for a in args if a.startswith("http://") or a.startswith("https://")]
with open(out,"a",encoding="utf-8") as f:
    f.write(json.dumps({"args":args,"url":urls[-1] if urls else None,"data":after("-d","--data","--data-raw"),"binary":after("--data-binary")},ensure_ascii=False)+"\n")
PY
case "$*" in
  *"/attachments"*)
    if [[ "${MESH_TEST_UPLOAD_FAIL:-0}" == 1 ]]; then
      printf 'mock upload failed\n' >&2
      exit 22
    fi
    printf '%s\n' '{"ok":true,"data":{"manifest":{"version":1,"id":"att-431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460","kind":"image","mime":"image/png","size":68,"sha256":"431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460","width":1,"height":1,"storageRef":"hub-blob:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460","createdAt":"2026-08-28T12:00:00.000Z","expiresAt":"2026-08-28T12:01:00.000Z"}}}'
    ;;
  *"/send"*) printf '%s\n' '{"ok":true,"data":{"msgId":"msg-test","status":"delivered"}}' ;;
  *) printf '%s\n' '{"ok":false,"error":"unexpected URL"}'; exit 1 ;;
esac
EOF
chmod +x "$TMP_DIR/curl"

cat > "$TMP_DIR/cc2wechat" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MESH_TEST_WECHAT_CALLS"
exit 99
EOF
chmod +x "$TMP_DIR/cc2wechat"

run_mesh() {
  env PATH="$TMP_DIR:$PATH" MESH_TEST_CALLS="$CALLS" MESH_TEST_WECHAT_CALLS="$WECHAT_CALLS" \
    MESH_RELAY_URL="http://relay.test" MESH_NODE="mini:cc-source" bash "$MESH_SH" "$@"
}

# 旧客户端无图 send：Bash + set -u 下空图片数组也必须成功；只发送精确旧 JSON。
: > "$CALLS"
run_mesh send "server:brain" "无图旧客户端" >/dev/null
python3 - "$CALLS" <<'PY'
import json,sys
calls=[json.loads(x) for x in open(sys.argv[1],encoding="utf-8")]
assert len(calls)==1,calls
assert calls[0]["url"]=="http://relay.test/api/send",calls[0]
assert calls[0]["data"]=='{"to":"server:brain","message":"无图旧客户端"}',calls[0]
assert calls[0]["binary"] is None,calls[0]
PY
echo "✓ 无图旧客户端空数组 + 精确 send JSON"

# 成功：精确两次调用；第一条 raw 文件上传；第二条 JSON 只有正文 + manifest。
: > "$CALLS"
run_mesh send "computer2:cc-target" "看图但正文也要到" --image "$PNG" >/dev/null
python3 - "$CALLS" "$PNG" <<'PY'
import json,sys
calls=[json.loads(x) for x in open(sys.argv[1],encoding="utf-8")]
assert len(calls)==2,calls
assert calls[0]["url"]=="http://relay.test/api/attachments",calls[0]
assert calls[0]["binary"] in ("@"+sys.argv[2],sys.argv[2]),calls[0]
assert calls[1]["url"]=="http://relay.test/api/send",calls[1]
doc=json.loads(calls[1]["data"])
assert set(doc)=={"to","message","attachments"},doc
assert doc["to"]=="computer2:cc-target" and doc["message"]=="看图但正文也要到",doc
assert len(doc["attachments"])==1 and doc["attachments"][0]["mime"]=="image/png",doc
wire=calls[1]["data"]
assert sys.argv[2] not in wire and "iVBOR" not in wire,wire
PY
echo "✓ 单图 raw 上传 + 精确 send JSON"

# 多图：每图各自上传，send 只发 manifest 数组；超过 4 张本地 fail-fast。
: > "$CALLS"
run_mesh send "computer2:cc-target" "two" --image "$PNG" --image "$PNG" >/dev/null
python3 - "$CALLS" <<'PY'
import json,sys
calls=[json.loads(x) for x in open(sys.argv[1],encoding="utf-8")]
assert len(calls)==3,calls
assert [c["url"] for c in calls].count("http://relay.test/api/attachments")==2,calls
doc=json.loads(calls[-1]["data"])
assert doc=={"to":"computer2:cc-target","message":"two","attachments":[doc["attachments"][0],doc["attachments"][0]]},doc
PY
: > "$CALLS"
set +e
run_mesh send "computer2:cc-target" "too many" \
  --image "$PNG" --image "$PNG" --image "$PNG" --image "$PNG" --image "$PNG" \
  >"$TMP_DIR/out" 2>"$TMP_DIR/err"
STATUS=$?
set -e
test "$STATUS" -ne 0 || { echo "FAIL: 5 张图应非零退出"; exit 1; }
test ! -s "$CALLS" || { echo "FAIL: 超图片数必须在网络前拒绝"; cat "$CALLS"; exit 1; }
grep -Eq '最多.*4|maximum.*4|too many' "$TMP_DIR/err" || { echo "FAIL: 超限错误不明确"; cat "$TMP_DIR/err"; exit 1; }
echo "✓ 多图与每消息 4 图上限"

# 上传失败：正文仍走 /send；stderr 明确但不得泄漏本地路径；send JSON 不伪造附件。
: > "$CALLS"
set +e
MESH_TEST_UPLOAD_FAIL=1 run_mesh send "computer2:cc-target" "附件坏了正文也要到" --image "$PNG" >"$TMP_DIR/out" 2>"$TMP_DIR/err"
STATUS=$?
set -e
test "$STATUS" -eq 0 || { echo "FAIL: 附件上传失败不应吞正文(exit $STATUS)"; cat "$TMP_DIR/err"; exit 1; }
python3 - "$CALLS" <<'PY'
import json,sys
calls=[json.loads(x) for x in open(sys.argv[1],encoding="utf-8")]
assert len(calls)==2,calls
doc=json.loads(calls[-1]["data"])
assert doc=={"to":"computer2:cc-target","message":"附件坏了正文也要到"},doc
PY
grep -Eqi 'attachment.*unavailable|附件.*失败' "$TMP_DIR/err" || { echo "FAIL: 缺少明确附件失败提示"; cat "$TMP_DIR/err"; exit 1; }
grep -Fq "$PNG" "$TMP_DIR/err" && { echo "FAIL: 失败信息泄漏本地路径"; cat "$TMP_DIR/err"; exit 1; }
echo "✓ 上传失败降级且不泄路径"

# 不存在文件：参数错误，网络前非零退出；任何图片路径都不自动发微信。
: > "$CALLS"
set +e
run_mesh send "computer2:cc-target" "caption" --image "$TMP_DIR/missing.png" >/dev/null 2>"$TMP_DIR/err"
STATUS=$?
set -e
test "$STATUS" -ne 0 || { echo "FAIL: 不存在图片应非零退出"; exit 1; }
test ! -s "$CALLS" || { echo "FAIL: 本地图片不存在时不应请求网络"; cat "$CALLS"; exit 1; }
test ! -s "$WECHAT_CALLS" || { echo "FAIL: mesh 图片链路不得自动调用 cc2wechat"; cat "$WECHAT_CALLS"; exit 1; }
echo "✓ fail-fast + 零 cc2wechat 自动外发"

echo "ALL PASS: mesh-image"
