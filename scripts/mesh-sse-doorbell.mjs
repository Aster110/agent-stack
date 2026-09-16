#!/usr/bin/env node
// A host-owned background task. Only its SSE read loop may ACK; no model calls.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const nodeId = process.argv[2]
if (!nodeId?.includes(':')) { process.stderr.write('usage: mesh-sse-doorbell.mjs device:seat\n'); process.exit(1) }
const base = new URL(process.env.MESH_RELAY_URL || 'http://127.0.0.1:19800')
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  process.stderr.write('doorbell requires local HTTP relay\n'); process.exit(1)
}
const instanceId = randomUUID()
let replaced = false
let wake = null

function post(action, body) {
  return new Promise((resolve, reject) => {
    let done = false
    let req
    const finish = (error, value) => {
      if (done) return
      done = true; clearTimeout(deadline)
      if (error) { req?.destroy(); reject(error) } else resolve(value)
    }
    const deadline = setTimeout(() => finish(new Error('ACK deadline')), 5000)
    req = http.request(new URL(`/api/doorbell/${action}`, base), { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.on('aborted', () => finish(new Error('ACK response aborted')))
      res.on('error', error => finish(error))
      res.on('close', () => { if (!res.complete) finish(new Error('ACK response truncated')) })
      res.on('end', () => finish(null, res.statusCode >= 200 && res.statusCode < 300))
      res.resume()
    })
    req.on('error', error => finish(error)); req.end(JSON.stringify(body))
  })
}
async function listen() {
  const url = new URL('/api/events', base)
  url.searchParams.set('nodeId', nodeId); url.searchParams.set('instanceId', instanceId)
  const res = await new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 75_000 }, resolve)
    req.on('timeout', () => req.destroy(new Error('SSE stalled'))); req.on('error', reject)
  })
  if (res.statusCode === 409) { replaced = true; res.resume(); return }
  if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}`) }
  // Async iteration serializes probe and message ACKs in the exact reading process.
  let buffer = ''
  for await (const chunk of res) {
    buffer += chunk.toString('utf8')
    if (buffer.length > 1_048_576) throw new Error('SSE frame too large')
    let pos
    while ((pos = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, pos); buffer = buffer.slice(pos + 2)
      const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!raw) continue
      let event
      try { event = JSON.parse(raw) } catch { continue }
      const d = event.data
      if (d?.nodeId !== nodeId || d.instanceId !== instanceId) continue
      if (event.event === 'doorbell:replaced') { replaced = true; res.destroy(); return }
      if (event.event === 'doorbell:probe') {
        if (!await post('ack', d)) throw new Error('probe fenced')
      } else if (event.event === 'doorbell:message') {
        let accepted = false
        for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
          try { accepted = await post('ack', { ...d, phase: 'waking' }) } catch {}
        }
        if (!accepted) throw new Error('wake ACK failed')
        wake = event; res.destroy(); return
      }
    }
  }
}
let backoff = 1000
while (!wake) {
  if (replaced) {
    // Do not compete with a replacement and do not wake the host on supersession.
    await delay(2_147_483_647); continue
  }
  try { await listen(); backoff = 1000 } catch { /* quiet reconnect; never a model completion */ }
  if (!wake && !replaced) { await delay(backoff); backoff = Math.min(15_000, backoff * 2) }
}
process.stdout.write(JSON.stringify(wake) + '\n')
