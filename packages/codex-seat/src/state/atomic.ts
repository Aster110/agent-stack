// 原子写：临时文件 + fsync + rename。设计稿 §5「写临时文件 + rename（原子）」。
//
// 为什么必须 rename 而不是 writeFileSync 覆盖：席位被 kill -9 的窗口就在写状态的那一刻，
// 原地覆盖会留下半截 JSON（load 失败 → 游标/mainThreadId 全丢 → E04 的续对话直接没了）。
// rename(2) 在同一文件系统上是原子的：读者要么看到旧文件，要么看到新文件，没有中间态。

import fs from "node:fs"
import path from "node:path"

let counter = 0

export function atomicWriteFileSync(file: string, data: string, mode = 0o600): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${counter++}`)
  const fd = fs.openSync(tmp, "w", mode)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw err
  }
  // 目录项本身也要落盘，否则掉电后 rename 可能丢。失败不致命（有些平台不允许 fsync 目录）。
  try {
    const dfd = fs.openSync(dir, "r")
    try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
  } catch { /* best effort */ }
}

export function readJsonSync<T>(file: string): T | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
