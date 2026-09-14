import type { MeshMessage, LocalNode, RouteResult } from "@cc-mesh/protocol"
import { parseNodeId } from "@cc-mesh/protocol"
import type { Registry } from "./registry.js"

export class Router {
  private registry: Registry
  private localDeviceId: string

  constructor(registry: Registry, localDeviceId: string) {
    this.registry = registry
    this.localDeviceId = localDeviceId
  }

  route(msg: MeshMessage): RouteResult {
    const { to } = msg

    // 广播
    if (to === "*") {
      const targets = this.registry.getAll().filter(n => n.identity.nodeId !== msg.from)
      return { action: "broadcast", targets }
    }

    // 空目标
    if (!to) {
      return { action: "not_found" }
    }

    // 必须是完整 nodeId（"device:short"）——裸 shortId / role 别名不再支持
    if (!to.includes(":")) {
      return { action: "not_found" }
    }

    // 解析目标 deviceId
    const { deviceId } = parseNodeId(to)

    // 远端设备 → Phase 2.0：返回 uplink，由 transport/uplink 层负责投递
    if (deviceId !== this.localDeviceId) {
      return { action: "uplink" }
    }

    // 本地设备 → 查注册表
    const target = this.registry.get(to)
    if (target) {
      return { action: "local", target }
    }

    return { action: "not_found" }
  }
}
