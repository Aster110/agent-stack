// 图片输入的席位契约：通道或 mesh 带来的本地图片，必须作为同一轮 turn 的原生 image 输入送给模型，
// 并且和正文一起落 WAL（重启重放不丢图）；文件被清理/引擎拒图时正文照常，绝不吞字。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FakeAppServerClient } from '../app-server/index.js'
import { SpyEngine } from './fakes/spy-engine.js'
import { FakeRelay } from './fakes/fake-relay.js'
import { resolveSeatConfig } from './config.js'
import { runSeat, type SeatRuntimeOptions } from './seat.js'
import { seatPaths, foldWal, type TurnHandle, type TurnOutcome, type TurnStartRequest } from '../contracts.js'
import { WalStore } from '../state/wal.js'
import type { ChannelOutput } from './channels.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function until(fn: () => boolean, why: string) {
  const end = Date.now() + 5000
  while (!fn()) { if (Date.now() > end) throw new Error(why); await sleep(5) }
}
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')

async function harness(t: any, options: SeatRuntimeOptions = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-media-'))
  const relay = await FakeRelay.start('lab')
  const engine = new SpyEngine(new FakeAppServerClient({ scenario: { defaultTurn: { completeAfterMs: 10, outcome: { status: 'completed', finalText: 'saw-it' } } } }))
  const outputs: Array<{ endpoint: string; output: ChannelOutput }> = []
  const channels = { wechat: { accepts: (id: string) => id === 'owner', async send(endpoint: string, output: ChannelOutput) { outputs.push({ endpoint, output }) } } }
  const config = resolveSeatConfig({ seat: 'media', cwd: home, relayUrl: relay.url,
    hub: { enabled: false, ledgerUrl: 'http://127.0.0.1:1', tokenFile: path.join(home, 'token'), intervalSec: 300 },
    allowlist: { extra: ['lab:probe'], disableDefaults: true }, sync: { timeoutSec: 1, limit: 100 }, turn: { timeoutMs: 2000 } })
  const opts: SeatRuntimeOptions = { engine, channels, ledger: null, homeDir: home, installSignalHandlers: false, receiptRetryMs: 25, log: () => {}, ...options }
  let seat = await runSeat(config, opts)
  const image = (name: string) => { const p = path.join(home, name); fs.writeFileSync(p, JPEG); return p }
  t.after(async () => { await seat.stop(); await relay.stop(); fs.rmSync(home, { recursive: true, force: true }) })
  return { home, relay, engine, outputs, image, get seat() { return seat },
    async restart() { await seat.stop(); seat = await runSeat(config, opts); return seat },
    wal: () => new WalStore(seatPaths('media', home).wal) }
}

test('channel images reach the engine as native image input of the same turn, in order', async t => {
  const h = await harness(t)
  const a = h.image('a.jpg'), b = h.image('b.jpg')
  assert.equal(h.seat.deliver({ channel: 'wechat', endpointId: 'owner', id: 'img-1', text: '[图片1] [图片2] 修一下', images: [a, b] }), 'accepted')
  await until(() => h.outputs.some(x => x.output.kind === 'done'), 'reply')
  assert.equal(h.engine.turnCalls.length, 1)
  assert.deepEqual(h.engine.turnCalls[0]!.images, [a, b])
  assert.match(h.engine.turnCalls[0]!.text, /\[图片1\] \[图片2\] 修一下/)
  // 原文与图片一起落 WAL：只有这样重启重放才不会丢图。
  const fetched = h.wal().readAll().find(e => e.op === 'fetched')!
  assert.deepEqual(fetched.images, [a, b])
})

test('plain text deliveries keep the old engine request shape', async t => {
  const h = await harness(t)
  h.seat.deliver({ channel: 'wechat', endpointId: 'owner', id: 'plain', text: 'hello' })
  await until(() => h.engine.turnCalls.length === 1, 'turn')
  assert.equal('images' in h.engine.turnCalls[0]!, false)
})

test('invalid image references are refused before durable acceptance', async t => {
  const h = await harness(t)
  const bad = [['relative.jpg'], ['/tmp/a\nb.jpg'], [42 as unknown as string], Array.from({ length: 17 }, (_, i) => `/tmp/${i}.jpg`)]
  for (const images of bad) assert.throws(() => h.seat.deliver({ channel: 'wechat', endpointId: 'owner', id: `bad-${images.length}`, text: 'x', images }), /image/)
  assert.equal(h.wal().readAll().length, 0)
})

