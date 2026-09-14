/**
 * Tests for msg_audit module.
 *
 * Verifies:
 * - Messages saved to Store are queryable via auditMessages()
 * - payload_hash is correctly computed (sha256 of payload)
 * - Filters (from/to/type) work
 * - countMessages returns accurate counts
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { Store } from "./store.js"
import { auditMessages, computePayloadHash, countMessages } from "./msg_audit.js"
import type { MeshMessage } from "@cc-mesh/protocol"
import { now } from "@cc-mesh/protocol"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

function tmpDb(): string {
  return path.join(os.tmpdir(), `msg-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

function makeMsg(overrides: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    from: overrides.from ?? "node_alpha",
    to: overrides.to ?? "node_beta",
    type: (overrides.type ?? "chat") as MeshMessage["type"],
    payload: overrides.payload ?? "hello",
    replyTo: overrides.replyTo,
    createdAt: overrides.createdAt ?? now(),
  }
}

describe("msg_audit", () => {
  describe("computePayloadHash", () => {
    it("computes sha256 of string payload", () => {
      assert.equal(
        computePayloadHash("hello"),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
      )
    })

    it("treats null as empty string", () => {
      assert.equal(computePayloadHash(null), computePayloadHash(""))
    })

    it("differs for different inputs", () => {
      assert.notEqual(computePayloadHash("a"), computePayloadHash("b"))
    })
  })

  describe("auditMessages", () => {
    let dbPath: string
    let store: Store

    before(() => {
      dbPath = tmpDb()
      store = new Store(dbPath)
    })

    after(() => {
      try {
        fs.unlinkSync(dbPath)
      } catch {}
    })

    it("returns saved messages with payload_hash computed", () => {
      const msg = makeMsg({ id: "m_audit_1", from: "worker_a_n", to: "main_cc_n", payload: "done" })
      store.saveMessage(msg)
      const rows = auditMessages(store, { from: "worker_a_n" })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].id, "m_audit_1")
      assert.equal(rows[0].from, "worker_a_n")
      assert.equal(rows[0].to, "main_cc_n")
      assert.equal(rows[0].payload, "done")
      assert.equal(rows[0].payload_hash, computePayloadHash("done"))
    })

    it("filters by from", () => {
      store.saveMessage(makeMsg({ id: "m_f1", from: "filter_test_a", to: "x", payload: "p1" }))
      store.saveMessage(makeMsg({ id: "m_f2", from: "filter_test_b", to: "x", payload: "p2" }))
      const rows = auditMessages(store, { from: "filter_test_a" })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].from, "filter_test_a")
    })

    it("filters by to", () => {
      store.saveMessage(makeMsg({ id: "m_t1", from: "x", to: "to_test_a", payload: "p" }))
      store.saveMessage(makeMsg({ id: "m_t2", from: "x", to: "to_test_b", payload: "p" }))
      const rows = auditMessages(store, { to: "to_test_a" })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].to, "to_test_a")
    })

    it("respects limit", () => {
      // Add several messages to ensure limit clamps
      for (let i = 0; i < 5; i++) {
        store.saveMessage(makeMsg({ id: `m_lim_${i}`, from: "limit_test_node", to: "x", payload: "p" }))
      }
      const rows = auditMessages(store, { from: "limit_test_node", limit: 2 })
      assert.equal(rows.length, 2)
    })

    it("returns empty when no messages match", () => {
      const rows = auditMessages(store, { from: "no_such_node_xyz" })
      assert.equal(rows.length, 0)
    })
  })

  describe("countMessages", () => {
    let dbPath: string
    let store: Store

    before(() => {
      dbPath = tmpDb()
      store = new Store(dbPath)
    })

    after(() => {
      try {
        fs.unlinkSync(dbPath)
      } catch {}
    })

    it("counts with filters", () => {
      store.saveMessage(makeMsg({ id: "c1", from: "count_a", to: "x", payload: "p" }))
      store.saveMessage(makeMsg({ id: "c2", from: "count_a", to: "x", payload: "p" }))
      store.saveMessage(makeMsg({ id: "c3", from: "count_b", to: "x", payload: "p" }))
      assert.equal(countMessages(store, { from: "count_a" }), 2)
      assert.equal(countMessages(store, { from: "count_b" }), 1)
      assert.equal(countMessages(store, { from: "no_such_node" }), 0)
    })
  })
})
