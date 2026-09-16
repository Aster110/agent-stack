import { it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { DoorbellMonitor } from './doorbell.js'
import { createServer } from './server.js'
import { MeshEventBus } from './events.js'
import { DeviceRegistryCache } from './device-registry.js'

const terminal: any = { inject: async () => true, isAlive: async () => true, getCurrentSession: async () => null }
async function until(fn: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout
  while (!fn() && Date.now() < end) await delay(10)
  assert.ok(fn(), 'condition reached before deadline')
}
it('challenge receipts fence old connections and instances, survive restart, expire wake without extending retries', () => {
  let t = 1000
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-fence-')); const file = path.join(dir, 'fence.json')
  const d = new DoorbellMonitor(60, 60, () => t, file)
  const events: any[] = []
  const send = (event: string, data: any) => events.push({ event, data })
  const a = d.bind('dev:seat', 'instance-a', send, () => {})
  d.probe('dev:seat'); const probeA = events.at(-1).data
  assert.equal(d.status('dev:seat').state, 'unknown')
  assert.equal(d.ack({ ...probeA, connectionId: 'forged' }), false)
  assert.equal(d.ack(probeA), true)
  assert.equal(d.ack(probeA), false)
  assert.equal(d.status('dev:seat').state, 'listening')
  t += 60; assert.equal(d.status('dev:seat').state, 'lost')
  d.bind('dev:seat', 'instance-b', send, () => {})
  d.disconnect('dev:seat', a.connectionId)
  assert.equal(d.ack(probeA), false)
  assert.equal(d.canBind('dev:seat', 'instance-a'), false)
  const restarted = new DoorbellMonitor(60, 60, () => t, file)
  assert.equal(restarted.status('dev:seat').state, 'unknown')
  assert.equal(restarted.canBind('dev:seat', 'instance-a'), false)
  assert.equal(restarted.canBind('dev:seat', 'instance-b'), true)
  const b = d.bind('dev:seat', 'instance-b', send, () => {})
  d.message('dev:seat', 'real-message'); const wake = { ...events.at(-1).data, phase: 'waking' }
  assert.equal(d.ack(wake), true)
  const deadline = d.status('dev:seat').expiresAt
  t += 10; assert.equal(d.ack(wake), true) // accepted response lost and retried
  assert.equal(d.status('dev:seat').expiresAt, deadline)
  assert.equal(d.started(wake), true)
  d.disconnect('dev:seat', b.connectionId)
  assert.equal(d.status('dev:seat').state, 'waking')
  t += 50; assert.equal(d.status('dev:seat').state, 'lost')
  fs.rmSync(dir, { recursive: true })
})

it('real SSE child stays silent across probes; SIGSTOP expires ACK, SIGKILL loses connection; cursor and fetch time unchanged', async () => {
  const app = createServer({ dbPath: ':memory:', deviceId: 'dev', terminal, events: new MeshEventBus(), doorbellTtlMs: 180, doorbellProbeMs: 30 })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shortId: 'seat', pid: 123, role: 'main', description: 'test', deliveryMode: 'pull' }) })
  const child = spawn(process.execPath, [path.resolve('../../scripts/mesh-sse-doorbell.mjs'), 'dev:seat'], { env: { ...process.env, MESH_RELAY_URL: base }, stdio: ['ignore','pipe','pipe'] })
  let stdout = ''; let stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b)
  try {
    await until(() => app.doorbell.status('dev:seat').state === 'listening')
    const first = app.doorbell.status('dev:seat').lastAckAt
    const seen = app.registry.get('dev:seat')?.lastSeen
    await delay(300)
    assert.notEqual(app.doorbell.status('dev:seat').lastAckAt, first)
    assert.equal(stdout, ''); assert.equal(stderr, ''); assert.equal(child.exitCode, null)
    assert.equal(app.registry.getLastSyncAt('dev:seat'), undefined)
    assert.equal(app.store.getAckCursor('dev:seat'), 0)
    assert.equal(app.registry.get('dev:seat')?.lastSeen, seen)
    child.kill('SIGSTOP')
    await until(() => app.doorbell.status('dev:seat').state === 'lost')
    child.kill('SIGCONT')
    await until(() => app.doorbell.status('dev:seat').state === 'listening')
    child.kill('SIGKILL'); await once(child, 'exit')
    await until(() => app.doorbell.status('dev:seat').state === 'lost')
  } finally { child.kill('SIGKILL'); app.closeDoorbell(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); app.store.close() }
})

