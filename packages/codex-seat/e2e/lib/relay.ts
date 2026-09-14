// 私有 relay 启动器。隔离法照抄 packages/relay/e2e/sse-pull.e2e.test.sh：
//   随机端口（断言 ≠19800）+ HOME=<tmp> + MESH_DB_PATH=<tmp> + MESH_DEVICE_ID=e2edev + 无 MESH_HUB_URL。
// 红线：绝不碰生产 :19800 / ~/.ccmesh/db/mesh.db / 任何真实节点。

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { MeshClient } from "../../src/mesh/mesh-client.js"
import { freePort, sleep, waitFor } from "./util.js"

export const E2E_DEVICE_ID = "e2edev"

export interface PrivateRelay {
  url: string
  port: number
  home: string
  dbPath: string
  logPath: string
  client: MeshClient
  stop(): Promise<void>
}

function relayEntry(): string {
  // dist/e2e/lib/relay.js → ../../../.. = packages/
  const p = path.resolve(__dirname, "../../../../relay/dist/index.js")
  if (!fs.existsSync(p)) throw new Error(`relay 未构建：${p}（先跑 pnpm --filter @cc-mesh/relay build）`)
  return p
}

export async function startPrivateRelay(): Promise<PrivateRelay> {
  const port = await freePort()
  if (port === 19800) throw new Error("拒绝使用生产端口 19800")
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-e2e-relay-"))
  const dbPath = path.join(home, "mesh.db")
  const logPath = path.join(home, "relay.log")
  const logFd = fs.openSync(logPath, "a")

  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.MESH_HUB_URL
  delete env.MESH_NODE
  delete env.MESH_DELEGATOR_NODE
  env.HOME = home
  env.MESH_DB_PATH = dbPath
  env.MESH_DEVICE_ID = E2E_DEVICE_ID
  env.RELAY_HTTP_PORT = String(port)

  const child: ChildProcess = spawn(process.execPath, [relayEntry()], {
    env, stdio: ["ignore", logFd, logFd], detached: false,
  })
  const url = `http://127.0.0.1:${port}`
  const client = new MeshClient(url)
  try {
    await waitFor(async () => {
      if (child.exitCode != null) throw new Error(`relay 提前退出 code=${child.exitCode}\n${fs.readFileSync(logPath, "utf8")}`)
      try { await client.nodes(); return true } catch { return false }
    }, 20_000, "私有 relay 起来")
  } catch (err) {
    child.kill("SIGKILL")
    throw err
  }

  return {
    url, port, home, dbPath, logPath, client,
    async stop() {
      child.kill("SIGTERM")
      const t0 = Date.now()
      while (child.exitCode == null && Date.now() - t0 < 3000) await sleep(50)
      if (child.exitCode == null) child.kill("SIGKILL")
      try { fs.closeSync(logFd) } catch { /* ignore */ }
    },
  }
}
