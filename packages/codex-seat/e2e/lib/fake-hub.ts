/**
 * 假 Hub（E14）——只记录，不打印 token。
 *
 * 原 `e2e/laneC/harness.ts`，2026-09-02 集成时折进 lib/。
 * 🔴 存在的理由：**绝不连生产 Hub（192.0.2.1:19901）**。
 */
import http from "node:http"

import { freePort } from "./util.js"

export interface FakeHub {
  url: string
  puts: Array<{ path: string; body: any; hasBearer: boolean }>
  stop(): Promise<void>
}

export async function startFakeHub(): Promise<FakeHub> {
  const puts: FakeHub["puts"] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body: any = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
      } catch { /* 非 JSON */ }
      if (req.method === "PUT") {
        // 只记「有没有 Bearer 头」，**永不记录/打印 token 本身**
        puts.push({ path: req.url ?? "", body, hasBearer: /^Bearer\s+\S+/.test(String(req.headers.authorization ?? "")) })
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  const port = await freePort()
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r))
  return {
    url: `http://127.0.0.1:${port}`,
    puts,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }
}
