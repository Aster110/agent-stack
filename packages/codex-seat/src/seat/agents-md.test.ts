// AGENTS 链指纹：只认内容、按 codex 的读链规则走（全局 + 项目根到 cwd，override 优先）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { agentsChainFingerprint, projectDocDirs, resolveCodexHome } from "./agents-md.js"

function tree(): { root: string; repo: string; cwd: string; home: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-md-")))
  const repo = path.join(root, "repo")
  const cwd = path.join(repo, "seats", "x")
  const home = path.join(root, "codex-home")
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, "AGENTS.md"), "global v1\n")
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "root v1\n")
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "seat v1\n")
  return { root, repo, cwd, home }
}

test("agents-md: 链上任何一份改了内容指纹就变；只 touch 不变", () => {
  const t = tree()
  const a = agentsChainFingerprint(t.cwd, t.home)
  assert.deepEqual(a.files.map((f) => path.relative(t.root, f.path)), ["codex-home/AGENTS.md", "repo/AGENTS.md", "repo/seats/x/AGENTS.md"])
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(path.join(t.repo, "AGENTS.md"), later, later)
  assert.equal(agentsChainFingerprint(t.cwd, t.home).hash, a.hash, "mtime 变了内容没变，不算")
  for (const p of [path.join(t.home, "AGENTS.md"), path.join(t.repo, "AGENTS.md"), path.join(t.cwd, "AGENTS.md")]) {
    const before = agentsChainFingerprint(t.cwd, t.home).hash
    fs.appendFileSync(p, "改一句\n")
    assert.notEqual(agentsChainFingerprint(t.cwd, t.home).hash, before, `${p} 改了必须能看出来`)
  }
})

test("agents-md: 只走到 git 根为止；中间一级新增 AGENTS.md 也算变化", () => {
  const t = tree()
  fs.writeFileSync(path.join(t.root, "AGENTS.md"), "仓外的不读\n")
  const a = agentsChainFingerprint(t.cwd, t.home)
  assert.equal(a.files.some((f) => f.path === path.join(t.root, "AGENTS.md")), false)
  fs.appendFileSync(path.join(t.root, "AGENTS.md"), "再改\n")
  assert.equal(agentsChainFingerprint(t.cwd, t.home).hash, a.hash, "git 根之外的文件改了不算")
  fs.writeFileSync(path.join(t.repo, "seats", "AGENTS.md"), "中间层新增\n")
  assert.notEqual(agentsChainFingerprint(t.cwd, t.home).hash, a.hash)
  assert.deepEqual(projectDocDirs(t.cwd), [t.repo, path.join(t.repo, "seats"), t.cwd])
})

test("agents-md: 同一级 AGENTS.override.md 优先，AGENTS.md 被它盖住时改了不算", () => {
  const t = tree()
  fs.writeFileSync(path.join(t.cwd, "AGENTS.override.md"), "override v1\n")
  const a = agentsChainFingerprint(t.cwd, t.home)
  assert.ok(a.files.some((f) => f.path.endsWith("AGENTS.override.md")))
  fs.appendFileSync(path.join(t.cwd, "AGENTS.md"), "被盖住\n")
  assert.equal(agentsChainFingerprint(t.cwd, t.home).hash, a.hash)
  fs.appendFileSync(path.join(t.cwd, "AGENTS.override.md"), "override v2\n")
  assert.notEqual(agentsChainFingerprint(t.cwd, t.home).hash, a.hash)
})

test("agents-md: 软链跟到目标内容（s1 的 ~/.codex/AGENTS.md 就是软链）", () => {
  const t = tree()
  const target = path.join(t.repo, "seats", "brain.md")
  fs.writeFileSync(target, "brain v1\n")
  fs.rmSync(path.join(t.home, "AGENTS.md"))
  fs.symlinkSync(target, path.join(t.home, "AGENTS.md"))
  const a = agentsChainFingerprint(t.cwd, t.home)
  fs.appendFileSync(target, "brain v2\n")
  assert.notEqual(agentsChainFingerprint(t.cwd, t.home).hash, a.hash)
})

test("agents-md: 没有 git 根只看 cwd；codexHome 取值顺序 显式 > CODEX_HOME > ~/.codex", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agents-md-nogit-")))
  assert.deepEqual(projectDocDirs(dir), [dir])
  assert.equal(resolveCodexHome("/x", { CODEX_HOME: "/y", HOME: "/h" }), "/x")
  assert.equal(resolveCodexHome(null, { CODEX_HOME: "/y", HOME: "/h" }), "/y")
  assert.equal(resolveCodexHome("", { HOME: "/h" }), "/h/.codex")
})
