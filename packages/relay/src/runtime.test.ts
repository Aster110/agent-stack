/** Relay 附件运行时配置接缝红测：env / ledger-url 的优先级与 fail-closed 语义。 */
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ImageAttachmentManifest } from "@cc-mesh/protocol"
import type { AttachmentManager } from "./attachments.js"
import { attachmentManagerFromEnv } from "./runtime.js"
import { resolveHubToken } from "./uplink/websocket.js"

const TOKEN = "runtime-config-test-token"
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
const SHA = createHash("sha256").update(PNG).digest("hex")

interface AttachmentRuntimeConfigOptions {
  /** Test/deployment seam equivalent to the real user's home directory. */
  homeDir?: string
  /** Optional exact config file override; default is <homeDir>/.ccmesh/ledger-url. */
  ledgerUrlFile?: string
}

type AttachmentManagerFactory = (
  env?: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
  tokenOverride?: string,
  config?: AttachmentRuntimeConfigOptions,
) => AttachmentManager | undefined

// The fourth argument is the required red-test contract; production currently ignores it.
const managerFromConfig = attachmentManagerFromEnv as AttachmentManagerFactory

function responseManifest(): ImageAttachmentManifest {
  const now = Date.now()
  return {
    version: 1,
    id: `att-${SHA}`,
    kind: "image",
    mime: "image/png",
    size: PNG.length,
    sha256: SHA,
    width: 1,
    height: 1,
    storageRef: `hub-blob:${SHA}`,
    createdAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  }
}

