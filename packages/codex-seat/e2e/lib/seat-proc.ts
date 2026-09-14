// 被测席位的子进程管理：起 / 等 ready / kill -9 / 重启 / 读事件计数。
// cwd 一律用干净临时目录，HOME 也是临时的——绝不碰 ~/.ccmesh 下的真席位。

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { seatPaths, type SeatConfig, type SeatPaths, type StateFile } from "../../src/contracts.js"
import { resolveSeatConfig } from "../../src/seat/config.js"
import { hex, sleep, waitFor } from "./util.js"

export interface SeatProcOptions {
  relayUrl: string
  /** 缺省 e2e-<4hex> */
  seatName?: string
  engine?: "real" | "fake"
  scenario?: unknown
  faults?: string[]
  configPatch?: Partial<SeatConfig>
  /** 复用上一代的 HOME（重启场景） */
  home?: string
}

export interface SeatReady {
  nodeId: string
  instanceId: string
  pid: number
}

export class SeatProcess {
  readonly seat: string
  readonly home: string
  readonly cwd: string
  readonly paths: SeatPaths
  readonly config: SeatConfig
  private child: ChildProcess | null = null
  private stdout = ""
  private stderr = ""
  ready: SeatReady | null = null

  constructor(private readonly opts: SeatProcOptions) {
    this.seat = opts.seatName ?? `e2e-${hex(2)}`
    this.home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-e2e-home-"))
    this.cwd = path.join(this.home, "workdir")
    fs.mkdirSync(this.cwd, { recursive: true })
    this.paths = seatPaths(this.seat, this.home)
    fs.mkdirSync(this.paths.logDir, { recursive: true })
    this.config = resolveSeatConfig({
      seat: this.seat,
      cwd: this.cwd,
      relayUrl: opts.relayUrl,
      // e2e 默认不碰 Hub（E14 是 Lane C 的 case，它自己开）
      hub: { ledgerUrl: "http://127.0.0.1:1", tokenFile: path.join(this.home, "hub-token"), intervalSec: 300, enabled: false },
      allowlist: { extra: ["*:e2e-probe"], disableDefaults: true },
      // HOME 被换成 tmp 是为了隔离 ~/.ccmesh；但 codex 的凭据在**真** ~/.codex 里，
      // 不显式指回去，app-server 会拿一个空 codex_home 去连，表现是 401 + 一直没有 turn/completed。
      codex: { bin: null, home: path.join(os.homedir(), ".codex"), extraArgs: [] },
      sync: { timeoutSec: 5, limit: 100 },
      ...opts.configPatch,
    })
    fs.writeFileSync(this.paths.config, `${JSON.stringify(this.config, null, 2)}\n`)
  }

  get nodeId(): string {
    if (!this.ready) throw new Error("席位还没 ready")
    return this.ready.nodeId
  }

  private entry(): string {
    // dist/e2e/lib/seat-proc.js → 同目录的 seat-main.js
    return path.resolve(__dirname, "seat-main.js")
  }

  async start(extra: { faults?: string[]; engine?: SeatProcOptions["engine"]; scenario?: unknown } = {}): Promise<SeatReady> {
    if (this.child) throw new Error("席位已经在跑")
    const faults = extra.faults ?? this.opts.faults ?? []
    const engine = extra.engine ?? this.opts.engine ?? "real"
    const scenario = extra.scenario ?? this.opts.scenario

    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.MESH_NODE
    delete env.MESH_DELEGATOR_NODE
    // 红线护栏：模型在 worker 里跑 `mesh send` 时，mesh.sh 读的是 MESH_RELAY_URL——
    // 不显式指向私有 relay，它会打到生产 :19800。这一行是 E06 whoami 步骤的安全前提。
    env.MESH_RELAY_URL = this.opts.relayUrl
    env.HOME = this.home
    env.CODEX_SEAT_HOME = this.home
    env.CODEX_SEAT_NAME = this.seat
    env.CODEX_SEAT_ENGINE = engine
    if (scenario !== undefined) env.CODEX_SEAT_FAKE_SCENARIO = typeof scenario === "string" ? scenario : JSON.stringify(scenario)
    if (faults.length > 0) { env.CODEX_SEAT_ALLOW_FAULTS = "1"; env.CODEX_SEAT_FAULT = faults.join(",") }
    else { delete env.CODEX_SEAT_ALLOW_FAULTS; delete env.CODEX_SEAT_FAULT }

    this.stdout = ""
    this.stderr = ""
    const child = spawn(process.execPath, [this.entry()], { env, cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"] })
    this.child = child
    child.stdout?.on("data", (b: Buffer) => { this.stdout += b.toString() })
    child.stderr?.on("data", (b: Buffer) => { this.stderr += b.toString() })

    const ready = await waitFor(() => {
      if (child.exitCode != null) throw new Error(`席位提前退出 code=${child.exitCode}\nstdout:${this.stdout}\nstderr:${this.stderr}`)
      for (const line of this.stdout.split("\n")) {
        if (!line.trim()) continue
        try {
          const o = JSON.parse(line) as { e2e?: string } & SeatReady
          if (o.e2e === "ready") return o
        } catch { /* 非 JSON 行 */ }
      }
      return null
    }, 60_000, "席位 ready", 50)
    this.ready = { nodeId: ready.nodeId, instanceId: ready.instanceId, pid: ready.pid }
    return this.ready
  }

  /** SIGKILL：模拟席位被硬杀（E03/E04 的现场） */
  async kill9(): Promise<void> {
    if (!this.child) return
    this.child.kill("SIGKILL")
    const t0 = Date.now()
    while (this.child.exitCode == null && this.child.signalCode == null && Date.now() - t0 < 5000) await sleep(20)
    this.child = null
    this.ready = null
  }

  async stop(): Promise<void> {
    if (!this.child) return
    this.child.kill("SIGTERM")
    const t0 = Date.now()
    while (this.child.exitCode == null && this.child.signalCode == null && Date.now() - t0 < 8000) await sleep(20)
    if (this.child.exitCode == null && this.child.signalCode == null) this.child.kill("SIGKILL")
    this.child = null
    this.ready = null
  }

  /** 等子进程自己退出（故障注入的 exit 70/71） */
  async waitExit(timeoutMs: number): Promise<number | null> {
    const child = this.child
    if (!child) return null
    const code = await waitFor(() => (child.exitCode != null ? { code: child.exitCode } : null), timeoutMs, "席位自己退出", 20)
    this.child = null
    this.ready = null
    return code.code
  }

  events(): Record<string, number> {
    try { return JSON.parse(fs.readFileSync(path.join(this.paths.home, "e2e-events.json"), "utf8")) as Record<string, number> }
    catch { return {} }
  }

  engineInfo(): { codexHome: string | null; codexVersion: string | null; pid: number | null; pgid: number | null } {
    try { return JSON.parse(fs.readFileSync(path.join(this.paths.home, "e2e-engine.json"), "utf8")) }
    catch { return { codexHome: null, codexVersion: null, pid: null, pgid: null } }
  }

  state(): StateFile | null {
    try { return JSON.parse(fs.readFileSync(this.paths.state, "utf8")) as StateFile }
    catch { return null }
  }

  logLines(): Array<Record<string, unknown>> {
    try {
      return fs.readFileSync(this.paths.sidecarLog, "utf8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return { raw: l } } })
    } catch { return [] }
  }

  dump(): string {
    return `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`
  }
}
