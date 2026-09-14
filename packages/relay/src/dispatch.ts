/**
 * 派单接口层（IDispatcher，v1 = DirectDispatcher）
 * 设计：features/云端账本与调度接口-设计-2026-08-27.md §6。
 *
 * 稳定点只有三处：pick / dispatch 两个动词 + pick.reason 必须记账。
 * 升级调度算法（v2 查表 + 额度闸门、v3 按余量挑座）= 换一个 pick() 实现，
 * 调用方（/api/dispatch、主脑、CLI、将来 web）一行不改。
 *
 * v1 零智能：显式指定席位的直达投递——"给 mesh send 穿了件任务马甲"。
 */
import type { DispatchTask, SeatPick } from "@cc-mesh/protocol"

/** 派单被拒（缺 to / 目标不可达）。带 status 让 HTTP 层直接映射，不用猜错误类型。 */
export class DispatchError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "DispatchError"
    this.status = status
  }
}

/** 选座器。v2/v3 只换这个实现（届时 pick 可升级为 async + ClusterView 入参）。 */
export interface Dispatcher {
  pick(task: DispatchTask): SeatPick
}

/**
 * 目标解析：别名/短名 → 可投递的 nodeId；不可达返回 null。
 * relay 侧注入的是 server 的 validateFullNodeId（完整 nodeId + 在线校验），
 * 单测里注入假的即可——DirectDispatcher 自己不认识 registry。
 */
export type TargetResolver = (to: string) => string | null

export class DirectDispatcher implements Dispatcher {
  private readonly resolveTarget: TargetResolver

  constructor(resolveTarget: TargetResolver = (to) => to) {
    this.resolveTarget = resolveTarget
  }

  pick(task: DispatchTask): SeatPick {
    const to = typeof task.to === "string" ? task.to.trim() : ""
    if (!to) {
      // v1 必填：不猜席位。将来的 TableDispatcher 在这里查表而不是抛。
      throw new DispatchError("missing required field: to (v1 DirectDispatcher 只做显式直达，不猜席位)")
    }
    const nodeId = this.resolveTarget(to)
    if (!nodeId) {
      throw new DispatchError(`target must be full nodeId (device:shortId) and online, got: ${to}`)
    }
    // reason 是给将来的对照数据："当时为什么派给它"。v1 恒 explicit。
    return { nodeId, reason: "explicit" }
  }
}
