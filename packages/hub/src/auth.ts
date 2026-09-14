/**
 * IAuth — Hub 鉴权接口（Phase 2.2 预留）
 *
 * V1: NoAuth（全放行）
 * 以后加 TokenAuth、JWTAuth 等实现
 */
import { timingSafeEqual } from "node:crypto"

export interface IAuth {
  /** 验证 relay 连接，返回 true 放行 */
  verify(token: string | undefined, relayId: string): Promise<boolean>
}

/** 不鉴权，全放行（自用阶段） */
export class NoAuth implements IAuth {
  async verify(_token?: string, _relayId?: string): Promise<boolean> {
    return true
  }
}

/**
 * 固定 token 鉴权：register 消息带的 token 非空且与期望值恒定时间相等才放行。
 *
 * - 用 crypto.timingSafeEqual 做恒定时间比较，防止按字节提前返回的时序侧信道。
 * - timingSafeEqual 要求两 buffer 等长，否则抛错；所以先挡空 token、再挡长度不等
 *   （长度本就无法通过恒定时间比较隐藏，先返回 false 是标准做法）。
 * - relayId 参数当前忽略（共享 token 模式，不区分 relay）。
 */
export class TokenAuth implements IAuth {
  private readonly expected: Buffer

  constructor(expectedToken: string) {
    this.expected = Buffer.from(expectedToken, "utf8")
  }

  async verify(token: string | undefined, _relayId?: string): Promise<boolean> {
    if (!token) return false
    const got = Buffer.from(token, "utf8")
    // 长度不等：直接拒绝（也避免 timingSafeEqual 抛错）
    if (got.length !== this.expected.length) return false
    return timingSafeEqual(got, this.expected)
  }
}
