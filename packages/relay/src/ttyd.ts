/**
 * TtydManager — 按需 spawn ttyd 进程为每个 tmux session 提供 Web 终端
 *
 * 端口分配：7681 + hash(sessionId) % 1000，确定性函数
 * 启动命令：ttyd -W -p <port> tmux attach -t <sessionId>
 */
import { spawn as defaultSpawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"

export interface SpawnLike {
  (cmd: string, args: string[], opts?: any): ChildProcess
}

export interface TtydManagerOptions {
  spawnFn?: SpawnLike
  ttydBin?: string
}

interface Entry {
  port: number
  child: ChildProcess
}

export function portForSession(sessionId: string): number {
  const h = createHash("md5").update(sessionId).digest("hex").slice(0, 4)
  return 7681 + (parseInt(h, 16) % 1000)
}

export class TtydManager {
  private entries = new Map<string, Entry>()
  private spawnFn: SpawnLike
  private ttydBin: string

  constructor(opts: TtydManagerOptions = {}) {
    this.spawnFn = opts.spawnFn ?? (defaultSpawn as unknown as SpawnLike)
    this.ttydBin = opts.ttydBin ?? "ttyd"
  }

  async start(sessionId: string): Promise<number> {
    const existing = this.entries.get(sessionId)
    if (existing) return existing.port

    const port = portForSession(sessionId)
    const args = ["-W", "-p", String(port), "tmux", "attach", "-t", sessionId]
    const child = this.spawnFn(this.ttydBin, args, {
      detached: true,
      stdio: "ignore",
    })
    child.unref?.()
    this.entries.set(sessionId, { port, child })
    // 等 ttyd listen 就绪（避免 iframe 请求时 ttyd 还没 bind 端口）
    await new Promise((r) => setTimeout(r, 500))
    return port
  }

  async stop(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.entries.delete(sessionId)
    try { entry.child.kill("SIGTERM") } catch {}
  }

  getPort(sessionId: string): number | null {
    return this.entries.get(sessionId)?.port ?? null
  }

  async shutdown(): Promise<void> {
    const sids = [...this.entries.keys()]
    for (const sid of sids) await this.stop(sid)
  }
}
