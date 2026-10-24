/**
 * AGENTS 链指纹：判断「codex 这条 thread 装着的 AGENTS.md」和磁盘上的是否还一样。
 *
 * 为什么要有它（2026-10-24 实测，codex-cli 0.153.4 / 0.154.0，P62 t_4ea2a3）：
 * 常驻 app-server 只在 thread **装进进程**（thread/start、进程重启后的 thread/resume）
 * 或**这一轮的 cwd 和上一轮不同**时读 AGENTS 链；同一进程里一轮接一轮跑，磁盘上的
 * AGENTS.md 改了它也照用旧的（压缩后整份重发的 world_state 也还是旧文本）。
 * 两轮之间把 cwd 弹走再弹回、thread/unsubscribe 都不会让它重读，唯一干净的办法是换一代引擎再 resume。
 * 席位常驻几天不重启，规则就几天不生效（Mini codex-feishu 10-21→10-24）。
 *
 * 读链规则照 codex 的做法取近似、宁多勿漏（多算只会多刷新一次，没有副作用）：
 *   - 全局：`<CODEX_HOME>/AGENTS.override.md`，没有再取 `<CODEX_HOME>/AGENTS.md`
 *   - 项目：从 cwd 往上找到含 `.git` 的目录为根，根到 cwd 每一级先 `AGENTS.override.md`
 *     再 `AGENTS.md`；找不到根就只看 cwd 这一级
 * 指纹只认**内容**（读文件会跟随软链），不看 mtime。
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface AgentsChainFile {
  path: string
  /** 内容 sha256 前 16 位；文件不在 = null */
  sha: string | null
}

export interface AgentsChainFingerprint {
  /** 整条链的指纹（路径 + 内容）；比较只看它 */
  hash: string
  files: AgentsChainFile[]
}

const DOC_NAMES = ["AGENTS.override.md", "AGENTS.md"] as const

function readOrNull(p: string): Buffer | null {
  try {
    return fs.readFileSync(p)
  } catch {
    return null
  }
}

function firstExisting(dir: string): { path: string; body: Buffer } | null {
  for (const n of DOC_NAMES) {
    const p = path.join(dir, n)
    const body = readOrNull(p)
    if (body) return { path: p, body }
  }
  return null
}

function hasGitMarker(dir: string): boolean {
  try {
    fs.statSync(path.join(dir, ".git"))
    return true
  } catch {
    return false
  }
}

/** 从 cwd 往上的目录序列（根在前），codex 会在这些目录里找项目级 AGENTS 文件。 */
export function projectDocDirs(cwd: string): string[] {
  let start = cwd
  try {
    start = fs.realpathSync(cwd)
  } catch {
    /* cwd 不在了：按字面算，结果是全 null，照样能比 */
  }
  const up: string[] = []
  let d = start
  for (;;) {
    up.push(d)
    if (hasGitMarker(d)) return up.reverse()
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  return [start]
}

export function resolveCodexHome(explicit: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit && explicit.trim()) return explicit
  if (env.CODEX_HOME && env.CODEX_HOME.trim()) return env.CODEX_HOME
  return path.join(env.HOME || os.homedir(), ".codex")
}

export function agentsChainFingerprint(cwd: string, codexHome: string): AgentsChainFingerprint {
  const files: AgentsChainFile[] = []
  const h = createHash("sha256")
  const add = (label: string, hit: { path: string; body: Buffer } | null): void => {
    const sha = hit ? createHash("sha256").update(hit.body).digest("hex").slice(0, 16) : null
    files.push({ path: hit?.path ?? label, sha })
    h.update(`${hit?.path ?? label}\0${sha ?? "-"}\n`)
  }
  add(path.join(codexHome, "AGENTS.md"), firstExisting(codexHome))
  for (const dir of projectDocDirs(cwd)) {
    const hit = firstExisting(dir)
    if (hit) add(hit.path, hit)
  }
  return { hash: h.digest("hex").slice(0, 16), files }
}
