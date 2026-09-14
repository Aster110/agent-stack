import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { buildProxyAgent, readProxyEnv } from "./proxy.js"

describe("buildProxyAgent", () => {
  it("ws:// 目标 → 返回 HttpProxyAgent", () => {
    const agent = buildProxyAgent("ws://hub.example.com:19900", "http://127.0.0.1:7890")
    assert.ok(agent instanceof HttpProxyAgent, "should return HttpProxyAgent for ws://")
  })

  it("http:// 目标 → 返回 HttpProxyAgent", () => {
    const agent = buildProxyAgent("http://api.example.com", "http://127.0.0.1:7890")
    assert.ok(agent instanceof HttpProxyAgent)
  })

  it("wss:// 目标 → 返回 HttpsProxyAgent", () => {
    const agent = buildProxyAgent("wss://hub.example.com:19900", "http://127.0.0.1:7890")
    assert.ok(agent instanceof HttpsProxyAgent, "should return HttpsProxyAgent for wss://")
  })

  it("https:// 目标 → 返回 HttpsProxyAgent", () => {
    const agent = buildProxyAgent("https://api.example.com", "http://127.0.0.1:7890")
    assert.ok(agent instanceof HttpsProxyAgent)
  })

  it("非法 proxy URL（非 http/https scheme）抛 TypeError", () => {
    assert.throws(
      () => buildProxyAgent("ws://hub", "socks5://127.0.0.1:1080"),
      /proxy URL must use http/,
    )
  })

  it("非法 target URL 抛错（由 new URL 抛）", () => {
    assert.throws(() => buildProxyAgent("not-a-url", "http://127.0.0.1:7890"))
  })

  it("非法 proxy URL 抛错（由 new URL 抛）", () => {
    assert.throws(() => buildProxyAgent("ws://hub", "not-a-url"))
  })
})

describe("readProxyEnv", () => {
  const original = {
    MESH_HTTPS_PROXY: process.env.MESH_HTTPS_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
  }

  beforeEach(() => {
    delete process.env.MESH_HTTPS_PROXY
    delete process.env.HTTPS_PROXY
  })

  afterEach(() => {
    if (original.MESH_HTTPS_PROXY) process.env.MESH_HTTPS_PROXY = original.MESH_HTTPS_PROXY
    else delete process.env.MESH_HTTPS_PROXY
    if (original.HTTPS_PROXY) process.env.HTTPS_PROXY = original.HTTPS_PROXY
    else delete process.env.HTTPS_PROXY
  })

  it("都没设 → undefined", () => {
    assert.equal(readProxyEnv(), undefined)
  })

  it("只设 MESH_HTTPS_PROXY → 返回其值", () => {
    process.env.MESH_HTTPS_PROXY = "http://clash.local:7890"
    assert.equal(readProxyEnv(), "http://clash.local:7890")
  })

  it("只设 HTTPS_PROXY（无 MESH_HTTPS_PROXY） → undefined（不 fallback）", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080"
    assert.equal(readProxyEnv(), undefined,
      "HTTPS_PROXY 是 shell 习惯，不应被 relay 默默采用；必须显式 MESH_HTTPS_PROXY")
  })

  it("MESH_HTTPS_PROXY 和 HTTPS_PROXY 都设 → 仅认 MESH_HTTPS_PROXY", () => {
    process.env.MESH_HTTPS_PROXY = "http://clash.local:7890"
    process.env.HTTPS_PROXY = "http://other:8080"
    assert.equal(readProxyEnv(), "http://clash.local:7890")
  })

  it("MESH_HTTPS_PROXY 为空字符串视为未设", () => {
    process.env.MESH_HTTPS_PROXY = ""
    assert.equal(readProxyEnv(), undefined)
  })

  it("MESH_HTTPS_PROXY 两侧有空白 → 自动 trim", () => {
    process.env.MESH_HTTPS_PROXY = "  http://clash.local:7890  "
    assert.equal(readProxyEnv(), "http://clash.local:7890")
  })
})
