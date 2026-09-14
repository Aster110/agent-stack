/**
 * 私有 tmux server 的护栏函数。
 *
 * 原 `e2e/cases/E09-tmux-kill-server.ts` 的本地函数，2026-09-02 集成时折进 lib/。
 *
 * 🔴 隔离红线：整场只用**私有 tmux server**（`tmux -L e2e-<4hex>`）。
 *    **绝不对默认 server 执行 kill-server** —— relay 和现有席位都在那台上。
 *    凡是 tmux 调用都强制带 `-L`，并且硬校验 socket 名是 e2e- 前缀。
 *    （E09 里读默认 server 的那几行是**只读对照**，故意不走这个函数，留在 case 原地。）
 */
import { execFileSync } from "node:child_process"

/** 只允许 e2e- 前缀的私有 socket。默认 server（无 -L）永远不许进这个函数。 */
export function tmux(socket: string, args: string[], tolerant = true): string {
  if (!/^e2e-[0-9a-f]{4}$/.test(socket)) {
    throw new Error(`红线：tmux socket 必须是 e2e-<4hex>，收到 ${JSON.stringify(socket)}`)
  }
  try {
    return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf-8", timeout: 20_000 }).trim()
  } catch (e) {
    if (tolerant) return String((e as any).stderr ?? (e as Error).message ?? "").trim()
    throw e
  }
}
