import fs from "node:fs"
import path from "node:path"
import type { DeviceInventory } from "@cc-mesh/protocol"
import { cacheDir } from "./paths.js"

export class DeviceRegistryCache {
  private devices: DeviceInventory[] = []
  private currentSource: "hub" | "cache" = "cache"

  constructor(
    private file = path.join(cacheDir(), "devices.json"),
  ) {
    this.load()
  }

  list(): DeviceInventory[] {
    return this.devices.map(d => ({ ...d, listeners: d.listeners?.map(s => ({ ...s,
      state: (s.state === 'listening' || s.state === 'waking' || s.expiresAt !== null)
        && (!s.expiresAt || !Number.isFinite(Date.parse(s.expiresAt)) || Date.parse(s.expiresAt) <= Date.now()) ? 'lost' : s.state,
    })) }))
  }

  source(): "hub" | "cache" {
    return this.currentSource
  }

  update(devices: DeviceInventory[], source: "hub" | "cache" = "hub"): void {
    const receivedAt = Date.now()
    this.devices = devices.map(d => ({ ...d, listeners: d.listeners?.map(s => ({ ...s,
      // Hub emits remaining TTL on EVERY broadcast; translate once to this clock.
      observedAt: new Date(receivedAt).toISOString(),
      expiresAt: s.expiresAt === null ? null : new Date(receivedAt + Math.min(60_000, Math.max(0, Number.isFinite(s.validForMs) ? s.validForMs : 0))).toISOString(),
    })) }))
    this.currentSource = source
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.devices, null, 2), "utf8")
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as DeviceInventory[]
      if (Array.isArray(raw)) {
        this.devices = raw
        this.currentSource = "cache"
      }
    } catch {
      this.devices = []
      this.currentSource = "cache"
    }
  }
}
