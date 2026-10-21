// sidecar.jsonl 的大小轮转。
//
// 为什么要有：2026-10-21 s1 主脑的 sidecar.jsonl 涨到 324MB，原因是两条过期微信回执每 5 秒重发一次、
// 每次失败写一行，整整八天没人发现（回执本身的退避/放弃见 seat.ts）。日志是诊断用的追加文件，
// 不该因为任何一个上游故障就把磁盘写满，所以它自己要有上限。
//
// 做法：写之前看大小，超过 maxBytes 就把当前文件改名成 `<name>.<UTC 时间戳>`，后台流式 gzip 成
// `.gz`（原文件在 .gz 写完整后才删），再只保留最新 keep 份归档。归档是压缩而不是删除：旧日志还能 zcat 回看。
// 重复刷同一行的日志压缩比常在 50-100 倍，32MB 的活动文件归档后是几百 KB。

import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { pipeline } from "node:stream"

export interface LogRotationPolicy {
  /** 活动文件超过这么多字节就轮转 */
  maxBytes: number
  /** 保留多少份归档（含正在压缩的），更老的删除 */
  keep: number
}

export const DEFAULT_LOG_ROTATION: LogRotationPolicy = { maxBytes: 32 * 1024 * 1024, keep: 8 }

export interface RotatingLog {
  write(line: string): void
  /** 等当前所有后台压缩/清理结束（测试与优雅退出用） */
  idle(): Promise<void>
}

/** 归档文件名后缀：UTC 时间戳，毫秒位可选（人工归档可能只到秒），按字典序即时间序。 */
const STAMP = /^\d{8}T\d{6}(?:\d{3})?Z$/

/** 严格递增：同一毫秒内连续两次轮转也不会撞名覆盖掉还没压缩的上一份。 */
let lastStampMs = 0
function stampNow(): string {
  lastStampMs = Math.max(Date.now(), lastStampMs + 1)
  return new Date(lastStampMs).toISOString().replace(/[-:]/g, "").replace(".", "")
}

export function createRotatingLog(file: string, partial: Partial<LogRotationPolicy> = {}): RotatingLog {
  const policy = { ...DEFAULT_LOG_ROTATION, ...partial }
  const dir = path.dirname(file)
  const base = path.basename(file)
  let size: number | null = null
  let retryRotateAt = 0
  const pending = new Set<Promise<void>>()
  let chain: Promise<void> = Promise.resolve()

  /** 压缩/清理一律串行：两轮同时压同一个归档会写坏同一个 .gz.tmp。 */
  const schedule = (): void => {
    const run = chain.then(tidy, tidy)
    chain = run
    pending.add(run)
    void run.finally(() => pending.delete(run))
  }

  /** 归档目录里属于这份日志的文件：[{name, plain}]，按时间从老到新。 */
  const archives = (): Array<{ name: string; plain: boolean }> => {
    let names: string[]
    try { names = fs.readdirSync(dir) } catch { return [] }
    const out: Array<{ name: string; plain: boolean }> = []
    for (const name of names) {
      if (!name.startsWith(`${base}.`)) continue
      const rest = name.slice(base.length + 1)
      const gz = rest.endsWith(".gz")
      if (STAMP.test(gz ? rest.slice(0, -3) : rest)) out.push({ name, plain: !gz })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  const compress = (name: string): Promise<void> => new Promise((resolve) => {
    const src = path.join(dir, name)
    const tmp = `${src}.gz.tmp`
    const done = (): void => resolve()
    pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp, { mode: 0o600 }), (err) => {
      if (err) { try { fs.rmSync(tmp, { force: true }) } catch { /* 原文件还在，下次启动再压 */ } return done() }
      try {
        fs.renameSync(tmp, `${src}.gz`)
        fs.rmSync(src, { force: true }) // .gz 已完整落盘才删原文件
      } catch { /* 留着原文件，下次启动再压 */ }
      done()
    })
  })

  const prune = (): void => {
    const all = archives()
    // 同一时间戳既有明文又有 .gz = 压缩刚做完还没删明文，只算一份。
    const stamps = [...new Set(all.map((a) => a.name.replace(/\.gz$/, "")))]
    for (const stale of stamps.slice(0, Math.max(0, stamps.length - policy.keep))) {
      for (const a of all) if (a.name.replace(/\.gz$/, "") === stale) { try { fs.rmSync(path.join(dir, a.name), { force: true }) } catch { /* ignore */ } }
    }
  }

  /** 压缩所有还没压的归档（重启时可能留下半截），然后清理超额的。 */
  const tidy = async (): Promise<void> => {
    try {
      for (const name of fs.readdirSync(dir)) if (name.startsWith(`${base}.`) && name.endsWith(".gz.tmp")) fs.rmSync(path.join(dir, name), { force: true })
    } catch { /* ignore */ }
    const compressed = new Set(archives().filter((a) => !a.plain).map((a) => a.name.slice(0, -3)))
    for (const a of archives()) if (a.plain && !compressed.has(a.name)) await compress(a.name)
    for (const a of archives()) if (a.plain && compressed.has(a.name)) { try { fs.rmSync(path.join(dir, a.name), { force: true }) } catch { /* ignore */ } }
    prune()
  }

  const rotate = (): void => {
    const dest = path.join(dir, `${base}.${stampNow()}`)
    fs.renameSync(file, dest)
    size = 0
    schedule()
  }

  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 写的时候再失败 */ }
  schedule()

  return {
    write(line: string): void {
      try {
        if (size == null) { try { size = fs.statSync(file).size } catch { size = 0 } }
        const bytes = Buffer.byteLength(line)
        if (size > 0 && size + bytes > policy.maxBytes && Date.now() >= retryRotateAt) {
          try { rotate() } catch { retryRotateAt = Date.now() + 60_000 } // 改名失败别每行都试
        }
        fs.appendFileSync(file, line, { mode: 0o600 })
        size += bytes
      } catch { /* 日志写不动不该弄死席位 */ }
    },
    idle: async () => { while (pending.size) await Promise.all([...pending]) },
  }
}
