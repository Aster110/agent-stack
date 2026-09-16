import { it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { createHub } from './hub.js'

it('authenticated relay may report only its seats; other relay broadcasts do not renew evidence', async () => {
  const hub = await createHub({ port: 0 })
  const a = new WebSocket(`ws://127.0.0.1:${hub.port}`)
  const b = new WebSocket(`ws://127.0.0.1:${hub.port}`)
  const rogue = new WebSocket(`ws://127.0.0.1:${hub.port}`)
  const messages: any[] = []
  a.on('message', raw => messages.push(JSON.parse(String(raw))))
  await Promise.all([once(a, 'open'), once(b, 'open'), once(rogue, 'open')])
  const send = (ws: WebSocket, data: any) => ws.send(JSON.stringify(data))
  const reg = (device: string) => ({ type: 'register', relay: { relayId: device, deviceId: device, connectedAt: new Date().toISOString(), nodes: [{ nodeId: device + ':seat', deviceId: device, shortId: 'seat', role: 'main', description: '', capabilities: [], deliveryMode: 'pull' }] } })
  const status = (nodeId: string) => ({ nodeId, state: 'listening', instanceId: 'test-instance', connected: true, lastAckAt: new Date().toISOString(), lastSyncAt: null, lastExecutionStartedAt: null, observedAt: 'stale-clock', expiresAt: 'stale-clock', validForMs: 80 })
  try {
    send(a, reg('a')); send(b, reg('b')); await delay(40)
    send(a, { type: 'listener_status', listeners: [status('a:seat')] }); await delay(30)
    const first = messages.at(-1).devices.find((d: any) => d.deviceId === 'a').listeners[0]
    assert.equal(first.state, 'listening')
    assert.ok(Number.isFinite(Date.parse(first.expiresAt)))
    send(rogue, { type: 'listener_status', listeners: [status('a:seat')] })
    send(b, { type: 'listener_status', listeners: [status('a:seat')] })
    await delay(100)
    send(b, { type: 'listener_status', listeners: [status('b:seat')] }); await delay(30)
    const after = messages.at(-1).devices.find((d: any) => d.deviceId === 'a').listeners[0]
    assert.equal(after.expiresAt, first.expiresAt)
    assert.equal(after.state, 'lost')
  } finally { a.terminate(); b.terminate(); rogue.terminate(); await hub.close() }
})
