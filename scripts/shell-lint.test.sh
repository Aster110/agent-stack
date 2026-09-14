#!/usr/bin/env bash
# scripts/ 下 bash 脚本的静态检查。
#
# 存在的理由是一个**犯了两次**的 bug：
#
#   log "relay 判死（... http=$OBS_HTTP）"
#                                  ^^^^^^^^^^^^^ 后面紧跟全角「）」
#
# bash 在多字节 locale 下会把紧随其后的非 ASCII 字节**吃进变量名**，
# 于是 `$OBS_HTTP）` 被当成一个叫 `OBS_HTTP<乱码>` 的变量。
# 在 `set -u` 下这是**致命错**，脚本当场退出。
#
# 它有多阴险：
#   · bash -n 语法检查**发现不了**（语法本身合法）
#   · 只有那一行真的被执行到才炸 —— 而错误路径的日志行往往正是最少被执行到的
#   · 报错信息 `OBS_HTTP<乱码>: unbound variable` 看着像变量没定义，
#     会把人引去查赋值逻辑，而真正的问题在那个括号
#
# 第一次是在 mesh-seat-supervisor.sh，改完就忘了；第二次在 mesh-relay-supervisor.sh
# 原样又写了 8 处。犯两次就该上闸，不能靠记性。
#
# 修法始终是 `${VAR}`：大括号明确终止变量名，后面跟什么字符都无所谓。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0

TARGETS=(
  "$HERE/mesh-seat-supervisor.sh"
  "$HERE/mesh-relay-supervisor.sh"
  "$HERE/mesh-agent-wrapper.sh"
  "$HERE/mesh-seat-forensics.sh"
)

echo "== 变量展开后紧跟非 ASCII 字符（必须写成 \${VAR}）=="
for f in "${TARGETS[@]}"; do
  [ -f "$f" ] || continue
  out="$(python3 - "$f" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1])
pat = re.compile(r'\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])')
for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
    # 注释行不执行，炸不了；但仍然会误导读者，所以只跳过纯注释
    if line.lstrip().startswith("#"):
        continue
    if pat.search(line):
        print(f"{i}: {line.strip()[:100]}")
PY
)"
  if [ -z "$out" ]; then
    PASS=$((PASS+1)); printf '  ok   %s\n' "$(basename "$f")"
  else
    FAIL=$((FAIL+1))
    printf '  FAIL %s —— 下面这些 $VAR 后面紧跟非 ASCII，set -u 下执行到就炸：\n' "$(basename "$f")"
    printf '%s\n' "$out" | sed 's/^/         /'
    printf '         修法：改成 ${VAR}\n'
  fi
done

echo
echo "== 判据本身有效性（阳性对照，防止检查退化成摆设）=="
# 造一个含该形态的临时文件，检查必须抓到它。
# 没有这条，上面的检查哪天正则写坏了会**全绿**，而全绿正是它失效的样子。
TMPF="$(mktemp /tmp/shell-lint-probe-XXXX.sh)"
printf '%s\n' 'log "判死（http=$OBS_HTTP）"' > "$TMPF"
probe_out="$(python3 - "$TMPF" <<'PY'
import re, sys, pathlib
pat = re.compile(r'\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])')
for i, line in enumerate(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines(), 1):
    if line.lstrip().startswith("#"):
        continue
    if pat.search(line):
        print(i)
PY
)"
rm -f "$TMPF"
if [ -n "$probe_out" ]; then
  PASS=$((PASS+1)); printf '  ok   判据抓得住已知的坏形态\n'
else
  FAIL=$((FAIL+1)); printf '  FAIL 判据抓不住已知坏形态 —— 这个检查已经是摆设\n'
fi

echo
echo "== bash -n 语法 =="
for f in "${TARGETS[@]}"; do
  [ -f "$f" ] || continue
  if bash -n "$f" 2>/dev/null; then
    PASS=$((PASS+1)); printf '  ok   %s\n' "$(basename "$f")"
  else
    FAIL=$((FAIL+1)); printf '  FAIL %s 语法错\n' "$(basename "$f")"
  fi
done

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
