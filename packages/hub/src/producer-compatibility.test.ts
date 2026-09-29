import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { createHub } from './hub.js'
import { TokenAuth } from './auth.js'
import { createServer } from '@cc-mesh/relay/dist/server.js'
import { LedgerSync } from '@cc-mesh/relay/dist/ledger_sync.js'
import { WebSocketUplink } from '@cc-mesh/relay/dist/uplink/websocket.js'
import { CompositeTransport } from '@cc-mesh/relay/dist/transport/composite.js'

const run = promisify(execFile), pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms))
const root = process.env.MESH_TEST_PRODUCER_ROOT ?? path.resolve(__dirname, '../../..')
const terminal = { inject: async () => true, spawn: async () => ({ sessionId: 'fixture' }),
  isAlive: async () => true, close: async () => {}, getCurrentSession: async () => null }
const cases = ['send', 'send-empty', 'dispatch', 'dispatch-empty', 'broadcast', 'broadcast-empty',
  'quota-default', 'quota-empty', 'quota-short', 'quota-full', 'wake', 'transport'] as const

for (const producer of cases) test(`producer compatibility: ${producer} keeps a complete local author on the existing Hub`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-contract-'))
  const hub = await createHub({ host: '127.0.0.1', port: 0, auth: new TokenAuth('fixture-shared'), ledger: { dbPath: ':memory:', quiet: true } })
  const deviceId = process.env.MESH_TEST_DEVICE ?? 'fixture-device', sender = producer === 'quota-full' ? `${deviceId}:quota-seat` : `${deviceId}:relay`
  const registration = (device: string) => ({ deviceId: device, relayId: `${device}-1`, connectedAt: new Date().toISOString(),
    nodes: [{ nodeId: `${device}:main`, deviceId: device, shortId: 'main', role: 'main' as const, description: '', capabilities: [] }] })
  const peer = new WebSocket(`ws://127.0.0.1:${hub.port}`)
  const received: any[] = []; peer.on('message', bytes => received.push(JSON.parse(String(bytes))))
  const uplink = new WebSocketUplink({ hubUrl: `ws://127.0.0.1:${hub.port}`, token: 'fixture-shared', ackTimeoutMs: 500,
    getRegistration: () => registration(deviceId) })
  const transport = new CompositeTransport(terminal, uplink, { deviceId })
  const app = createServer({ dbPath: ':memory:', deviceId, terminal, transport })
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const sync = new LedgerSync({ store: app.store, uplink, relayId: `${deviceId}-1`, batch: 1 })
  try {
    await new Promise<void>((resolve, reject) => { peer.once('open', resolve); peer.once('error', reject) })
    peer.send(JSON.stringify({ type: 'register', relay: registration('peer'), token: 'fixture-shared' }))
    await uplink.connect(); await pause(); sync.start()
    const post = async (route: string, body: unknown, empty = false) => {
      const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...(empty ? { 'X-Mesh-Node': '' } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) })
      assert.equal(response.status, 200)
    }
    if (producer.startsWith('send')) await post('send', { to: '@ledger', message: producer }, producer.endsWith('empty'))
    else if (producer.startsWith('dispatch')) await post('dispatch', { to: 'peer:main', title: producer, payload: producer }, producer.endsWith('empty'))
    else if (producer.startsWith('broadcast')) await post('broadcast', { message: producer }, producer.endsWith('empty'))
    else if (producer.startsWith('quota')) {
      const input = path.join(dir, 'probe.json'); fs.writeFileSync(input, JSON.stringify({ schema_version: '1', source: 'claude', host: 'not-the-device', account_id: 'fixture-account', probed_at: new Date().toISOString(), status: 'unavailable', plan_type: null, limits: [] }))
      const from = producer === 'quota-empty' ? ['--from', ''] : producer === 'quota-short' ? ['--from', 'old-host-quota'] : producer === 'quota-full' ? ['--from', sender] : []
      await run('bash', [path.join(root, 'scripts/quota-probe/report-quota.sh'), '--input', input, '--relay', base, '--send', ...from], { timeout: 5000, env: { ...process.env, HOME: dir, MESH_NODE: '' } })
    } else if (producer === 'wake') {
      const audit = fs.readFileSync(path.join(root, 'scripts/wake-hook.sh'), 'utf8').match(/^audit\(\) \{[\s\S]*?^\}/m)?.[0]; assert.ok(audit)
      await run('bash', ['-c', `log() { :; }\n${audit}\naudit fixture-device:main pass fixture-note`], { timeout: 5000, env: { ...process.env, HOME: dir, RELAY_URL: base, WAKE_ID: 'fixture', MESH_NODE: '' } })
    } else assert.equal((await transport.deliver({ type: 'remote', deviceId: 'peer', nodeId: 'peer:main' }, producer)).delivered, true)
    sync.flush(); await pause(150)
    const rows = hub.ledger!.store.listMessages({})
    // The existing Hub routes direct transport messages but does not itself ingest
    // them. Preserve that behavior; LedgerSync owns persistence for HTTP producers.
    assert.equal(rows.length, producer === 'transport' ? 0 : 1)
    if (producer !== 'transport') {
      assert.equal(rows[0]!.from, sender, 'normal producer must use its configured device, not hostname/unknown/empty')
      assert.equal(rows[0]!.srcRelay, `${deviceId}-1`)
      assert.equal(sync.cursor(), 1)
    }
    if (producer.startsWith('dispatch')) assert.equal(hub.ledger!.store.getTask(rows[0]!.id)?.fromNode, sender)
    if (producer.startsWith('quota')) assert.equal(hub.ledger!.store.latestQuota()[0]?.accountFp, 'fixture-account')
    // Broadcast's existing contract is local fanout plus ledger, not remote fanout.
    if (producer.startsWith('dispatch') || producer === 'transport') assert.ok(received.some(f => f.type === 'message' && f.msg.from === sender))
    await post('send', { to: '@ledger', message: 'followup' }); sync.flush(); await pause(150)
    assert.equal(hub.ledger!.store.listMessages({}).length, producer === 'transport' ? 1 : 2, 'next good row is not starved')
  } finally {
    sync.stop(); await uplink.disconnect(); peer.terminate(); app.closeDoorbell()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    app.store.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
})
