import type { Agent } from "node:http"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"

/**
 * 根据目标 URL 的 scheme 构造合适的 proxy agent。
 * - ws:// → HttpProxyAgent（HTTP CONNECT 隧道）
 * - wss:// → HttpsProxyAgent
 * - http:// / https:// → 同上规则
 *
 * proxyUrl 必须是完整 URL（如 `http://127.0.0.1:7890`）。
 * 非法格式会抛 `TypeError`，调用方应 try/catch 做降级。
 */
export function buildProxyAgent(targetUrl: string, proxyUrl: string): Agent {
  const target = new URL(targetUrl)
  const proxy = new URL(proxyUrl)

  if (!proxy.protocol.startsWith("http")) {
    throw new TypeError(
      `proxy URL must use http:// or https://, got: ${proxy.protocol}`,
    )
  }

  const scheme = target.protocol
  if (scheme === "wss:" || scheme === "https:") {
    return new HttpsProxyAgent(proxyUrl)
  }
  return new HttpProxyAgent(proxyUrl)
}

/**
 * 从环境变量读取 proxy URL。
 * 只认专属的 `MESH_HTTPS_PROXY`，**不**fallback 到 `HTTPS_PROXY`。
 *
 * 为什么不用 HTTPS_PROXY：很多人的 shell（zshrc / bashrc）里会给 curl / wget
 * 等 CLI 工具预设 `HTTPS_PROXY`，这是会话级偏好，不是系统策略。
 * relay 是长期运行的 daemon，走不走代理要显式声明，避免"你没说但我偷偷改了路径"的惊喜。
 *
 * 想走代理：显式 `export MESH_HTTPS_PROXY=http://host:port`。
 * 返回 undefined 表示不走代理。
 */
export function readProxyEnv(): string | undefined {
  const val = process.env.MESH_HTTPS_PROXY
  if (!val || val.trim() === "") return undefined
  return val.trim()
}