it('business event wakes once with acknowledged grace; dedicated execution receipt and sync remain separate', async () => {
  const bus = new MeshEventBus()
  const app = createServer({ dbPath: ':memory:', deviceId: 'dev', terminal, events: bus, doorbellTtlMs: 600, doorbellProbeMs: 40, doorbellWakeMs: 200 })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (p: string, body: any) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  await post('/api/register', { shortId: 'seat', pid: 123, role: 'main', description: 'test', deliveryMode: 'pull' })
  const child = spawn(process.execPath, [path.resolve('../../scripts/mesh-sse-doorbell.mjs'), 'dev:seat'], { env: { ...process.env, MESH_RELAY_URL: base }, stdio: ['ignore','pipe','pipe'] })
  let output = ''; child.stdout.on('data', b => output += b)
  try {
    await until(() => app.doorbell.status('dev:seat').state === 'listening')
    bus.emit('msg:send', { from: 'dev:seat', to: 'other:seat', msgId: 'outbound', status: 'accepted' })
    bus.emit('msg:send', { from: 'other:seat', to: '*', msgId: 'broadcast', status: 'accepted' })
    await delay(50); assert.equal(output, '')
    const exited = once(child, 'exit')
    bus.emit('msg:send', { from: 'other:seat', to: 'dev:seat', msgId: 'real-message', status: 'accepted' })
    await exited
    assert.equal(child.exitCode, 0)
    const receipt = JSON.parse(output).data
    assert.equal(receipt.msgId, 'real-message')
    assert.equal(app.doorbell.status('dev:seat').state, 'waking')
    assert.equal(app.registry.getLastSyncAt('dev:seat'), undefined)
    assert.equal(app.store.getAckCursor('dev:seat'), 0)
    assert.equal(app.doorbell.status('dev:seat').lastExecutionStartedAt, null)
    assert.equal((await post('/api/doorbell/execution', receipt)).status, 200)
    assert.ok(app.doorbell.status('dev:seat').lastExecutionStartedAt)
    await until(() => app.doorbell.status('dev:seat').state === 'lost')
  } finally { child.kill('SIGKILL'); app.closeDoorbell(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); app.store.close() }
})

it('cached listening evidence expires after disk reload even if another device refreshes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-cache-')); const file = path.join(dir, 'devices.json')
  const cache = new DeviceRegistryCache(file)
  const d = new DoorbellMonitor(); const status = { ...d.status('dev:seat'), state: 'listening' as const, expiresAt: new Date(Date.now() - 1).toISOString() }
  cache.update([{ deviceId: 'dev', relayId: 'r', nodes: [], updatedAt: new Date().toISOString(), listeners: [status] }])
  assert.equal(new DeviceRegistryCache(file).list()[0].listeners![0].state, 'lost')
  fs.rmSync(dir, { recursive: true })
})

it('truncated successful ACK response cannot strand the SSE reader', async () => {
  const { createServer: httpServer } = await import('node:http')
  let connections = 0; let acks = 0
  const server = httpServer((req, res) => {
    if (req.url?.startsWith('/api/events')) {
      connections++
      const q = new URL(req.url, 'http://127.0.0.1').searchParams
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ event: 'doorbell:probe', data: { nodeId: q.get('nodeId'), instanceId: q.get('instanceId'), connectionId: 'test-connection', probeId: 'test-probe' } }) + '\n\n')
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 30)
      req.on('close', () => clearInterval(timer))
    } else {
      acks++; req.resume(); res.writeHead(200, { 'Content-Length': '100' }); res.write('{')
      setTimeout(() => res.destroy(), 10)
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const child = spawn(process.execPath, [path.resolve('../../scripts/mesh-sse-doorbell.mjs'), 'dev:seat'], { env: { ...process.env, MESH_RELAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, stdio: ['ignore','pipe','pipe'] })
  let output = ''; child.stdout.on('data', b => output += b)
  try { await until(() => connections >= 2 && acks >= 2); assert.equal(output, '') }
  finally { child.kill('SIGKILL'); await once(child, 'exit'); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})

it('wake ACK accepted but truncated response retries and prints exactly one business completion', async () => {
  const { createServer: httpServer } = await import('node:http')
  let wakeAcks = 0; let acceptedAt = 0
  const server = httpServer((req, res) => {
    if (req.url?.startsWith('/api/events')) {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ event: 'doorbell:message', data: { nodeId: q.get('nodeId'), instanceId: q.get('instanceId'), connectionId: 'test-connection', wakeId: 'test-wake' } }) + '\n\n')
    } else {
      wakeAcks++; req.resume()
      if (!acceptedAt) acceptedAt = Date.now()
      if (wakeAcks === 1) { res.writeHead(200, { 'Content-Length': '100' }); res.write('{'); setTimeout(() => res.destroy(), 10) }
      else { res.writeHead(200); res.end(JSON.stringify({ ok: true, acceptedAt })) }
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const child = spawn(process.execPath, [path.resolve('../../scripts/mesh-sse-doorbell.mjs'), 'dev:seat'], { env: { ...process.env, MESH_RELAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, stdio: ['ignore','pipe','pipe'] })
  let output = ''; child.stdout.on('data', b => output += b)
  try {
    await until(() => child.exitCode !== null)
    assert.equal(child.exitCode, 0); assert.equal(wakeAcks, 2)
    assert.equal(output.trim().split('\n').length, 1)
    assert.equal(JSON.parse(output).data.wakeId, 'test-wake')
  } finally { child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})
