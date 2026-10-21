// 终态回执重投：退避、放弃、重启后不重置。
//
// 2026-10-21 s1 主脑事故的形状：回执发往微信，对话 idle 过期（iLink errcode=-2 prepare failed），
// 对账循环每 5 秒重发一次、每次失败写一行日志，八天写了 50 万行、sidecar.jsonl 涨到 324MB。
// 这里每条用例都先在旧代码上跑红过（旧代码：无退避、无放弃、attempts 随时间线性涨）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FakeAppServerClient } from '../app-server/index.js'
import { SpyEngine } from './fakes/spy-engine.js'
import { FakeRelay } from './fakes/fake-relay.js'
import { resolveSeatConfig } from './config.js'
import { runSeat, type SeatLogRecord, type SeatRuntimeOptions } from './seat.js'
import { seatPaths, type WalEntry } from '../contracts.js'
import { WalStore } from '../state/wal.js'
import type { ChannelOutput } from './channels.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function until(fn: () => boolean, why: string, ms = 5000) {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) throw new Error(why); await sleep(5) }
}

/** 微信 iLink 对话过期时抛的那种错：消息头 + 一大段操作提示。 */
class FakeWeChatApiError extends Error {
  constructor() {
    super('WeChatApiError: sendMessage failed: errcode=-2 errmsg=prepare failed\n  ↳ ' + '这只 bot 跟这个 user 之间没有活跃对话了。'.repeat(20))
  }
}

