/** Ledger/D1 附件边界：只存/转发 manifest 元数据，不含图片正文或本地派生路径。 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ImageAttachmentManifest, LedgerUplinkEvent, MeshMessage } from "@cc-mesh/protocol"
import { Store as RelayStore } from "@cc-mesh/relay/dist/store.js"
import { LedgerSync } from "@cc-mesh/relay/dist/ledger_sync.js"
import { LedgerStore } from "./store.js"
import { Projector } from "./projector.js"
import { D1Forwarder, type FetchInit, type FetchResponseLike } from "./forwarder.js"

const SHA = "a".repeat(64)
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const PNG = Buffer.from(PNG_BASE64, "base64")

function manifest(): ImageAttachmentManifest {
  return {
    version: 1, id: `att-${SHA}`, kind: "image", mime: "image/png", size: 68,
    sha256: SHA, width: 1, height: 1, storageRef: `hub-blob:${SHA}`,
    createdAt: "2026-08-28T12:00:00.000Z", expiresAt: "2026-08-28T13:00:00.000Z",
  }
}

describe("attachment manifest in Ledger/D1", () => {
  it("真实 Store→LedgerSync→Projector→D1 只传 manifest，主库/WAL 均无图片正文", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-ledger-attachment-"))
    const relayDb = path.join(root, "mesh.db")
    const ledgerDb = path.join(root, "ledger.db")
    const relay = new RelayStore(relayDb)
    const store = new LedgerStore(ledgerDb)
    try {
      const wire: MeshMessage = {
        id: "msg-image-1", from: "mini:cc-a", to: "computer2:cc-b", type: "chat",
        payload: "请看图", meta: { attachments: [manifest()] }, createdAt: "2026-08-28T12:00:01.000Z",
      }
      relay.saveMessage(wire, "delivered", "normal")

      let batch: LedgerUplinkEvent[] = []
      const sync = new LedgerSync({
        store: relay,
        relayId: "relay-mini",
        env: { MESH_LEDGER_SYNC: "1" },
        uplink: {
          isConnected: () => true,
          sendLedger: (_relayId, events) => { batch = structuredClone(events) },
        },
      })
      assert.equal(sync.flush(), 1)
      assert.equal(batch.length, 1)
      assert.deepEqual((batch[0] as any).msg.meta.attachments, [manifest()])

      const projector = new Projector(store)
      assert.equal(projector.ingest(batch, "relay-mini").inserted, 1)
      const hot = store.getMessage("msg-image-1")!
      assert.equal(hot.payload, "请看图")
      assert.deepEqual((hot.meta as any).attachments, [manifest()])

      const calls: Array<{ url: string; init: FetchInit; doc: any }> = []
      const fetchImpl = async (url: string, init: FetchInit): Promise<FetchResponseLike> => {
        calls.push({ url, init, doc: JSON.parse(init.body) })
        return { status: 200, text: async () => '{"ok":true}' }
      }
      const fwd = new D1Forwarder({
        store, url: "https://d1.invalid", token: "test-token", fetchImpl, quiet: true,
      })
      const result = await fwd.flushOnce()
      assert.equal(result.ok, true)
      const serialized = JSON.stringify(calls.map((c) => c.doc))
      assert.equal(serialized.includes("请看图"), true, "文本正文按既有账本语义保留")
      assert.equal(serialized.includes(`hub-blob:${SHA}`), true, "manifest 元数据需可对账")
      for (const forbidden of [PNG_BASE64, "data:image", "localPath", "test-token"]) {
        assert.equal(serialized.includes(forbidden), false, `D1 batch 不得含 ${forbidden}`)
      }

      for (const db of [relayDb, ledgerDb]) {
        assert.equal(fs.existsSync(db), true)
        assert.equal(fs.existsSync(`${db}-wal`), true, `${path.basename(db)} 应处于真实 WAL 模式`)
        for (const file of [db, `${db}-wal`]) {
          const raw = fs.readFileSync(file)
          assert.equal(raw.indexOf(PNG), -1, `${path.basename(file)} 不得含 PNG 原始字节`)
          const text = raw.toString("latin1")
          for (const forbidden of [PNG_BASE64, "data:image", "localPath", "test-token"]) {
            assert.equal(text.includes(forbidden), false, `${path.basename(file)} 不得含 ${forbidden}`)
          }
        }
      }
    } finally {
      try { relay.close() } catch { /* already closed */ }
      store.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
