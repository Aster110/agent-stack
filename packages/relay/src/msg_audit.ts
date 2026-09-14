/**
 * msg_audit: query mesh.db's messages table for audit purposes.
 *
 * P98/19 + 20 design decision (2026-04-26):
 * - mesh.db already stores every message (from/to/type/payload/ts) via Store.saveMessage()
 * - No need to create a separate ~/.ccmesh/msg_audit.sqlite — would be double-write
 * - This module wraps queries for audit needs (multi-worker test-harness scenarios)
 *
 * Usage:
 *   import { auditMessages, computePayloadHash } from "./msg_audit"
 *   const rows = auditMessages(store, { from: "worker_a_node", since: "2026-04-26" })
 */

import { createHash } from "node:crypto"
import type { Store } from "./store"

export interface AuditQuery {
  from?: string
  to?: string
  type?: string
  since?: string  // ISO8601
  limit?: number
}

export interface AuditRow {
  id: string
  from: string
  to: string
  type: string
  payload: string | null
  payload_hash: string  // sha256 of payload (for tamper-evident audit chain)
  status: string
  created_at: string
  delivered_at: string | null
}

/**
 * Compute sha256 hex digest of a payload string (or "" for null).
 * Used to detect tampering in audit logs even if payload is later mutated.
 */
export function computePayloadHash(payload: string | null): string {
  return createHash("sha256").update(payload ?? "").digest("hex")
}

/**
 * Query messages with optional filters. Returns audit rows with payload_hash computed.
 */
export function auditMessages(store: Store, query: AuditQuery = {}): AuditRow[] {
  // Use store's underlying db via a public method we add below
  const db = (store as any).db as import("better-sqlite3").Database
  const conditions: string[] = []
  const params: unknown[] = []

  if (query.from) {
    conditions.push(`"from" = ?`)
    params.push(query.from)
  }
  if (query.to) {
    conditions.push(`"to" = ?`)
    params.push(query.to)
  }
  if (query.type) {
    conditions.push(`type = ?`)
    params.push(query.type)
  }
  if (query.since) {
    conditions.push(`created_at >= ?`)
    params.push(query.since)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  const limit = Math.max(1, Math.min(query.limit ?? 1000, 10000))

  const sql = `
    SELECT id, "from", "to", type, payload, status, created_at, delivered_at
    FROM messages
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as Omit<AuditRow, "payload_hash">[]
  return rows.map((r) => ({
    ...r,
    payload_hash: computePayloadHash(r.payload),
  }))
}

/**
 * Count messages matching query (for stats / dashboards).
 */
export function countMessages(store: Store, query: AuditQuery = {}): number {
  const db = (store as any).db as import("better-sqlite3").Database
  const conditions: string[] = []
  const params: unknown[] = []

  if (query.from) {
    conditions.push(`"from" = ?`)
    params.push(query.from)
  }
  if (query.to) {
    conditions.push(`"to" = ?`)
    params.push(query.to)
  }
  if (query.type) {
    conditions.push(`type = ?`)
    params.push(query.type)
  }
  if (query.since) {
    conditions.push(`created_at >= ?`)
    params.push(query.since)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  const sql = `SELECT COUNT(*) as cnt FROM messages ${whereClause}`
  const row = db.prepare(sql).get(...params) as { cnt: number }
  return row.cnt
}
