#!/usr/bin/env bash
# mesh CLI 云端账本子命令（M1）+ dispatch（M2）的参数层测试。
# 全程假 curl + 假 HOME —— 不碰真 ~/.ccmesh、不连真 Hub、不动本机 relay。
#
# 盖：无参报错 / 账本地址解析优先级（env > 文件 > 默认）/ token 缺失人话报错 /
#     Bearer 头 / 各子命令打的端点与 query / dispatch 缺 --to 报错与 body 形状。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_SH="$SCRIPT_DIR/mesh.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_HOME="$TMP_DIR/home"
mkdir -p "$FAKE_HOME/.ccmesh"
ARGS_FILE="$TMP_DIR/args.txt"

# 假 curl：把全部 args 落文件；输出「空 JSON + 200」两行（ledger_get 按最后一行取 http_code）
cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MESH_TEST_ARGS"
printf '{"ok":true,"data":[]}\n200\n'
EOF
chmod +x "$TMP_DIR/curl"

# run_mesh <mesh 子命令及参数...>；额外环境变量走 EXTRA_ENV="K=V"（故意不加引号做词分割）。
# 真机的 MESH_HUB_TOKEN / MESH_LEDGER_URL 一律 -u 掉，测试结果不受跑测者环境影响。
run_mesh() {
  : > "$ARGS_FILE"
  local extra="${EXTRA_ENV:-}"
  env -u MESH_HUB_TOKEN -u MESH_LEDGER_URL \
      PATH="$TMP_DIR:$PATH" HOME="$FAKE_HOME" MESH_TEST_ARGS="$ARGS_FILE" \
      MESH_RELAY_URL="http://relay.test" $extra \
      bash "$MESH_SH" "$@"
}

fail() { echo "FAIL $1"; [[ -f "$ARGS_FILE" ]] && echo "args=$(cat "$ARGS_FILE")"; exit 1; }

# ===== 段1：token 缺失 → 人话报错 + 非零退出（不静默查空） =====
set +e
run_mesh quota >/dev/null 2>"$TMP_DIR/e1.err"
STATUS=$?
set -e
test "$STATUS" -ne 0 || fail "段1: token 缺失应非零退出"
grep -q "hub-token" "$TMP_DIR/e1.err" || fail "段1: 报错未指路 hub-token（$(cat "$TMP_DIR/e1.err")）"
echo "✓ 段1: 无 token → 人话报错并退出"

# 后续段落都有 token
printf 'tok-from-file\n' > "$FAKE_HOME/.ccmesh/hub-token"

# ===== 段2：默认账本地址 127.0.0.1:19901（无 env 无文件） =====
run_mesh quota >/dev/null
grep -q "http://127.0.0.1:19901/api/ledger/quota" "$ARGS_FILE" || fail "段2: 未用默认账本地址"
echo "✓ 段2: 无配置 → 默认 http://127.0.0.1:19901"

# ===== 段3：~/.ccmesh/ledger-url 文件覆盖默认 =====
printf 'http://from-file:19901\n' > "$FAKE_HOME/.ccmesh/ledger-url"
run_mesh quota >/dev/null
grep -q "http://from-file:19901/api/ledger/quota" "$ARGS_FILE" || fail "段3: 未读 ledger-url 文件"
echo "✓ 段3: 文件 ~/.ccmesh/ledger-url 覆盖默认"

# ===== 段4：env MESH_LEDGER_URL 覆盖文件（最高优先级） =====
EXTRA_ENV="MESH_LEDGER_URL=http://from-env:19901" run_mesh quota >/dev/null
grep -q "http://from-env:19901/api/ledger/quota" "$ARGS_FILE" || fail "段4: env 未覆盖文件"
grep -q "from-file:19901" "$ARGS_FILE" && fail "段4: 文件里的地址不该出现"
echo "✓ 段4: env MESH_LEDGER_URL > 文件 > 默认"

# ===== 段5：Bearer token 必带（文件值） =====
run_mesh quota >/dev/null
grep -q "Authorization: Bearer tok-from-file" "$ARGS_FILE" || fail "段5: 未带 Bearer 头"
echo "✓ 段5: 带 Authorization: Bearer <token>"

# ===== 段6：env MESH_HUB_TOKEN 覆盖文件 =====
EXTRA_ENV="MESH_HUB_TOKEN=tok-from-env" run_mesh quota >/dev/null
grep -q "Authorization: Bearer tok-from-env" "$ARGS_FILE" || fail "段6: env token 未覆盖文件"
echo "✓ 段6: env MESH_HUB_TOKEN > 文件"

