import { describe, it } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { loadAgentProfile } from "./profile.js"

describe("loadAgentProfile", () => {
  it("从 ~/.ccmesh/agents/<name>.json 读取 profile", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ccmesh-profile-"))
    mkdirSync(path.join(root, "agents"), { recursive: true })
    writeFileSync(path.join(root, "agents", "tcx.json"), JSON.stringify({
      name: "tcx",
      launcher: "codex",
      cwd: "/Users/example/workspace/project",
      terminal: "tmux",
      autoInit: true,
    }), "utf8")

    const profile = loadAgentProfile("tcx", root)
    assert.ok(profile)
    assert.equal(profile.name, "tcx")
    assert.equal(profile.launcher, "codex")
    assert.equal(profile.cwd, "/Users/example/workspace/project")
    assert.equal(profile.terminal, "tmux")
    assert.equal(profile.autoInit, true)

    rmSync(root, { recursive: true, force: true })
  })

  it("缺 profile 文件时返回 null", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ccmesh-profile-missing-"))
    mkdirSync(path.join(root, "agents"), { recursive: true })
    const profile = loadAgentProfile("missing", root)
    assert.equal(profile, null)
    rmSync(root, { recursive: true, force: true })
  })

  it("非 tmux profile 视为无效", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ccmesh-profile-invalid-"))
    mkdirSync(path.join(root, "agents"), { recursive: true })
    writeFileSync(path.join(root, "agents", "bad.json"), JSON.stringify({
      name: "bad",
      launcher: "cc",
      cwd: "/tmp",
      terminal: "iterm",
      autoInit: true,
    }), "utf8")

    assert.throws(() => loadAgentProfile("bad", root), /tmux-backed/)
    rmSync(root, { recursive: true, force: true })
  })

  it("缺字段时抛错", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ccmesh-profile-shape-"))
    mkdirSync(path.join(root, "agents"), { recursive: true })
    writeFileSync(path.join(root, "agents", "bad.json"), JSON.stringify({
      name: "bad",
      cwd: "/tmp",
      terminal: "tmux",
    }), "utf8")

    assert.throws(() => loadAgentProfile("bad", root), /missing required field/)
    rmSync(root, { recursive: true, force: true })
  })
})
