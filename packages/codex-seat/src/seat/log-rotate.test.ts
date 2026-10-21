// sidecar.jsonl 轮转：超限改名 + 后台 gzip + 只留最新 keep 份；压缩归档，不丢任何一行。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRotatingLog } from './log-rotate.js'

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const line = (i: number) => `${JSON.stringify({ at: 'x', event: 'e', i, pad: 'p'.repeat(60) })}\n`
const gz = (dir: string) => fs.readdirSync(dir).filter(n => n.endsWith('.gz')).sort()
const readAll = (dir: string, file: string) => [
  ...gz(dir).map(n => zlib.gunzipSync(fs.readFileSync(path.join(dir, n))).toString('utf8')),
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
].join('')

test('rotates past maxBytes, gzips the archive, and loses no line', async t => {
  const dir = tmp(t); const file = path.join(dir, 'sidecar.jsonl')
  const log = createRotatingLog(file, { maxBytes: 1000, keep: 100 })
  for (let i = 0; i < 100; i++) log.write(line(i))
  await log.idle()
  assert.ok(fs.statSync(file).size <= 1000, 'live file stays under the cap')
  assert.ok(gz(dir).length >= 5, 'archives were produced')
  assert.deepEqual(fs.readdirSync(dir).filter(n => /sidecar\.jsonl\.\d+T\d+Z$/.test(n)), [], 'no plain leftovers once compression is done')
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), [])
  const all = readAll(dir, file).trim().split('\n').map(l => JSON.parse(l).i)
  assert.deepEqual(all, Array.from({ length: 100 }, (_, i) => i), 'every line, in order, across archives and live file')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('keeps only the newest `keep` archives', async t => {
  const dir = tmp(t); const file = path.join(dir, 'sidecar.jsonl')
  const log = createRotatingLog(file, { maxBytes: 600, keep: 3 })
  for (let i = 0; i < 300; i++) { log.write(line(i)); if (i % 10 === 0) await log.idle() }
  await log.idle()
  assert.equal(gz(dir).length, 3)
  const kept = readAll(dir, file).trim().split('\n').map(l => JSON.parse(l).i)
  assert.equal(kept[kept.length - 1], 299, 'newest line survives')
  assert.ok(kept.length < 300, 'oldest lines were pruned')
  for (let k = 1; k < kept.length; k++) assert.equal(kept[k], kept[k - 1]! + 1, 'what is kept is contiguous')
})

test('an oversized file from before the upgrade rotates on the first write; interrupted archives are finished', async t => {
  const dir = tmp(t); const file = path.join(dir, 'sidecar.jsonl')
  fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => line(i)).join(''))
  // 上次进程在压缩途中被杀：明文归档还在，另有半截 .gz.tmp
  const stale = path.join(dir, 'sidecar.jsonl.20260101T000000000Z')
  fs.writeFileSync(stale, line(-1))
  fs.writeFileSync(`${stale}.gz.tmp`, 'garbage')
  const log = createRotatingLog(file, { maxBytes: 1000, keep: 10 })
  log.write(line(40))
  await log.idle()
  assert.equal(fs.existsSync(stale), false)
  assert.equal(fs.existsSync(`${stale}.gz.tmp`), false)
  assert.ok(fs.existsSync(`${stale}.gz`))
  const all = readAll(dir, file).trim().split('\n').map(l => JSON.parse(l).i)
  assert.deepEqual(all, [-1, ...Array.from({ length: 41 }, (_, i) => i)])
})

test('only touches its own archives', async t => {
  const dir = tmp(t); const file = path.join(dir, 'sidecar.jsonl')
  fs.writeFileSync(path.join(dir, 'app-server.stderr.log'), 'keep me')
  fs.writeFileSync(path.join(dir, 'sidecar.jsonl.notes'), 'keep me too')
  fs.writeFileSync(path.join(dir, 'other.jsonl.20260101T000000Z.gz'), 'not mine')
  const log = createRotatingLog(file, { maxBytes: 300, keep: 1 })
  for (let i = 0; i < 30; i++) log.write(line(i))
  await log.idle()
  assert.equal(fs.readFileSync(path.join(dir, 'app-server.stderr.log'), 'utf8'), 'keep me')
  assert.equal(fs.readFileSync(path.join(dir, 'sidecar.jsonl.notes'), 'utf8'), 'keep me too')
  assert.equal(fs.readFileSync(path.join(dir, 'other.jsonl.20260101T000000Z.gz'), 'utf8'), 'not mine')
  assert.equal(gz(dir).filter(n => n.startsWith('sidecar.jsonl.')).length, 1)
})

test('a log directory that cannot be written never throws into the caller', async t => {
  const dir = tmp(t)
  fs.writeFileSync(path.join(dir, 'afile'), 'a regular file where a directory is needed')
  const log = createRotatingLog(path.join(dir, 'afile', 'x.jsonl'), { maxBytes: 100 })
  assert.doesNotThrow(() => { for (let i = 0; i < 5; i++) log.write(line(i)) })
  await log.idle()
})
