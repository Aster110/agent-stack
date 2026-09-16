import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ListenerStatus } from '@cc-mesh/protocol'

type Send = (event: string, data: Record<string, unknown>) => void
interface Binding {
  nodeId: string; instanceId: string; connectionId: string; connected: boolean
  created: number; ack: number | null; probes: Map<string, number>
  wakeId?: string; wakeIssued?: number; waking?: number; started?: boolean
  send: Send; close: () => void
}
/** Ephemeral transport evidence only: deliberately has no Registry or Store reference. */
export class DoorbellMonitor {
  private bindings = new Map<string, Binding>()
  private retired = new Map<string, Set<string>>()
  private execution = new Map<string, string>()
  private generations = new Map<string, string>()
  constructor(readonly ttlMs = 60_000, readonly wakeMs = 60_000, private clock = Date.now, private fenceFile?: string) {
    if (fenceFile && fs.existsSync(fenceFile)) {
      const saved = JSON.parse(fs.readFileSync(fenceFile, 'utf8'))
      this.generations = new Map(saved.current)
      this.retired = new Map(saved.retired.map(([id, values]: [string, string[]]) => [id, new Set(values)]))
    }
  }
  private persistFence(): void {
    if (!this.fenceFile) return
    fs.mkdirSync(path.dirname(this.fenceFile), { recursive: true })
    const tmp = this.fenceFile + '.tmp'
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify({ current: [...this.generations], retired: [...this.retired].map(([k, v]) => [k, [...v]]) }))
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, this.fenceFile)
  }

  canBind(nodeId: string, instanceId: string): boolean {
    return !this.retired.get(nodeId)?.has(instanceId)
  }
  bind(nodeId: string, instanceId: string, send: Send, close: () => void): Binding {
    if (!this.canBind(nodeId, instanceId)) throw new Error('instance superseded')
    const prev = this.bindings.get(nodeId)
    const oldInstance = this.generations.get(nodeId)
    if (oldInstance && oldInstance !== instanceId) {
      const set = this.retired.get(nodeId) ?? new Set<string>()
      set.add(oldInstance); this.retired.set(nodeId, set)
    }
    this.generations.set(nodeId, instanceId)
    this.persistFence() // fence survives relay restart; liveness deliberately does not
    const b: Binding = { nodeId, instanceId, connectionId: randomUUID(), connected: true,
      created: this.clock(), ack: null, probes: new Map(), send, close }
    // Set first: old socket close callback cannot invalidate its replacement.
    this.bindings.set(nodeId, b)
    if (prev) {
      if (prev.instanceId !== instanceId) {
        const set = this.retired.get(nodeId) ?? new Set<string>()
        set.add(prev.instanceId); this.retired.set(nodeId, set)
      }
      prev.send('doorbell:replaced', { nodeId, instanceId: prev.instanceId })
      prev.close()
    }
    return b
  }
  probe(nodeId: string): void {
    const b = this.bindings.get(nodeId)
    if (!b?.connected || b.waking !== undefined) return
    const t = this.clock()
    for (const [id, at] of b.probes) if (t - at >= this.ttlMs) b.probes.delete(id)
    const probeId = randomUUID(); b.probes.set(probeId, t)
    b.send('doorbell:probe', { ...this.identity(b), probeId, ttlMs: this.ttlMs })
  }
  message(nodeId: string, msgId?: string): void {
    const b = this.bindings.get(nodeId)
    if (!b?.connected || b.waking !== undefined || b.wakeId) return
    b.wakeId = randomUUID(); b.wakeIssued = this.clock()
    b.send('doorbell:message', { ...this.identity(b), wakeId: b.wakeId, msgId: msgId ?? null })
  }
  private identity(b: Binding) {
    return { nodeId: b.nodeId, instanceId: b.instanceId, connectionId: b.connectionId }
  }
  private match(body: any): Binding | undefined {
    const b = this.bindings.get(body?.nodeId)
    return b && b.instanceId === body.instanceId && b.connectionId === body.connectionId ? b : undefined
  }
  ack(body: any): boolean {
    const b = this.match(body); const t = this.clock()
    if (!b?.connected) return false
    if (body.phase === 'waking') {
      if (!b.wakeId || body.wakeId !== b.wakeId || t - b.wakeIssued! >= this.ttlMs) return false
      if (b.waking === undefined) { b.waking = t; b.probes.clear() }
      return true // retry is idempotent and never extends grace
    }
    if (b.waking !== undefined) return false
    const issued = b.probes.get(body.probeId)
    if (issued === undefined || t - issued >= this.ttlMs) return false
    b.probes.delete(body.probeId); b.ack = t
    return true
  }
  started(body: any): boolean {
    const b = this.match(body)
    if (!b || b.waking === undefined || !b.wakeId || b.wakeId !== body.wakeId || this.clock() - b.waking >= this.wakeMs) return false
    if (!b.started) {
      const at = new Date(this.clock()).toISOString()
      this.execution.set(b.nodeId, at); b.started = true
    }
    return true
  }
  disconnect(nodeId: string, connectionId: string): void {
    const b = this.bindings.get(nodeId)
    if (b?.connectionId === connectionId) { b.connected = false; b.probes.clear() }
  }
  forget(nodeId: string): void {
    const b = this.bindings.get(nodeId)
    this.bindings.delete(nodeId); this.retired.delete(nodeId); this.generations.delete(nodeId); this.execution.delete(nodeId)
    this.persistFence()
    b?.close()
  }
  status(nodeId: string, lastSyncAt: string | null = null): ListenerStatus {
    const b = this.bindings.get(nodeId); const t = this.clock()
    let state: ListenerStatus['state'] = 'unknown'; let until: number | null = null
    if (b) {
      if (b.waking !== undefined) { until = b.waking + this.wakeMs; state = t < until ? 'waking' : 'lost' }
      else if (!b.connected) state = 'lost'
      else if (b.ack !== null) { until = b.ack + this.ttlMs; state = t < until ? 'listening' : 'lost' }
      else { until = b.created + this.ttlMs; if (t >= until) state = 'lost' }
    }
    return { nodeId, state, instanceId: b?.instanceId ?? null, connected: b?.connected ?? false,
      lastAckAt: b?.ack !== null && b?.ack !== undefined ? new Date(b.ack).toISOString() : null,
      lastSyncAt, lastExecutionStartedAt: this.execution.get(nodeId) ?? null,
      observedAt: new Date(t).toISOString(), expiresAt: until === null ? null : new Date(until).toISOString(),
      validForMs: until === null ? 0 : Math.max(0, until - t) }
  }
  close(): void { for (const b of this.bindings.values()) b.close(); this.bindings.clear(); this.retired.clear(); this.execution.clear() }
}
