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
    return this.devices
  }

  source(): "hub" | "cache" {
    return this.currentSource
  }

  update(devices: DeviceInventory[], source: "hub" | "cache" = "hub"): void {
    this.devices = devices
    this.currentSource = source
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(devices, null, 2), "utf8")
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
