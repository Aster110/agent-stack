// wal.jsonl：先写盘再动作的事件日志。设计稿 §4。
//
// 纪律（这三条决定 E03 成不成立）：
//   1. append 必须**同步 + fsync**：批次写完 WAL 才允许把 since 推给 relay（推 since = 销账）。
//      攒在内存里的日志在 kill -9 面前等于没写。
//   2. readAll 必须容忍最后一行被截断：崩溃就发生在写盘中间，半行是常态不是异常。
//   3. compact 只丢 foldWal 判为 done 的消息；未闭环的一条都不许丢。

import fs from "node:fs"
import path from "node:path"

import { foldWal, type WalEntry, type WalFolded } from "../contracts.js"
import { atomicWriteFileSync } from "./atomic.js"

export const WAL_COMPACT_EVERY = 200

export class WalStore {
  private fd: number | null = null
  private appends = 0

  constructor(readonly file: string, private readonly strict = false) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }

  private handle(): number {
    if (this.fd == null) {
      if (this.strict && fs.existsSync(this.file)) {
        this.readAll() // A malformed complete line must fail before mutation.
        const raw = fs.readFileSync(this.file)
        if (raw.length && raw[raw.length - 1] !== 10) {
          const boundary = raw.lastIndexOf(10) + 1
          let complete = true
          try { JSON.parse(raw.subarray(boundary).toString("utf8")) } catch { complete = false }
          if (complete) fs.appendFileSync(this.file, "\n")
          else fs.truncateSync(this.file, boundary)
        }
      }
      this.fd = fs.openSync(this.file, "a", 0o600)
    }
    return this.fd
  }

  /** 同步追加 + fsync。返回本次之后的追加计数（供 maybeCompact 判断）。 */
  append(entry: WalEntry): number {
    const fd = this.handle()
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`)
    fs.fsyncSync(fd)
    this.appends++
    return this.appends
  }

  readAll(): WalEntry[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, "utf8")
    } catch (error) {
      if (this.strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return []
    }
    const out: WalEntry[] = []
    const lines = raw.split("\n")
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue
      let obj: WalEntry
      try {
        obj = JSON.parse(line) as WalEntry
      } catch {
        if (this.strict && index !== lines.length - 1) throw new Error(`corrupt WAL record at line ${index + 1}`)
        continue // Only a truncated final JSON fragment can be discarded.
      }
      if (this.strict && (!obj || !["fetched", "routed", "submitting", "started", "completed", "failed", "rejected", "receipted"].includes(obj.op) ||
          ![obj.msgId, obj.to, obj.from, obj.nonce, obj.at].every(v => typeof v === "string") || !Number.isFinite(obj.seq)))
        throw new Error(`corrupt WAL schema at line ${index + 1}`)
      if (obj && typeof obj.op === "string" && typeof obj.msgId === "string") out.push(obj)
    }
    return out
  }

  fold(): Map<string, WalFolded> {
    return foldWal(this.readAll())
  }

  /** 折叠后重写文件：done 的丢掉，其余原样保留（保序）。返回保留的消息条数。 */
  compact(): number {
    const entries = this.readAll()
    const folded = foldWal(entries)
    const keep = new Set<string>()
    for (const [msgId, f] of folded) if (f.phase !== "done") keep.add(msgId)
    const kept = entries.filter((e) => keep.has(e.msgId))
    if (this.fd != null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
    atomicWriteFileSync(this.file, kept.map((e) => `${JSON.stringify(e)}\n`).join(""))
    this.appends = 0
    return keep.size
  }

  maybeCompact(every = WAL_COMPACT_EVERY): boolean {
    if (this.appends < every) return false
    this.compact()
    return true
  }

  close(): void {
    if (this.fd != null) {
      try { fs.closeSync(this.fd) } catch { /* ignore */ }
      this.fd = null
    }
  }
}