test('WAL replay after restart re-attaches the persisted images', async t => {
  const h = await harness(t)
  const a = h.image('replay.jpg')
  await h.seat.stop()
  const msgId = 'channel:wechat:replay-fixture'
  h.wal().append({ op: 'fetched', msgId, seq: 0, to: h.seat.nodeId, from: 'wechat:fixture', nonce: 'replay_fixture', at: new Date().toISOString(),
    payload: '[图片1] 重启前收下的图', images: [a], replyRoute: { channel: 'wechat', endpointId: 'owner' } })
  assert.deepEqual(foldWal(h.wal().readAll()).get(msgId)?.images, [a])
  await h.restart()
  await until(() => h.engine.turnCalls.length === 1, 'replayed turn')
  assert.deepEqual(h.engine.turnCalls[0]!.images, [a])
  assert.match(h.engine.turnCalls[0]!.text, /重启前收下的图/)
})

test('an image that expired before the turn is dropped from native input but the text still runs', async t => {
  const h = await harness(t)
  const gone = path.join(h.home, 'expired.jpg')
  const kept = h.image('kept.jpg')
  h.seat.deliver({ channel: 'wechat', endpointId: 'owner', id: 'expired', text: '两张图', images: [gone, kept] })
  await until(() => h.outputs.some(x => x.output.kind === 'done'), 'reply')
  assert.deepEqual(h.engine.turnCalls[0]!.images, [kept])
  assert.match(h.engine.turnCalls[0]!.text, /两张图/)
  assert.ok(h.engine.turnCalls[0]!.text.includes(`图片文件已不可用：${gone}`))
})

test('engine refusing the image input is retried once as text only; the words are never swallowed', async t => {
  const h = await harness(t)
  const a = h.image('unreadable.jpg')
  const start = h.engine.turnStart.bind(h.engine)
  const calls: TurnStartRequest[] = []
  h.engine.turnStart = async (req: TurnStartRequest): Promise<TurnHandle> => {
    calls.push(req)
    if (!req.images?.length) return await start(req)
    const done: Promise<TurnOutcome> = Promise.resolve({ status: 'rejected', message: 'image could not be decoded', code: -32602 })
    const started = new Promise<{ turnId: string; at: number }>(() => {})
    return { threadId: req.threadId, turnId: null, started, done, interrupt: async () => {} }
  }
  h.seat.deliver({ channel: 'wechat', endpointId: 'owner', id: 'refused', text: '帮我看这张图', images: [a] })
  await until(() => h.outputs.some(x => x.output.kind === 'done'), 'text-only reply')
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.images, undefined)
  assert.match(calls[1]!.text, /帮我看这张图/)
  assert.match(calls[1]!.text, /图片未能作为原生输入/)
})

test('mesh attachments materialized by the relay become native images plus visible lines; payload stays intact', async t => {
  const h = await harness(t)
  const local = h.image('from-peer.jpg')
  const sha = 'a'.repeat(64)
  h.relay.deliver(h.seat.nodeId, 'lab:probe', '修好了，见附件', 'chat', undefined, undefined, undefined, { attachments: [
    { version: 1, id: `att-${sha}`, kind: 'image', mime: 'image/jpeg', size: JPEG.length, sha256: sha, width: 1, height: 1, storageRef: `hub-blob:${sha}`, createdAt: '2026-09-25T00:00:00.000Z', expiresAt: '2026-09-26T00:00:00.000Z', localPath: local },
    { version: 1, id: `att-${'b'.repeat(64)}`, kind: 'image', mime: 'image/png', size: 9, sha256: 'b'.repeat(64), storageRef: `hub-blob:${'b'.repeat(64)}`, createdAt: '2026-09-25T00:00:00.000Z', expiresAt: '2026-09-26T00:00:00.000Z', error: 'expired' },
  ] })
  await until(() => h.engine.turnCalls.length === 1, 'mesh turn')
  const call = h.engine.turnCalls[0]!
  assert.deepEqual(call.images, [local])
  assert.match(call.text, /修好了，见附件/)
  assert.ok(call.text.includes(`[attachment 1] image/jpeg 1x1 ${JPEG.length}B sha256=${sha} ${local}`))
  assert.ok(call.text.includes('[attachment 2 unavailable: expired]'))
  const fetched = h.wal().readAll().find(e => e.op === 'fetched')!
  assert.deepEqual(fetched.images, [local])
})

test('a relay path that is not absolute is never handed to the engine', async t => {
  const h = await harness(t)
  h.relay.deliver(h.seat.nodeId, 'lab:probe', 'bad path', 'chat', undefined, undefined, undefined, { attachments: [{ kind: 'image', mime: 'image/png', localPath: '../escape.png' }] })
  await until(() => h.engine.turnCalls.length === 1, 'mesh turn')
  assert.equal(h.engine.turnCalls[0]!.images, undefined)
  assert.ok(h.engine.turnCalls[0]!.text.includes('[attachment 1 unavailable: invalid local path]'))
})