# ===== 段7：四个读子命令各打各的端点 =====
run_mesh agents >/dev/null
grep -q "/api/ledger/agents" "$ARGS_FILE" || fail "段7: agents 端点不对"
run_mesh tasks --status dispatched >/dev/null
grep -q "/api/ledger/tasks?status=dispatched" "$ARGS_FILE" || fail "段7: tasks --status 未进 query"
run_mesh log --to "@ledger" --type quota_report --limit 5 >/dev/null
grep -q "/api/ledger/messages?to=%40ledger&type=quota_report&limit=5" "$ARGS_FILE" || fail "段7: log query 拼错"
run_mesh quota --account "claude-abc123" >/dev/null
grep -q "/api/ledger/quota?account=claude-abc123" "$ARGS_FILE" || fail "段7: quota --account 未进 query"
echo "✓ 段7: quota/agents/tasks/log 端点与 query 正确（含 URL 编码）"

# ===== 段8：读子命令的未知参数直接报错（不静默吞） =====
set +e
run_mesh tasks --statuss dispatched >/dev/null 2>"$TMP_DIR/e8.err"
STATUS=$?
set -e
test "$STATUS" -ne 0 || fail "段8: 未知参数应非零退出"
echo "✓ 段8: 未知参数 → 报错退出"

# ===== 段9：dispatch 缺 --to → 报错退出（v1 必须显式指定席位） =====
set +e
run_mesh dispatch --title "干活" "正文" >/dev/null 2>"$TMP_DIR/e9.err"
STATUS=$?
set -e
test "$STATUS" -ne 0 || fail "段9: 缺 --to 应非零退出"
grep -q -- "--to" "$TMP_DIR/e9.err" || fail "段9: 报错未提 --to（$(cat "$TMP_DIR/e9.err")）"
grep -q "dispatch" "$ARGS_FILE" && fail "段9: 缺 --to 不该发出请求"
echo "✓ 段9: dispatch 缺 --to → 报错且不发请求"

# ===== 段10：dispatch 缺 --title / 缺正文 也报错 =====
set +e
run_mesh dispatch --to "macbook:cc-a1b2" "正文" >/dev/null 2>&1
S1=$?
run_mesh dispatch --to "macbook:cc-a1b2" --title "干活" >/dev/null 2>&1
S2=$?
set -e
test "$S1" -ne 0 || fail "段10: 缺 --title 应非零退出"
test "$S2" -ne 0 || fail "段10: 缺正文应非零退出"
echo "✓ 段10: dispatch 缺 --title / 缺正文 → 报错退出"

# ===== 段11：dispatch happy path 打本机 relay /api/dispatch，body 字段齐全且全是字符串 =====
run_mesh dispatch --to "macbook:cc-a1b2" --title "M1 收口" --project P62 "把测试跑绿" >/dev/null
grep -q "http://relay.test/api/dispatch" "$ARGS_FILE" || fail "段11: 未打本机 relay 的 /api/dispatch"
grep -q '"to": "macbook:cc-a1b2"' "$ARGS_FILE" || fail "段11: body 缺 to"
grep -q '"title": "M1 收口"' "$ARGS_FILE" || fail "段11: body 缺 title"
grep -q '"payload": "把测试跑绿"' "$ARGS_FILE" || fail "段11: body 缺 payload"
grep -q '"project": "P62"' "$ARGS_FILE" || fail "段11: body 缺 project"
echo "✓ 段11: dispatch → POST relay /api/dispatch，body 正确"

# ===== 段12：多词正文合并成一条 payload；纯数字正文仍是字符串（不被 JSON 化成 number） =====
run_mesh dispatch --to "macbook:cc-a1b2" --title T 跑 完 测试 >/dev/null
grep -q '"payload": "跑 完 测试"' "$ARGS_FILE" || fail "段12: 多词正文未合并"
run_mesh dispatch --to "macbook:cc-a1b2" --title T 12345 >/dev/null
grep -q '"payload": "12345"' "$ARGS_FILE" || fail "段12: 数字正文被转成了 number"
echo "✓ 段12: 正文按字符串原样传（多词合并 / 数字不被转型）"

# ===== 段13：无 project 时 body 不带 project 键 =====
run_mesh dispatch --to "macbook:cc-a1b2" --title T "正文" >/dev/null
grep -q '"project"' "$ARGS_FILE" && fail "段13: 未传 --project 却出现了 project 键"
grep -q '"todoUid"' "$ARGS_FILE" && fail "段13: 未传 --todo 却出现了 todoUid 键"
echo "✓ 段13: 未传 --project / --todo → body 不带该键"

# ===== 段13b（P142 T2）：--todo <uid> → body.todoUid（归属联结；relay 需把它放进 meta._task.todoUid） =====
run_mesh dispatch --to "macbook:cc-a1b2" --title T --todo "11111111-1111-4111-8111-111111111111" "正文" >/dev/null
grep -q '"todoUid": "11111111-1111-4111-8111-111111111111"' "$ARGS_FILE" || fail "段13b: body 缺 todoUid"
grep -q '"payload": "正文"' "$ARGS_FILE" || fail "段13b: --todo 吃掉了正文"
run_mesh dispatch --help | grep -q -- "--todo" || fail "段13b: dispatch --help 未说明 --todo"
echo "✓ 段13b: --todo <uid> → body.todoUid，正文不受影响"

