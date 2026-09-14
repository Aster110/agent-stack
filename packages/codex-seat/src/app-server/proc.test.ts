/**
 * 进程工具：二进制解析（绝不走 shell）、pid 文件（带 cmdline 防复用误杀）、进程组收尸。
 *
 * 已知坑（本文件就是为它写的）：`/opt/homebrew/bin/codex` 是 node wrapper，
 * 只杀 wrapper 会留下 ppid=1 的 rust 孤儿；所以清理一律 `kill(-pgid)`。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { CODEX_BIN_FALLBACK } from "../contracts.js"
import {
  type ProcOps,
  clearPidFile,
  killOrphanFromPidFile,
  readPidFile,
  resolveCodexBin,
  writePidFile,
} from "./proc.js"

function tmpdir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codex-seat-${tag}-`))
}

function fakeOps(init: {
  alive: Set<number>
  cmdlines?: Record<number, string>
  pgids?: Record<number, number>
  dieOn?: NodeJS.Signals
}): ProcOps & { calls: Array<{ fn: string; pid: number; signal?: string }> } {
  const calls: Array<{ fn: string; pid: number; signal?: string }> = []
  return {
    calls,
    isAlive: (pid) => init.alive.has(pid),
    cmdline: (pid) => init.cmdlines?.[pid] ?? null,
    pgid: (pid) => init.pgids?.[pid] ?? pid,
    kill(pid, signal) {
      calls.push({ fn: "kill", pid, signal })
      if (!init.dieOn || init.dieOn === signal) init.alive.delete(pid)
    },
    killGroup(pgid, signal) {
      calls.push({ fn: "killGroup", pid: pgid, signal })
      if (!init.dieOn || init.dieOn === signal) init.alive.delete(pgid)
    },
  }
}

describe("resolveCodexBin", () => {
  it("显式配置的 bin 最优先", () => {
    const r = resolveCodexBin({ configBin: "/opt/custom/codex", env: { PATH: "/nonexistent" } })
    assert.deepEqual(r, { bin: "/opt/custom/codex", source: "config" })
  })

  it("PATH 里找 codex：找到的是**文件绝对路径**，不是 shell 函数名", () => {
    const dir = tmpdir("path")
    const bin = path.join(dir, "codex")
    fs.writeFileSync(bin, "#!/bin/sh\necho hi\n", { mode: 0o755 })
    const r = resolveCodexBin({ configBin: null, env: { PATH: `${dir}:/nonexistent` } })
    assert.deepEqual(r, { bin, source: "path" })
    // 交互 shell 里的 `codex` 是个会 cd 的函数；解析结果必须是真实存在的可执行文件
    assert.equal(path.isAbsolute(r.bin), true)
    assert.equal(fs.statSync(r.bin).isFile(), true)
  })

  it("PATH 里不可执行的同名文件跳过", () => {
    const dir = tmpdir("noexec")
    fs.writeFileSync(path.join(dir, "codex"), "x", { mode: 0o644 })
    const r = resolveCodexBin({ configBin: null, env: { PATH: dir } })
    assert.equal(r.source, "fallback")
  })

  it("PATH 里同名目录跳过", () => {
    const dir = tmpdir("isdir")
    fs.mkdirSync(path.join(dir, "codex"))
    const r = resolveCodexBin({ configBin: null, env: { PATH: dir } })
    assert.equal(r.source, "fallback")
  })

  it("都找不到 → ChatGPT.app 内置兜底", () => {
    const r = resolveCodexBin({ configBin: null, env: { PATH: "/nonexistent-a:/nonexistent-b" } })
    assert.deepEqual(r, { bin: CODEX_BIN_FALLBACK, source: "fallback" })
  })

  it("PATH 缺席也不炸", () => {
    const r = resolveCodexBin({ configBin: null, env: {} })
    assert.equal(r.source, "fallback")
  })

  it("PATH 里前面的目录赢", () => {
    const a = tmpdir("first")
    const b = tmpdir("second")
    fs.writeFileSync(path.join(a, "codex"), "#!/bin/sh\n", { mode: 0o755 })
    fs.writeFileSync(path.join(b, "codex"), "#!/bin/sh\n", { mode: 0o755 })
    const r = resolveCodexBin({ configBin: null, env: { PATH: `${a}:${b}` } })
    assert.equal(r.bin, path.join(a, "codex"))
  })
})

describe("pid 文件", () => {
  it("写—读往返，权限 0600", () => {
    const dir = tmpdir("pidfile")
    const file = path.join(dir, "app-server.pid")
    const rec = { pid: 4242, pgid: 4242, startedAt: "2026-09-02T00:00:00.000Z", cmdline: "node codex app-server", instanceId: "inst-1" }
    writePidFile(file, rec)
    assert.deepEqual(readPidFile(file), rec)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  it("目录不存在时自建（0700）", () => {
    const dir = tmpdir("pidfile-mk")
    const file = path.join(dir, "deep", "nest", "app-server.pid")
    writePidFile(file, { pid: 1, pgid: 1, startedAt: "x", cmdline: "c", instanceId: null })
    assert.equal(fs.existsSync(file), true)
  })

  it("坏内容读成 null，不抛", () => {
    const dir = tmpdir("pidfile-bad")
    const file = path.join(dir, "app-server.pid")
    fs.writeFileSync(file, "not json")
    assert.equal(readPidFile(file), null)
    assert.equal(readPidFile(path.join(dir, "missing.pid")), null)
  })

  it("clear 幂等", () => {
    const dir = tmpdir("pidfile-clear")
    const file = path.join(dir, "app-server.pid")
    writePidFile(file, { pid: 1, pgid: 1, startedAt: "x", cmdline: "c", instanceId: null })
    clearPidFile(file)
    clearPidFile(file)
    assert.equal(fs.existsSync(file), false)
  })
})

describe("killOrphanFromPidFile", () => {
  const sleep = async () => {}

  it("没有 pid 文件 = 什么都不做", async () => {
    const dir = tmpdir("orphan-none")
    const r = await killOrphanFromPidFile({ file: path.join(dir, "x.pid"), procOps: fakeOps({ alive: new Set() }), sleep })
    assert.equal(r.action, "no-pid-file")
  })

  it("进程已经死了 = 只清文件，不发信号", async () => {
    const dir = tmpdir("orphan-dead")
    const file = path.join(dir, "x.pid")
    writePidFile(file, { pid: 999_001, pgid: 999_001, startedAt: "x", cmdline: "codex app-server", instanceId: null })
    const ops = fakeOps({ alive: new Set() })
    const r = await killOrphanFromPidFile({ file, procOps: ops, sleep })
    assert.equal(r.action, "dead")
    assert.deepEqual(ops.calls, [])
    assert.equal(fs.existsSync(file), false)
  })

  it("pid 复用防误杀：cmdline 不含 app-server 就绝不动它", async () => {
    const dir = tmpdir("orphan-reuse")
    const file = path.join(dir, "x.pid")
    writePidFile(file, { pid: 999_002, pgid: 999_002, startedAt: "x", cmdline: "codex app-server", instanceId: null })
    const ops = fakeOps({ alive: new Set([999_002]), cmdlines: { 999_002: "/usr/sbin/cupsd -l" } })
    const r = await killOrphanFromPidFile({ file, procOps: ops, sleep })
    assert.equal(r.action, "cmdline-mismatch")
    assert.deepEqual(ops.calls, [], "一个信号都不许发")
    assert.equal(fs.existsSync(file), false)
  })

  it("活着且是 app-server：杀**进程组**（不是单个 pid），SIGTERM 先行", async () => {
    const dir = tmpdir("orphan-kill")
    const file = path.join(dir, "x.pid")
    writePidFile(file, { pid: 999_003, pgid: 999_003, startedAt: "x", cmdline: "node codex app-server", instanceId: null })
    const ops = fakeOps({ alive: new Set([999_003]), cmdlines: { 999_003: "node /opt/homebrew/bin/codex app-server --listen stdio://" } })
    const r = await killOrphanFromPidFile({ file, procOps: ops, sleep })
    assert.equal(r.action, "killed")
    assert.equal(ops.calls.length >= 1, true)
    assert.equal(ops.calls[0]!.fn, "killGroup", "必须是进程组信号：只杀 wrapper 会留 rust 孤儿")
    assert.equal(ops.calls[0]!.signal, "SIGTERM")
    assert.equal(ops.calls.some((c) => c.fn === "kill"), false, "不许对单个 pid 下手")
  })

  it("SIGTERM 不死就升级 SIGKILL（还是打进程组）", async () => {
    const dir = tmpdir("orphan-escalate")
    const file = path.join(dir, "x.pid")
    writePidFile(file, { pid: 999_004, pgid: 999_004, startedAt: "x", cmdline: "codex app-server", instanceId: null })
    const ops = fakeOps({
      alive: new Set([999_004]),
      cmdlines: { 999_004: "codex app-server --listen stdio://" },
      dieOn: "SIGKILL",
    })
    const r = await killOrphanFromPidFile({ file, procOps: ops, sleep })
    assert.equal(r.action, "killed")
    assert.equal(r.escalated, true)
    assert.deepEqual(
      ops.calls.map((c) => `${c.fn}:${c.signal}`),
      ["killGroup:SIGTERM", "killGroup:SIGKILL"],
    )
  })

  it("pgid 与 pid 不同（wrapper 不是组长）时按 pgid 打", async () => {
    const dir = tmpdir("orphan-pgid")
    const file = path.join(dir, "x.pid")
    writePidFile(file, { pid: 999_005, pgid: 999_500, startedAt: "x", cmdline: "codex app-server", instanceId: null })
    const ops = fakeOps({ alive: new Set([999_005, 999_500]), cmdlines: { 999_005: "codex app-server" } })
    await killOrphanFromPidFile({ file, procOps: ops, sleep })
    assert.equal(ops.calls[0]!.pid, 999_500)
  })

  it("绝不自杀：pgid 等于自己的 pid 时拒绝动手", async () => {
    const dir = tmpdir("orphan-self")
    const file = path.join(dir, "x.pid")
    writePidFile(file, { pid: 4242, pgid: process.pid, startedAt: "x", cmdline: "codex app-server", instanceId: null })
    const ops = fakeOps({ alive: new Set([4242, process.pid]), cmdlines: { 4242: "codex app-server" } })
    const r = await killOrphanFromPidFile({ file, procOps: ops, sleep, selfPid: process.pid })
    assert.equal(r.action, "unsafe-pgid")
    assert.deepEqual(ops.calls, [])
  })

  it("pgid <= 1 拒绝（kill(-1) 会杀掉本用户所有进程）", async () => {
    const dir = tmpdir("orphan-pg1")
    const file = path.join(dir, "x.pid")
    fs.writeFileSync(file, JSON.stringify({ pid: 4242, pgid: 1, startedAt: "x", cmdline: "codex app-server", instanceId: null }))
    const ops = fakeOps({ alive: new Set([4242]), cmdlines: { 4242: "codex app-server" } })
    const r = await killOrphanFromPidFile({ file, procOps: ops, sleep })
    assert.equal(r.action, "unsafe-pgid")
    assert.deepEqual(ops.calls, [])
  })

  it("pid 文件里记的 cmdline 与现况对不上也算复用，不动手", async () => {
    const dir = tmpdir("orphan-cmdchange")
    const file = path.join(dir, "x.pid")
    writePidFile(file, { pid: 999_006, pgid: 999_006, startedAt: "x", cmdline: "codex app-server --listen stdio://", instanceId: "i1" })
    // 现在这个 pid 上跑的是别人的 app-server（marker 命中，但与记录的 cmdline 不同）
    const ops = fakeOps({ alive: new Set([999_006]), cmdlines: { 999_006: "some-other app-server thing" } })
    const r = await killOrphanFromPidFile({ file, procOps: ops, sleep, requireRecordedCmdline: true })
    assert.equal(r.action, "cmdline-mismatch")
    assert.deepEqual(ops.calls, [])
  })
})