async function setup(t: any, options: SeatRuntimeOptions = {}, prepare?: (wal: WalStore) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-retry-'))
  const relay = await FakeRelay.start('lab')
  const engine = new SpyEngine(new FakeAppServerClient({ scenario: { defaultTurn: { completeAfterMs: 20, outcome: { status: 'completed', finalText: 'verified-result' } } } }))
  const logs: SeatLogRecord[] = []
  const state = { mode: 'expired' as 'expired' | 'ok', attempts: 0, delivered: [] as ChannelOutput[] }
  const channels = { wechat: { accepts: (id: string) => id === 'owner', async send(_endpoint: string, output: ChannelOutput) {
    if (output.kind !== 'done' && output.kind !== 'failed') return
    state.attempts++
    if (state.mode === 'expired') throw new FakeWeChatApiError()
    state.delivered.push(output)
  } } }
  const config = resolveSeatConfig({ seat: 'retry', cwd: home, relayUrl: relay.url,
    hub: { enabled: false, ledgerUrl: 'http://127.0.0.1:1', tokenFile: path.join(home, 'token'), intervalSec: 300 },
    allowlist: { extra: ['lab:probe'], disableDefaults: true }, sync: { timeoutSec: 1, limit: 100 } })
  const paths = seatPaths('retry', home)
  if (prepare) { fs.mkdirSync(path.dirname(paths.wal), { recursive: true }); prepare(new WalStore(paths.wal)) }
  const seat = await runSeat(config, { engine, channels, ledger: null, homeDir: home, installSignalHandlers: false,
    receiptRetryMs: 25, log: rec => { logs.push(rec) }, ...options })
  t.after(async () => { await seat.stop(); await relay.stop(); fs.rmSync(home, { recursive: true, force: true }) })
  const walOps = () => new WalStore(paths.wal).readAll()
  const abandoned = () => {
    try { return fs.readFileSync(path.join(paths.home, 'abandoned-receipts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
  }
  return { home, paths, relay, engine, seat, logs, state, walOps, abandoned, wal: () => new WalStore(paths.wal).fold() }
}

test('a permanently failing receipt backs off instead of retrying every tick', async t => {
  const h = await setup(t, { receiptRetry: { backoffMs: [0, 100, 200, 400], giveUpMs: 3600_000 } })
  h.seat.deliver({ channel: 'wechat', endpointId: 'owner', id: 'expired-1', text: 'work' })
  await until(() => h.state.attempts >= 1, 'first delivery attempt')
  const t0 = Date.now()
  await sleep(800)
  // 退避表：约在 0 / 25 / 125 / 325 / 725 ms 各一次。每 tick 一次的旧行为 800ms 内是 30+ 次。
  assert.ok(h.state.attempts >= 3, `must still retry (got ${h.state.attempts})`)
  assert.ok(h.state.attempts <= 8, `must back off (got ${h.state.attempts} attempts in ${Date.now() - t0}ms)`)
  assert.equal(h.engine.turnCalls.length, 1, 'no second model execution')
  // 失败行日志里不再带整段操作提示
  const failed = h.logs.filter(l => l.event === 'receipt-send-failed')
  assert.ok(failed.length >= 3)
  assert.ok(failed.every(l => String(l.error).length <= 300), 'failure log line carries only the head of the error')
  assert.ok([...h.wal().values()].some(f => f.phase === 'completed'), 'result stays durable while it is still retrying')
})

test('a receipt that stays undeliverable past giveUpMs is abandoned, recorded, and never retried again', async t => {
  const h = await setup(t, { receiptRetry: { backoffMs: [0, 20], giveUpMs: 150 } })
  h.seat.deliver({ channel: 'wechat', endpointId: 'owner', id: 'expired-2', text: 'work' })
  await until(() => h.abandoned().length === 1, 'abandoned record')
  const rec = h.abandoned()[0]
  assert.equal(rec.reason, 'give-up')
  assert.equal(rec.kind, 'done')
  assert.match(rec.receipt, /verified-result/, 'the unsent result text is preserved')
  assert.match(rec.lastError, /errcode=-2/)
  const last = h.walOps().filter(e => e.msgId === rec.msgId).pop()!
  assert.equal(last.op, 'receipted')
  assert.match(last.detail ?? '', /^abandoned:give-up/)
  assert.equal([...h.wal().values()].filter(f => f.phase !== 'done').length, 0, 'nothing left for the reconcile loop')
  const after = h.state.attempts
  await sleep(300)
  assert.equal(h.state.attempts, after, 'no attempt after abandonment')
  assert.equal(h.logs.filter(l => l.event === 'receipt-abandoned').length, 1)
  assert.equal(h.engine.turnCalls.length, 1)
})

test('after a restart an old stuck receipt is judged by its WAL age: one attempt, then abandoned', async t => {
  // 复现 s1 现场：10-13 完成、回执一直发不出去、进程后来重启过。giveUp 用缺省 24 小时。
  const longAgo = new Date(Date.now() - 8 * 24 * 3600_000).toISOString()
  const base = { msgId: 'old-msg-1', seq: 11, to: 'lab:retry', from: 'lab:probe', nonce: 'oldnonce1', messageType: 'chat', replyRoute: { channel: 'wechat', endpointId: 'owner' } }
  const h = await setup(t, {}, wal => {
    wal.append({ ...base, op: 'fetched', at: longAgo, payload: 'old work' } as WalEntry)
    wal.append({ ...base, op: 'completed', at: longAgo, threadId: 'old-thread', finalText: 'old-result-text' } as WalEntry)
  })
  await until(() => h.abandoned().length === 1, 'stale receipt abandoned on the first failed attempt')
  assert.equal(h.state.attempts, 1, 'exactly one last-chance attempt, not a fresh 24h of retries')
  const rec = h.abandoned()[0]
  assert.equal(rec.msgId, 'old-msg-1')
  assert.equal(rec.reason, 'give-up')
  assert.ok(rec.ageMs > 7 * 24 * 3600_000)
  assert.match(rec.receipt, /old-result-text/)
  assert.equal([...h.wal().values()].filter(f => f.phase !== 'done').length, 0)
  await sleep(150)
  assert.equal(h.state.attempts, 1)
  assert.equal(h.engine.turnCalls.length, 0, 'abandoning a receipt never reruns the model')
})

test('a recipient the relay says does not exist is abandoned after the gone grace window', async t => {
  const h = await setup(t, { receiptRetry: { backoffMs: [0, 20], goneGraceMs: 120, giveUpMs: 3600_000 } })
  h.relay.failWith = { pathPrefix: '/api/send', status: 404, body: '{"ok":false,"error":"target not found"}' }
  h.relay.deliver(h.seat.nodeId, 'lab:probe', 'mesh work')
  await until(() => h.abandoned().length === 1, 'target-gone abandoned')
  assert.equal(h.abandoned()[0].reason, 'target-gone')
  assert.equal(h.engine.turnCalls.length, 1)
})

test('a transient outage still recovers: delivered once, nothing abandoned', async t => {
  const h = await setup(t, { receiptRetry: { backoffMs: [0, 20, 40], giveUpMs: 3600_000 } })
  h.seat.deliver({ channel: 'wechat', endpointId: 'owner', id: 'blip', text: 'work' })
  await until(() => h.state.attempts >= 2, 'a couple of failed attempts')
  h.state.mode = 'ok'
  await until(() => h.state.delivered.length === 1, 'delivery after recovery')
  await until(() => [...h.wal().values()].every(f => f.phase === 'done'), 'receipted')
  await sleep(100)
  assert.equal(h.state.delivered.length, 1)
  assert.equal(h.abandoned().length, 0)
  assert.equal(h.engine.turnCalls.length, 1)
})
