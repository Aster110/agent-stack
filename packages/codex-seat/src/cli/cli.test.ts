/**
 * Lane C —— CLI 参数、配置、status 汇总（先红后绿）。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  SEAT_CONFIG_DEFAULTS,
  EXIT_CODES,
  seatPaths,
  seatNodeId,
  type StateFile,
  type WalEntry,
  type SeatConfig,
  type StatusReport,
} from "../contracts.js"
import { parseCli } from "./args.js"
import { main } from "./main.js"
import { defaultSeatConfig, validateSeatConfig } from "./config.js"
import {
  walCounts,
  threadsFromState,
  statusExitCode,
  formatStatusTable,
  buildStatusReport,
} from "./status.js"

describe("CLI 参数", () => {
  it("五个命令都认得", () => {
    for (const c of ["init", "install", "uninstall", "status", "run"]) {
      const r = parseCli([c, "--seat", "codex-main"])
      assert.equal(r.ok, true, `${c} 应该被认出来`)
      if (r.ok) assert.equal(r.cmd.cmd, c)
    }
  })

  it("缺 --seat 报 usage 而不是默默用默认值", () => {
    const r = parseCli(["status"])
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.exitCode, EXIT_CODES.usage)
  })

  it("席位名非法（大写/超长/斜杠）一律拒", () => {
    for (const bad of ["Codex-Main", "a/b", "x".repeat(33), "-lead"]) {
      assert.equal(parseCli(["status", "--seat", bad]).ok, false, `${bad} 不该通过`)
    }
  })

  it("--json / --dry-run / --force / --cwd / --config 都解析得出", () => {
    const s = parseCli(["status", "--seat", "s", "--json", "--config", "/tmp/c.json"])
    assert.equal(s.ok, true)
    if (s.ok) {
      assert.deepEqual(s.cmd, { cmd: "status", seat: "s", json: true })
      assert.equal(s.configPath, "/tmp/c.json")
    }
    const i = parseCli(["init", "--seat", "s", "--cwd", "/tmp/x", "--force"])
    assert.equal(i.ok, true)
    if (i.ok) assert.deepEqual(i.cmd, { cmd: "init", seat: "s", cwd: "/tmp/x", force: true })
    const ins = parseCli(["install", "--seat", "s", "--dry-run"])
    assert.equal(ins.ok, true)
    if (ins.ok) assert.deepEqual(ins.cmd, { cmd: "install", seat: "s", dryRun: true })
  })

  it("--cwd 必须绝对路径", () => {
    assert.equal(parseCli(["init", "--seat", "s", "--cwd", "rel/path"]).ok, false)
  })

  it("未知命令 / 未知 flag 报 usage", () => {
    assert.equal(parseCli(["frobnicate"]).ok, false)
    assert.equal(parseCli(["status", "--seat", "s", "--yolo"]).ok, false)
  })

  it("help 与空参数都给 help", () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      const r = parseCli(argv)
      assert.equal(r.ok, true)
      if (r.ok) assert.equal(r.cmd.cmd, "help")
    }
  })
})

describe("默认配置", () => {
  it("与 SEAT_CONFIG_DEFAULTS 完全一致，只补 seat/cwd", () => {
    const c = defaultSeatConfig("codex-main", "/Users/example/workspace/project")
    assert.equal(c.seat, "codex-main")
    assert.equal(c.cwd, "/Users/example/workspace/project")
    assert.equal(c.relayUrl, SEAT_CONFIG_DEFAULTS.relayUrl)
    assert.equal(c.hub.intervalSec, SEAT_CONFIG_DEFAULTS.hub.intervalSec)
    assert.equal(c.worker.procMode, SEAT_CONFIG_DEFAULTS.worker.procMode)
    assert.equal(c.compact.thresholdRatio, SEAT_CONFIG_DEFAULTS.compact.thresholdRatio)
  })

  it("默认配置里没有任何 token 明文，tokenFile 只是路径", () => {
    const c = defaultSeatConfig("s", "/tmp")
    const json = JSON.stringify(c)
    assert.equal(/Bearer|sk-|hub-token"\s*:\s*"[^"]{20,}/.test(json), false)
    assert.equal(c.hub.tokenFile.endsWith("hub-token"), true)
  })

  it("默认配置**不再**往 extraArgs 里塞席位标签（改由引擎层 spawn 时统一打）", () => {
    // 老办法（写进 config.codex.extraArgs）只覆盖「读了 config.json」这一条路径，
    // e2e / 直接 new RealAppServerClient 的路径全漏。现在标签在 buildAppServerArgs 里，
    // 恒为 codex_seat.tag="<seat>/<instanceId>"，见 src/proc/spawn.test.ts。
    const c = defaultSeatConfig("codex-main", "/tmp")
    assert.deepEqual(c.codex.extraArgs, [])
  })

  it("两个席位的默认配置互不共享对象（深拷贝）", () => {
    const a = defaultSeatConfig("server", "/tmp")
    const b = defaultSeatConfig("s2", "/tmp")
    a.hub.enabled = false
    assert.equal(b.hub.enabled, true)
    a.codex.extraArgs.push("-c", "x=1")
    assert.deepEqual(b.codex.extraArgs, [], "两份配置不能共用同一个 extraArgs 数组")
  })

  it("默认配置能过校验", () => {
    const r = validateSeatConfig(defaultSeatConfig("s", "/tmp"))
    assert.equal(r.ok, true)
  })

  it("校验挑得出坏字段", () => {
    const bad = { ...defaultSeatConfig("s", "/tmp"), relayUrl: "notaurl", cwd: "rel" } as unknown
    const r = validateSeatConfig(bad)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.errors.length >= 2, true)
      assert.equal(r.errors.some((e) => e.includes("relayUrl")), true)
      assert.equal(r.errors.some((e) => e.includes("cwd")), true)
    }
  })

  it("席位名与文件名不一致要报错（防 install 装错席位）", () => {
    const c = defaultSeatConfig("codex-main", "/tmp")
    const r = validateSeatConfig(c, "other-seat")
    assert.equal(r.ok, false)
  })
})

describe("WAL 统计", () => {
  const mk = (op: WalEntry["op"], msgId: string, seq: number): WalEntry => ({
    op, msgId, seq, to: "d:s", from: "d:p", nonce: "n1234", at: new Date().toISOString(),
  })

  it("按折叠相位计数，不是按事件条数", () => {
    const entries: WalEntry[] = [
      mk("fetched", "m1", 1), mk("started", "m1", 1), mk("completed", "m1", 1), mk("receipted", "m1", 1),
      mk("fetched", "m2", 2), mk("started", "m2", 2),
      mk("fetched", "m3", 3),
    ]
    assert.deepEqual(walCounts(entries), { fetched: 1, started: 1, completed: 0 })
  })

  it("空 WAL 全 0", () => {
    assert.deepEqual(walCounts([]), { fetched: 0, started: 0, completed: 0 })
  })
})

describe("state → threads 视图", () => {
  const state: StateFile = {
    version: 1, contractVersion: "1", seat: "s", nodeId: "dev:s", deviceId: "dev",
    mainThreadId: "th-main", workers: {
      "dev:cx-1a2b": {
        nodeId: "dev:cx-1a2b", threadId: "th-w1", role: "worker", delegator: "server:brain",
        cwd: "/tmp", createdAt: "2026-09-02T00:00:00.000Z", procKind: "shared", agent: "codex", cursor: 0,
      },
    },
    cursor: 7, cursorAnchoredAt: null, cursorAnchorSeq: null, paused: null,
    instanceId: "inst1", createdAt: "2026-09-02T00:00:00.000Z", startedAt: "2026-09-02T00:00:00.000Z",
    lastSeenAt: null, lastDoneAt: null, recentMsgIds: [], codexVersion: null, engine: null,
    resumableThreads: ["th-main", "th-w1"],
  }

  it("席位排第一，worker 跟后面", () => {
    const t = threadsFromState(state)
    assert.equal(t[0]!.kind, "seat")
    assert.equal(t[0]!.threadId, "th-main")
    assert.equal(t[1]!.kind, "worker")
    assert.equal(t[1]!.nodeId, "dev:cx-1a2b")
  })
})

describe("status 退出码（契约 EXIT_CODES）", () => {
  const base = (): StatusReport => ({
    seat: "s", nodeId: "dev:s", instanceId: "i", contractVersion: "1", codexVersion: "1.0",
    sidecar: { pid: 1234, alive: true, supervised: "launchd", supervisorLoaded: true },
    engine: { pid: 4321, pgid: 4321, alive: true, startedAt: null },
    threads: [], relay: { url: "http://127.0.0.1:19800", registered: true, lastSyncAt: null, cursor: 0, anchoredAt: null },
    wal: { fetched: 0, started: 0, completed: 0 }, rateLimits: null,
    hub: { lastOkAt: null, stale: false, lastError: null }, orphans: [], faults: [],
    lastSeenAt: null, lastDoneAt: null, paused: null,
  })

  it("全健康 = 0", () => assert.equal(statusExitCode(base()), EXIT_CODES.ok))
  it("relay 不可达 = 4（优先于引擎）", () => {
    const r = base(); r.relay.registered = false; r.engine.alive = false
    assert.equal(statusExitCode(r), EXIT_CODES.relayUnreachable)
  })
  it("引擎不健康 = 5", () => {
    const r = base(); r.engine.alive = false
    assert.equal(statusExitCode(r), EXIT_CODES.engineFailed)
  })
  it("sidecar 死了也算引擎不健康", () => {
    const r = base(); r.sidecar.alive = false
    assert.equal(statusExitCode(r), EXIT_CODES.engineFailed)
  })
})

describe("status 人读表", () => {
  it("关键字段都在，且不打印任何 token", () => {
    const r: StatusReport = {
      seat: "codex-main", nodeId: "dev:codex-main", instanceId: "inst-7", contractVersion: "1",
      codexVersion: "codex-cli 0.151.0",
      sidecar: { pid: 111, alive: true, supervised: "launchd", supervisorLoaded: true },
      engine: { pid: 222, pgid: 222, alive: true, startedAt: "2026-09-02T00:00:00.000Z" },
      threads: [{ nodeId: "dev:codex-main", threadId: "th-1", kind: "seat", activeTurn: null, lastDoneAt: null }],
      relay: { url: "http://127.0.0.1:19800", registered: true, lastSyncAt: "2026-09-02T00:00:01.000Z", cursor: 12, anchoredAt: null },
      wal: { fetched: 1, started: 0, completed: 0 },
      rateLimits: null,
      hub: { lastOkAt: "2026-09-02T00:00:02.000Z", stale: false, lastError: null },
      orphans: [{ pid: 999, pgid: 999, cmd: "codex app-server" }],
      faults: [], lastSeenAt: null, lastDoneAt: null, paused: null,
    }
    const s = formatStatusTable(r)
    for (const must of ["codex-main", "dev:codex-main", "inst-7", "th-1", "19800", "999"]) {
      assert.equal(s.includes(must), true, `表里缺 ${must}`)
    }
    assert.equal(/Bearer|hub-token|sk-[A-Za-z0-9]/.test(s), false)
  })

  it("有孤儿要显眼（不是藏在 --json 里）", () => {
    const r: StatusReport = {
      seat: "s", nodeId: "d:s", instanceId: null, contractVersion: "1", codexVersion: null,
      sidecar: { pid: null, alive: false, supervised: "none", supervisorLoaded: false },
      engine: { pid: null, pgid: null, alive: false, startedAt: null }, threads: [],
      relay: { url: "u", registered: false, lastSyncAt: null, cursor: 0, anchoredAt: null },
      wal: { fetched: 0, started: 0, completed: 0 }, rateLimits: null,
      hub: { lastOkAt: null, stale: true, lastError: "connect ECONNREFUSED" },
      orphans: [{ pid: 5, pgid: 5, cmd: "x" }, { pid: 6, pgid: 6, cmd: "y" }], faults: [],
      lastSeenAt: null, lastDoneAt: null, paused: null,
    }
    assert.match(formatStatusTable(r), /orphans\s*\|\s*2/i)
  })
})

describe("buildStatusReport（注入依赖，不碰真 relay）", () => {
  const cfg: SeatConfig = defaultSeatConfig("e2e-test", "/tmp")

  it("relay 打不通时 registered=false 而不是抛", async () => {
    const home = path.join(os.tmpdir(), "codex-seat-status-test")
    const r = await buildStatusReport({
      seat: "e2e-test",
      homeDir: home,
      config: cfg,
      fetchJson: async () => { throw new Error("ECONNREFUSED") },
      ops: {
        isAlive: () => false, cmdline: () => null, kill: () => {},
        pgidOf: () => null, list: () => [], killGroup: () => {}, groupPids: () => [],
      },
      platform: "darwin",
      supervisorLoaded: () => false,
    })
    assert.equal(r.relay.registered, false)
    assert.equal(r.seat, "e2e-test")
    assert.equal(r.nodeId.endsWith(":e2e-test"), true)
  })

  it("relay 有该节点时 registered=true 且抄回 lastSyncAt", async () => {
    const nodeId = seatNodeId("e2edev", "e2e-test")
    const r = await buildStatusReport({
      seat: "e2e-test",
      homeDir: seatPaths("e2e-test", os.tmpdir()).home,
      config: cfg,
      deviceId: "e2edev",
      fetchJson: async () => ({
        ok: true,
        data: { nodes: [{ identity: { nodeId, shortId: "e2e-test", role: "worker", description: "", deliveryMode: "pull" }, pid: 1, status: "idle", lastSyncAt: "2026-09-02T00:00:00.000Z" }] },
      }),
      ops: {
        isAlive: () => false, cmdline: () => null, kill: () => {},
        pgidOf: () => null, list: () => [], killGroup: () => {}, groupPids: () => [],
      },
      platform: "darwin",
      supervisorLoaded: () => true,
    })
    assert.equal(r.relay.registered, true)
    assert.equal(r.relay.lastSyncAt, "2026-09-02T00:00:00.000Z")
    assert.equal(r.sidecar.supervisorLoaded, true)
  })
})

describe("resume-cursor（重放风暴熔断后的人工解锁）", () => {
  it("--to head / --to <seq> 都解析得出", () => {
    const a = parseCli(["resume-cursor", "--seat", "codex-main", "--to", "head"])
    assert.equal(a.ok, true)
    if (a.ok) assert.deepEqual(a.cmd, { cmd: "resume-cursor", seat: "codex-main", to: "head", force: false })
    const b = parseCli(["resume-cursor", "--seat", "codex-main", "--to", "1364", "--force"])
    assert.equal(b.ok, true)
    if (b.ok) assert.deepEqual(b.cmd, { cmd: "resume-cursor", seat: "codex-main", to: 1364, force: true })
  })

  it("缺 --to / --to 不是 head 也不是非负整数 → usage 错", () => {
    for (const argv of [
      ["resume-cursor", "--seat", "s"],
      ["resume-cursor", "--seat", "s", "--to", "tail"],
      ["resume-cursor", "--seat", "s", "--to", "-1"],
      ["resume-cursor", "--seat", "s", "--to", "1.5"],
    ]) {
      const r = parseCli(argv)
      assert.equal(r.ok, false, `${argv.join(" ")} 不该通过`)
      if (!r.ok) assert.equal(r.exitCode, EXIT_CODES.usage)
    }
  })
})

describe("配置里的三个防重放开关", () => {
  it("默认值：replayHistory=false / acceptMessagesOlderThanSeat=false / replayStormThreshold=20", () => {
    const c = defaultSeatConfig("codex-main", "/tmp")
    assert.equal(c.sync.replayHistory, false)
    assert.equal(c.sync.acceptMessagesOlderThanSeat, false)
    assert.equal(c.sync.replayStormThreshold, 20)
    assert.equal(validateSeatConfig(c, "codex-main").ok, true)
  })

  it("老 config.json 缺这三个键照样通过校验（升级不该让现役席位起不来）", () => {
    const c: any = defaultSeatConfig("codex-main", "/tmp")
    delete c.sync.replayHistory
    delete c.sync.acceptMessagesOlderThanSeat
    delete c.sync.replayStormThreshold
    assert.equal(validateSeatConfig(c, "codex-main").ok, true)
  })

  it("类型写错要被挑出来（true 写成字符串、阈值写成 0）", () => {
    const bad: any = defaultSeatConfig("codex-main", "/tmp")
    bad.sync.replayHistory = "yes"
    assert.equal(validateSeatConfig(bad, "codex-main").ok, false)
    const bad2: any = defaultSeatConfig("codex-main", "/tmp")
    bad2.sync.replayStormThreshold = 0
    assert.equal(validateSeatConfig(bad2, "codex-main").ok, false)
  })
})

describe("熔断状态在 status 里看得见", () => {
  const paused = (): StatusReport => ({
    seat: "codex-main", nodeId: "dev:codex-main", instanceId: "i", contractVersion: "3", codexVersion: null,
    sidecar: { pid: 1, alive: true, supervised: "launchd", supervisorLoaded: true },
    engine: { pid: 2, pgid: 2, alive: true, startedAt: null },
    threads: [],
    relay: { url: "http://127.0.0.1:19800", registered: true, lastSyncAt: null, cursor: 0, anchoredAt: null },
    wal: { fetched: 0, started: 0, completed: 0 }, rateLimits: null,
    hub: { lastOkAt: null, stale: false, lastError: null }, orphans: [], faults: [],
    lastSeenAt: null, lastDoneAt: null,
    paused: { reason: "replay-storm", at: "2026-09-02T18:29:46.000Z", nodeId: "dev:codex-main", batchSize: 263, staleCount: 263, observedNextSince: 1364 },
  })

  it("人读表里能一眼看到 paused-replay-storm 和解锁命令", () => {
    const s = formatStatusTable(paused())
    assert.match(s, /paused-replay-storm/)
    assert.match(s, /resume-cursor/)
    assert.equal(s.includes("263"), true)
  })

  it("熔断的席位退出码不是 0（否则脚本会以为它好着）", () => {
    assert.notEqual(statusExitCode(paused()), EXIT_CODES.ok)
    assert.equal(statusExitCode(paused()), EXIT_CODES.pausedReplayStorm)
  })
})

describe("resume-cursor / init 真的动得了盘上的文件（走 main()，不是只测参数解析）", () => {
  const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-cli-"))
    const prev = process.env.HOME
    process.env.HOME = home // seatPaths → os.homedir() → POSIX 下读 $HOME
    try { await fn(home) } finally { if (prev == null) delete process.env.HOME; else process.env.HOME = prev }
  }

  const seedSeat = (home: string, seat: string, state: Partial<StateFile>): ReturnType<typeof seatPaths> => {
    const p = seatPaths(seat, home)
    fs.mkdirSync(p.logDir, { recursive: true })
    fs.writeFileSync(p.config, JSON.stringify(defaultSeatConfig(seat, os.tmpdir()), null, 2))
    const st: StateFile = {
      version: 1, contractVersion: "3", seat, nodeId: `dev:${seat}`, deviceId: "dev",
      mainThreadId: null, workers: {}, cursor: 0, createdAt: "2026-09-02T18:29:24.000Z",
      cursorAnchoredAt: null, cursorAnchorSeq: null, paused: null,
      instanceId: "i", startedAt: "2026-09-02T18:29:24.000Z", lastSeenAt: null, lastDoneAt: null,
      recentMsgIds: [], codexVersion: null, engine: null, resumableThreads: [], ...state,
    }
    fs.writeFileSync(p.state, JSON.stringify(st, null, 2))
    return p
  }

  it("熔断后 --to <seq>：sidecar 活着时拒改，停了才顶游标、清 paused", async () => {
    // 注入：把「sidecar 活着就拒绝」那道拦去掉 → 第一次调用就会改盘 → 第一组断言红
    await withTempHome(async (home) => {
      const seat = "e2e-rc01"
      const p = seedSeat(home, seat, {
        cursor: 0,
        paused: { reason: "replay-storm", at: "2026-09-02T18:29:46.000Z", nodeId: `dev:${seat}`, batchSize: 263, staleCount: 263, observedNextSince: 1364 },
      })
      const read = (): StateFile => JSON.parse(fs.readFileSync(p.state, "utf8")) as StateFile

      // sidecar「活着」：用本测试进程自己的 pid（它当然活着）
      fs.writeFileSync(p.sidecarPid, JSON.stringify({ pid: process.pid, pgid: process.pid, startedAt: "", cmdline: "node", instanceId: "i" }))
      assert.equal(await main(["resume-cursor", "--seat", seat, "--to", "1364"]), EXIT_CODES.usage)
      assert.equal(read().cursor, 0, "sidecar 还在跑就改 state.json = 掷骰子，必须拒绝")
      assert.ok(read().paused, "拒绝时 paused 也不该被清")

      // 停了 sidecar 再来
      fs.rmSync(p.sidecarPid)
      assert.equal(await main(["resume-cursor", "--seat", seat, "--to", "1364"]), EXIT_CODES.ok)
      const after = read()
      assert.equal(after.cursor, 1364)
      assert.equal(after.cursorAnchorSeq, 1364)
      assert.ok(after.cursorAnchoredAt)
      assert.equal(after.paused, null)
      assert.equal(after.mainThreadId, null, "只动游标与 paused，别顺手清别的")
    })
  })

  it("--to head 且 relay 不可达 → 退 4，state.json 一个字节都不许改", async () => {
    await withTempHome(async (home) => {
      const seat = "e2e-rc02"
      const p = seedSeat(home, seat, { cursor: 7 })
      // 默认 config 指向 127.0.0.1:19800（生产口）——本测试**不发请求到那儿**是靠 relay 不可达吗？
      // 不是：显式改成一个必然拒绝连接的端口，绝不碰 19800。
      const cfg = JSON.parse(fs.readFileSync(p.config, "utf8"))
      cfg.relayUrl = "http://127.0.0.1:1"
      fs.writeFileSync(p.config, JSON.stringify(cfg, null, 2))
      const before = fs.readFileSync(p.state, "utf8")
      assert.equal(await main(["resume-cursor", "--seat", seat, "--to", "head"]), EXIT_CODES.relayUnreachable)
      assert.equal(fs.readFileSync(p.state, "utf8"), before)
    })
  })

  it("init 写出来的 state.json 是 cursor=null（未锚定），且不覆盖已有的", async () => {
    // 注入：把 init 里的 initialState 换成 `{...initialState(), cursor: 0}` → 第一组断言红（那就是事故当天的行为）
    await withTempHome(async (home) => {
      const seat = "e2e-rc03"
      assert.equal(await main(["init", "--seat", seat, "--cwd", os.tmpdir()]), EXIT_CODES.ok)
      const p = seatPaths(seat, home)
      const st = JSON.parse(fs.readFileSync(p.state, "utf8")) as StateFile
      assert.equal(st.cursor, null, "init 写 0 就是把「重放全部历史」写进了默认路径")
      assert.equal(st.cursorAnchoredAt, null)
      assert.ok(st.createdAt)

      // 已有 state.json（承重：游标 + 主 thread）→ 即使 --force 也只覆盖 config
      st.cursor = 1364
      st.mainThreadId = "th-old"
      fs.writeFileSync(p.state, JSON.stringify(st, null, 2))
      assert.equal(await main(["init", "--seat", seat, "--cwd", os.tmpdir(), "--force"]), EXIT_CODES.ok)
      const after = JSON.parse(fs.readFileSync(p.state, "utf8")) as StateFile
      assert.equal(after.cursor, 1364)
      assert.equal(after.mainThreadId, "th-old")
    })
  })
})
