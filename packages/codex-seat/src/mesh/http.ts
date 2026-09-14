// 极简 JSON HTTP 客户端。**故意用 node:http/node:https 而不是 fetch**：
//
// 席位打的是本机 relay（127.0.0.1:19800）。undici 的 fetch 在 NODE_USE_ENV_PROXY=1
// 或有人 setGlobalDispatcher(new EnvHttpProxyAgent()) 时会去读 HTTP_PROXY/ALL_PROXY——
// 这台机器上 TUN 全接管代理是常态，一旦走代理，本机 relay 的长轮询会变成对代理的连接，
// 表现是「明明 relay 活着却收不到消息」这种最难查的静默故障（MEMORY: tun-proxy-breaks-liveness-probe）。
// node:http 从不读代理 env，且 agent 由我们自己给，代理配置怎么变都影响不到这条路径。
//
// 无新依赖（LANES §2.6）。

import http from "node:http"
import https from "node:https"
import { URL } from "node:url"

export interface HttpJsonOptions {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  /** 整个请求（含 body 读完）的墙钟上限；长轮询要给足 */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface HttpJsonResult {
  status: number
  text: string
  json: unknown
}

/** 每个 client 一个 agent：keepAlive 复用连接，长轮询不受 socket idle timeout 影响。 */
export function makeAgents(): { http: http.Agent; https: https.Agent } {
  return {
    http: new http.Agent({ keepAlive: true, maxSockets: 16 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 16 }),
  }
}

export async function requestJson(opts: HttpJsonOptions, agents?: { http: http.Agent; https: https.Agent }): Promise<HttpJsonResult> {
  const u = new URL(opts.url)
  const isHttps = u.protocol === "https:"
  const mod = isHttps ? https : http
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body), "utf8")
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers }
  if (payload) {
    headers["content-type"] = "application/json"
    headers["content-length"] = String(payload.length)
  }

  return await new Promise<HttpJsonResult>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void): void => { if (!settled) { settled = true; cleanup(); fn() } }

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: opts.method,
        headers,
        agent: agents ? (isHttps ? agents.https : agents.http) : undefined,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let json: unknown = null
          try { json = text ? JSON.parse(text) : null } catch { json = null }
          done(() => resolve({ status: res.statusCode ?? 0, text, json }))
        })
        res.on("error", (err) => done(() => reject(err)))
      },
    )

    const onAbort = (): void => { req.destroy(new Error("aborted")); done(() => reject(new Error("aborted"))) }
    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => { req.destroy(new Error(`timeout after ${opts.timeoutMs}ms`)); done(() => reject(new Error(`timeout after ${opts.timeoutMs}ms`))) }, opts.timeoutMs)
      : null
    function cleanup(): void {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
    }
    if (opts.signal) {
      if (opts.signal.aborted) { req.destroy(); done(() => reject(new Error("aborted"))); return }
      opts.signal.addEventListener("abort", onAbort, { once: true })
    }

    req.on("error", (err) => done(() => reject(err)))
    if (payload) req.write(payload)
    req.end()
  })
}
