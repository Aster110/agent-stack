import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { parseReceipt, type Receipt } from "../../src/contracts.js"

/** 生产 relay 的口。任何 e2e 端口都必须 ≠ 它（红线）。原 e2e/laneC/harness.ts，2026-09-02 集成时折进 lib/。 */
export const PROD_RELAY_PORT = 19800

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export const hex = (n = 2): string => randomBytes(n).toString("hex")

export async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs: number,
  label: string,
  stepMs = 25,
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v as T
    if (Date.now() - t0 > timeoutMs) throw new Error(`e2e 超时 ${timeoutMs}ms: ${label}`)
    await sleep(stepMs)
  }
}

/** 拿一个空闲端口，并**硬断言不是 19800**（生产 relay 的口，红线）。 */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer()
      srv.once("error", reject)
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as net.AddressInfo).port
        srv.close(() => resolve(p))
      })
    })
    if (port !== PROD_RELAY_PORT) return port
  }
  throw new Error("拿不到非 19800 的空闲端口")
}

/** 递归统计目录字节数（真引擎的 rollout 增长证据）。目录不存在返回 0。 */
export function dirBytes(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += dirBytes(p)
    else {
      try { total += fs.statSync(p).size } catch { /* 文件正被写/已删 */ }
    }
  }
  return total
}

/** 解析回执，非回执返回 null（薄封装，省得每个 case 都 import contracts） */
export function parseReceiptSafe(text: string): Receipt | null {
  return parseReceipt(text)
}
