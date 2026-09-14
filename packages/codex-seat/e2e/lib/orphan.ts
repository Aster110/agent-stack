/**
 * 种一个真孤儿（E08 的阳性对照）／造一个没有 CU 的 CODEX_HOME（E13 的红门）。
 *
 * 原 `e2e/laneC/harness.ts`，2026-09-02 集成时折进 lib/（注释是实测教训，逐字保留）。
 *
 * ⚠️ `hex()` 单位：lib/util.ts 的 `hex(n)` 出 2n 个十六进制字符，原 harness 的出 n 个 ——
 *    所以 `hex(4)` 搬过来写成 `hex(2)`，产物仍是 4 个字符。
 */
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { REAL_CODEX_HOME } from "./script-case.js"
import { hex } from "./util.js"

/**
 * 起一个带本席位标签的 app-server，stdin 接在一个**读写都打开**的 FIFO 上，
 * 然后只杀 node wrapper —— rust 本体的 stdin 永远不 EOF，于是它活下来变成 ppid=1 的孤儿。
 *
 * 为什么要这么绕：实测（2026-09-02）我们**自己**起的引擎，只杀 wrapper 是杀得死本体的 ——
 * sidecar 持着 stdio 管道，wrapper 一死 node 就把管道关了，本体收到 EOF 自己退。
 * 也就是说「只杀 wrapper 会留孤儿」这条历史教训**在我们的进程拓扑下不复现**。
 * 但生产上还有别的拓扑（tmux 里手敲、脚本 nohup、被别的东西 kill），孤儿仍然可能出现，
 * 所以清扫逻辑必须留着，也必须被真孤儿验过 —— 这个函数就是用来造那个真孤儿的。
 */
/**
 * 造一个「没有 CU」的 CODEX_HOME：只拷 auth.json，不拷 config.toml。
 * 实测（2026-09-02）这是**唯一验证有效**的 CU 关闭方式 ——
 * `-c mcp_servers.node_repl.enabled=false`、`-c features.js_repl=false`、
 * 甚至 `-c plugins."unified-computer-use@openai-bundled".enabled=false` 都**关不掉** `cua_repl` 工具
 * （三种都实测过，工具照样在，模型照样调）。
 */
export function strippedCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-nocu-"))
  for (const f of ["auth.json"]) {
    try {
      fs.copyFileSync(path.join(REAL_CODEX_HOME, f), path.join(dir, f))
    } catch { /* 没有就算了，起不来会在断言里体现 */ }
  }
  return dir
}

export function plantOrphanAppServer(seat: string, cwd: string): { pgid: number; wrapperPid: number; fifo: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-orphan-"))
  const fifo = path.join(dir, "stdin.fifo")
  execFileSync("mkfifo", [fifo])
  const instanceId = `orph${hex(2)}`
  const bin = execFileSync("/usr/bin/which", ["codex"], { encoding: "utf-8" }).trim()
  const args = [
    "app-server", "--listen", "stdio://", "-c", "notify=[]",
    "-c", `codex_seat.tag="${seat}/${instanceId}"`,
  ]
  const q = (x: string) => `'${x.replace(/'/g, `'\''`)}'`
  // exec 3<>fifo：读写都开，FIFO 永远不会 EOF；exec 替换掉 sh，进程组 leader 就是 wrapper
  const script = `exec 3<>${q(fifo)}; exec ${q(bin)} ${args.map(q).join(" ")} <&3 >/dev/null 2>&1`
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" })
  child.unref()
  if (!child.pid) throw new Error("种孤儿失败：没拿到 pid")
  return { pgid: child.pid, wrapperPid: child.pid, fifo }
}
