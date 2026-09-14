#!/usr/bin/env node
// e2e 用的席位子进程入口（Lane C 的正式 CLI 落地前，e2e 自己有一个最小的 run 入口）。
//
// 为什么必须是**子进程**：E03/E04 要 kill -9 席位再拉起来验 WAL 恢复与 thread 续接——
// 在同进程里 mock 一个「崩溃」证明不了任何东西（进程没死，内存状态还在）。
//
// env：
//   CODEX_SEAT_HOME           席位私有 HOME（seatPaths 的根）
//   CODEX_SEAT_NAME           席位名
//   CODEX_SEAT_ENGINE         real | fake（fake = Lane A 的 FakeAppServerClient）
//   CODEX_SEAT_FAKE_SCENARIO  Lane A 剧本（内联 JSON 或路径）
//   CODEX_SEAT_ALLOW_FAULTS / CODEX_SEAT_FAULT   故障注入

import fs from "node:fs"
import path from "node:path"

import { FakeAppServerClient, RealAppServerClient, loadScenario } from "../../src/app-server/index.js"
import { activeFaults, seatPaths, type IAppServerClient } from "../../src/contracts.js"
import { loadSeatConfig } from "../../src/seat/config.js"
import { runSeat } from "../../src/seat/seat.js"

async function main(): Promise<void> {
  const home = process.env.CODEX_SEAT_HOME
  const seat = process.env.CODEX_SEAT_NAME
  if (!home || !seat) throw new Error("CODEX_SEAT_HOME / CODEX_SEAT_NAME 必填")
  const paths = seatPaths(seat, home)
  const config = loadSeatConfig(paths.config)
  if (!config) throw new Error(`config 读不到：${paths.config}`)

  const kind = process.env.CODEX_SEAT_ENGINE ?? "real"
  const faults = activeFaults(process.env)
  let engine: IAppServerClient
  if (kind === "fake") {
    engine = new FakeAppServerClient({ scenario: loadScenario(process.env), faults })
  } else {
    engine = new RealAppServerClient({
      cwd: config.cwd,
      bin: config.codex.bin,
      codexHome: config.codex.home,
      extraArgs: config.codex.extraArgs,
      pidFile: paths.appServerPid,
      stderrLogPath: paths.appServerStderrLog,
      // 标签必须带：E08 的孤儿谓词按 codex_seat.tag="<seat>/ 前缀认人
      seat,
      env: process.env,
      faults,
    })
  }

  // 事件计数：证据里的「它真跑了」三证据之一，必须来自引擎真的发过的通知。
  const events: Record<string, number> = {}
  const eventsFile = path.join(paths.home, "e2e-events.json")
  const flush = (): void => {
    try { fs.writeFileSync(eventsFile, JSON.stringify(events)) } catch { /* ignore */ }
  }
  engine.onEvent((ev) => {
    events[ev.type] = (events[ev.type] ?? 0) + 1
    // E16 要断言的是「未知 ServerRequest 被默认分支回了 -32601」，光数 server.request 不够。
    if (ev.type === "server.request") {
      const k = `server.request:${ev.replied}`
      events[k] = (events[k] ?? 0) + 1
    }
    // 每条事件都落盘：case 常常在终态回执到手后 10ms 内就读这个文件，
    // 攒到定时器再写会让断言读到旧计数（这就是「测不到东西的测试」的经典成因）。
    flush()
  })

  const handle = await runSeat(config, { engine, env: process.env, homeDir: home, installSignalHandlers: true })
  const info = engine.info()
  fs.writeFileSync(path.join(paths.home, "e2e-engine.json"), JSON.stringify({
    codexHome: info?.codexHome ?? null,
    codexVersion: info?.codexVersion ?? null,
    pid: info?.pid ?? null,
    pgid: info?.pgid ?? null,
  }))
  flush()
  process.stdout.write(`${JSON.stringify({ e2e: "ready", nodeId: handle.nodeId, instanceId: handle.instanceId, pid: process.pid })}\n`)

  process.on("exit", flush)
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ e2e: "fatal", error: String(err?.stack ?? err) })}\n`)
  process.exit(5)
})