# ===== 段13c（P142 T2）：mesh tasks --todo <uid> → ?todoUid= 查归属 =====
run_mesh tasks --todo "11111111-1111-4111-8111-111111111111" >/dev/null
grep -q "api/ledger/tasks?todoUid=11111111-1111-4111-8111-111111111111" "$ARGS_FILE" || fail "段13c: tasks --todo 未拼 todoUid 查询"
echo "✓ 段13c: tasks --todo → ?todoUid= 过滤"

# ===== 段14：help 里有新子命令（别人得能发现它们） =====
HELP_OUT="$(run_mesh help)"
for kw in dispatch quota agents tasks "log " MESH_LEDGER_URL; do
  printf '%s' "$HELP_OUT" | grep -q -- "$kw" || fail "段14: help 缺 '$kw'"
done
echo "✓ 段14: help 覆盖 dispatch / quota / agents / tasks / log / MESH_LEDGER_URL"

# ===== 段15：账本 401 → 人话报错（token 不对时不装作没数据） =====
cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MESH_TEST_ARGS"
printf '{"ok":false,"error":"unauthorized"}\n401\n'
EOF
chmod +x "$TMP_DIR/curl"
set +e
run_mesh quota >/dev/null 2>"$TMP_DIR/e15.err"
STATUS=$?
set -e
test "$STATUS" -ne 0 || fail "段15: 401 应非零退出"
grep -q "401" "$TMP_DIR/e15.err" || fail "段15: 报错未提 HTTP 401"
echo "✓ 段15: HTTP 401 → 人话报错并退出"

# ===== 段16-18：真实 API 形状渲染（列名对不上就等于表格空一半，这是 2026-08-27 的回归）=====
# 样例字段照抄 Hub :19901 实测返回（camelCase）。
fake_curl_body() {
  cat > "$TMP_DIR/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "\$MESH_TEST_ARGS"
cat <<'JSON'
$1
JSON
printf '200\n'
EOF
  chmod +x "$TMP_DIR/curl"
}

fake_curl_body '{"ok":true,"history":false,"data":[{"id":1,"probedAt":"2026-08-27T05:20:08-07:00","host":"Computer1","source":"codex","accountFp":"chatgpt-fixture0000","plan":"pro","status":"ok","pct5h":0,"pct7d":17,"resets5h":"2026-08-27T10:20:08-07:00","resets7d":"2026-09-01T07:13:29-07:00","envelope":"{...}","recordedAt":"2026-08-27T12:20:09.000Z"}]}'
OUT="$(run_mesh quota)"
for col in accountFp pct5h pct7d resets5h probedAt; do
  printf '%s' "$OUT" | grep -q "$col" || fail "段16: quota 表缺列 $col（列名又对不上了）"
done
printf '%s' "$OUT" | grep -q "chatgpt-fixture0000" || fail "段16: quota 值没渲染出来"
printf '%s' "$OUT" | grep -q "envelope" && fail "段16: envelope 原文不该进表（太长）"
echo "✓ 段16: quota 按真实 camelCase 字段出全表"

fake_curl_body '{"ok":true,"data":[{"taskId":"msg-1787833328553-0-tvjf-unknown","title":"E2E-M2-跨机试单","project":"P62","fromNode":"unknown","toNode":"workstation:e2e-probe","seatId":null,"accountFp":null,"pickReason":"explicit","status":"replied","createdAt":"2026-08-27T12:22:08.553Z","repliedAt":"2026-08-27T12:22:18.137Z","replyMsgId":"msg-x"}]}'
OUT="$(run_mesh tasks --status replied)"
for col in taskId pickReason toNode repliedAt; do
  printf '%s' "$OUT" | grep -q "$col" || fail "段17: tasks 表缺列 $col"
done
printf '%s' "$OUT" | grep -q "explicit" || fail "段17: pickReason 值没渲染"
echo "✓ 段17: tasks 按真实 camelCase 字段出全表"

# agents：数据嵌在 data.agents，且额度嵌在每行的 quota 里（点路径列）
fake_curl_body '{"ok":true,"data":{"agents":[{"seatId":"computer1/codex","device":"computer1","agentKind":"codex","accountFp":"chatgpt-fixture0000","capabilities":["project","cc-mesh"],"delivery":"inject","active":true,"updatedAt":"2026-08-27T12:25:46.416Z","online":true,"nodes":["computer1:main-cc"],"quota":{"pct5h":0,"pct7d":17,"plan":"pro"}}]}}'
OUT="$(run_mesh agents)"
printf '%s' "$OUT" | grep -q "seatId" || fail "段18: agents 没解出 data.agents 嵌套"
printf '%s' "$OUT" | grep -q "quota.pct7d" || fail "段18: 点路径列 quota.pct7d 没出"
printf '%s' "$OUT" | grep -q "17" || fail "段18: 嵌套额度值没渲染"
printf '%s' "$OUT" | grep -q "1 行" || fail "段18: 行数没打印"
echo "✓ 段18: agents 解嵌套 data.agents + 点路径取 quota.pct5h/pct7d"

echo "ALL PASS: mesh-ledger-cli"