describe("attachmentManagerFromEnv 配置来源", () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function fakeHome(): { home: string; configDir: string; cacheDir: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-runtime-home-"))
    roots.push(home)
    const configDir = path.join(home, ".ccmesh")
    const cacheDir = path.join(home, "attachment-cache")
    fs.mkdirSync(configDir, { recursive: true })
    return { home, configDir, cacheDir }
  }

  function capturingFetch(calls: Array<{ url: string; authorization: string | null }>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(input), authorization: headers.get("Authorization") })
      return new Response(JSON.stringify({ ok: true, data: { manifest: responseManifest() } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch
  }

  async function uploadOnce(
    env: NodeJS.ProcessEnv,
    config: AttachmentRuntimeConfigOptions,
    token: string | undefined = TOKEN,
  ): Promise<Array<{ url: string; authorization: string | null }>> {
    const calls: Array<{ url: string; authorization: string | null }> = []
    const manager = managerFromConfig(env, capturingFetch(calls), token, config)
    assert.ok(manager, "配置完整时必须创建 AttachmentManager")
    const manifest = await manager.upload(PNG, "image/png", 60)
    assert.equal(manifest.sha256, SHA)
    assert.equal(JSON.stringify(manifest).includes(TOKEN), false, "token 不得进入 manifest")
    return calls
  }

  it("无 HTTP env 时从 ~/.ccmesh/ledger-url 读取附件 Hub origin", async () => {
    const state = fakeHome()
    fs.writeFileSync(path.join(state.configDir, "ledger-url"), "  https://hub-file.example:19901\n", "utf8")
    fs.writeFileSync(path.join(state.configDir, "hub-token"), `  ${TOKEN}\n`, { mode: 0o600 })
    const tokenFromExistingSafeSource = resolveHubToken({ env: {}, homeDir: state.home })
    assert.equal(tokenFromExistingSafeSource?.length, TOKEN.length)

    const calls = await uploadOnce(
      { MESH_ATTACHMENT_CACHE_DIR: state.cacheDir },
      { homeDir: state.home },
      tokenFromExistingSafeSource,
    )

    assert.deepEqual(calls, [{
      url: "https://hub-file.example:19901/api/blobs",
      authorization: `Bearer ${TOKEN}`,
    }])
    assert.equal(calls[0]!.url.includes(TOKEN), false, "token 不得进入 URL")
  })

  it("地址优先级严格为 MESH_HUB_HTTP_URL > MESH_LEDGER_URL > ledger-url 文件", async () => {
    const state = fakeHome()
    fs.writeFileSync(path.join(state.configDir, "ledger-url"), "https://from-file.example:19901\n", "utf8")
    const common = { MESH_ATTACHMENT_CACHE_DIR: state.cacheDir }

    const highest = await uploadOnce({
      ...common,
      MESH_HUB_HTTP_URL: "https://from-hub-http-env.example:19901",
      MESH_LEDGER_URL: "https://from-ledger-env.example:19901",
    }, { homeDir: state.home })
    assert.equal(highest[0]!.url, "https://from-hub-http-env.example:19901/api/blobs")

    const middle = await uploadOnce({
      ...common,
      MESH_LEDGER_URL: "https://from-ledger-env.example:19901",
    }, { homeDir: state.home })
    assert.equal(middle[0]!.url, "https://from-ledger-env.example:19901/api/blobs")

    const fallback = await uploadOnce(common, { homeDir: state.home })
    assert.equal(fallback[0]!.url, "https://from-file.example:19901/api/blobs")
  })

  it("MESH_HUB_HTTP_URL 与 MESH_LEDGER_URL 逐层使用同一套严格 origin 校验", () => {
    const badOrigins = [
      "file:///tmp/blob",
      "ws://hub.example:19901",
      "https://user:password@hub.example:19901",
      "https://hub.example:19901/nested/path",
      "https://hub.example:19901?token=leak",
      "https://hub.example:19901/#fragment",
      "https://hub.example:19901\nhttps://evil.example:19901",
      "not a url",
    ]

    for (const source of ["MESH_HUB_HTTP_URL", "MESH_LEDGER_URL"] as const) {
      for (const value of badOrigins) {
        const state = fakeHome()
        fs.writeFileSync(path.join(state.configDir, "ledger-url"), "https://valid-file.example:19901\n", "utf8")
        let fetchCalls = 0
        const manager = managerFromConfig(
          {
            MESH_ATTACHMENT_CACHE_DIR: state.cacheDir,
            [source]: value,
          },
          (async () => { fetchCalls++; throw new Error("must not fetch") }) as typeof fetch,
          TOKEN,
          { homeDir: state.home },
        )
        assert.equal(manager, undefined, `${source} 非法时必须 fail-closed: ${JSON.stringify(value)}`)
        assert.equal(fetchCalls, 0)
      }
    }
  })

  it("显式存在的空或纯空白 env 属于非法配置；只有完全未设置才向下一层查找", async () => {
    const state = fakeHome()
    fs.writeFileSync(path.join(state.configDir, "ledger-url"), "https://valid-file.example:19901\n", "utf8")
    const common = { MESH_ATTACHMENT_CACHE_DIR: state.cacheDir }

    for (const value of ["", " ", "\n\t"]) {
      assert.equal(managerFromConfig({
        ...common,
        MESH_HUB_HTTP_URL: value,
        MESH_LEDGER_URL: "https://valid-middle.example:19901",
      }, fetch, TOKEN, { homeDir: state.home }), undefined, "显式空的最高层不得降级")

      assert.equal(managerFromConfig({
        ...common,
        MESH_LEDGER_URL: value,
      }, fetch, TOKEN, { homeDir: state.home }), undefined, "显式空的中间层不得降级")
    }

    const middle = await uploadOnce({
      ...common,
      MESH_LEDGER_URL: "https://valid-middle.example:19901",
    }, { homeDir: state.home })
    assert.equal(middle[0]!.url, "https://valid-middle.example:19901/api/blobs")

    const file = await uploadOnce(common, { homeDir: state.home })
    assert.equal(file[0]!.url, "https://valid-file.example:19901/api/blobs")
  })

  it("支持注入精确 ledgerUrlFile，且不依赖真实 HOME", async () => {
    const state = fakeHome()
    const injectedFile = path.join(state.home, "injected-ledger-origin")
    fs.writeFileSync(injectedFile, "http://127.0.0.1:29901\n", "utf8")

    const calls = await uploadOnce(
      { MESH_ATTACHMENT_CACHE_DIR: state.cacheDir },
      { ledgerUrlFile: injectedFile },
    )
    assert.equal(calls[0]!.url, "http://127.0.0.1:29901/api/blobs")
  })

  it("ledger-url 文件只接受无凭据、无 path/query/hash 的 http(s) 固定 origin", () => {
    const badOrigins = [
      "file:///tmp/blob",
      "ws://hub.example:19901",
      "https://user:password@hub.example:19901",
      "https://hub.example:19901/nested/path",
      "https://hub.example:19901?token=leak",
      "https://hub.example:19901/#fragment",
      "https://hub.example:19901\nhttps://evil.example:19901",
      "not a url",
    ]

    for (const value of badOrigins) {
      const state = fakeHome()
      fs.writeFileSync(path.join(state.configDir, "ledger-url"), value, "utf8")
      let fetchCalls = 0
      const manager = managerFromConfig(
        { MESH_ATTACHMENT_CACHE_DIR: state.cacheDir },
        (async () => { fetchCalls++; throw new Error("must not fetch") }) as typeof fetch,
        TOKEN,
        { homeDir: state.home },
      )
      assert.equal(manager, undefined, `非法 origin 必须 fail-closed: ${JSON.stringify(value)}`)
      assert.equal(fetchCalls, 0)
    }
  })

  it("接受并规范化带根斜杠的 HTTPS origin", async () => {
    const state = fakeHome()
    fs.writeFileSync(path.join(state.configDir, "ledger-url"), "https://hub.example:19901/\n", "utf8")
    const calls = await uploadOnce(
      { MESH_ATTACHMENT_CACHE_DIR: state.cacheDir },
      { homeDir: state.home },
    )
    assert.equal(calls[0]!.url, "https://hub.example:19901/api/blobs")
  })

  it("空/缺失/不可读配置文件 fail-closed，不猜默认地址", () => {
    for (const fixture of ["missing", "blank", "directory"] as const) {
      const state = fakeHome()
      const ledgerUrlFile = path.join(state.configDir, "ledger-url")
      if (fixture === "blank") fs.writeFileSync(ledgerUrlFile, " \n\t", "utf8")
      if (fixture === "directory") fs.mkdirSync(ledgerUrlFile)

      const manager = managerFromConfig(
        { MESH_ATTACHMENT_CACHE_DIR: state.cacheDir },
        fetch,
        TOKEN,
        { homeDir: state.home },
      )
      assert.equal(manager, undefined, `${fixture} ledger-url 必须关闭附件 manager`)
    }
  })

  it("显式最高层 env 非法时 fail-closed，不悄悄降级到中间层或文件", () => {
    const state = fakeHome()
    fs.writeFileSync(path.join(state.configDir, "ledger-url"), "https://valid-file.example:19901\n", "utf8")
    const manager = managerFromConfig({
      MESH_ATTACHMENT_CACHE_DIR: state.cacheDir,
      MESH_HUB_HTTP_URL: "javascript:alert(1)",
      MESH_LEDGER_URL: "https://valid-middle.example:19901",
    }, fetch, TOKEN, { homeDir: state.home })
    assert.equal(manager, undefined)
  })

  it("有地址但无既有安全 token 来源时仍 fail-closed", () => {
    const state = fakeHome()
    fs.writeFileSync(path.join(state.configDir, "ledger-url"), "https://hub.example:19901\n", "utf8")
    const manager = managerFromConfig(
      { MESH_ATTACHMENT_CACHE_DIR: state.cacheDir },
      fetch,
      undefined,
      { homeDir: state.home },
    )
    assert.equal(manager, undefined)
  })
})
