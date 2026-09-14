/** 通知是推过来的、消费是拉的，中间要一个不丢事件的缓冲。 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { EventQueue } from "./event-queue.js"

async function collect<T>(q: EventQueue<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of q.drain()) out.push(x)
  return out
}

describe("EventQueue", () => {
  it("先 push 后 drain：顺序不乱，close 后生成器收尾", async () => {
    const q = new EventQueue<number>()
    q.push(1)
    q.push(2)
    q.push(3)
    q.close()
    assert.deepEqual(await collect(q), [1, 2, 3])
  })

  it("drain 在等待时被 push 唤醒（不是靠轮询）", async () => {
    const q = new EventQueue<string>()
    const p = collect(q)
    // 让 drain 先跑到 await
    await new Promise((r) => setTimeout(r, 5))
    q.push("a")
    await new Promise((r) => setTimeout(r, 5))
    q.push("b")
    q.close()
    assert.deepEqual(await p, ["a", "b"])
  })

  it("close 之后再 push 一律丢弃", async () => {
    const q = new EventQueue<number>()
    q.push(1)
    q.close()
    q.push(2)
    assert.deepEqual(await collect(q), [1])
  })

  it("size 反映未消费的量", () => {
    const q = new EventQueue<number>()
    assert.equal(q.size, 0)
    q.push(1)
    q.push(2)
    assert.equal(q.size, 2)
  })

  it("空队列 close 后 drain 立刻结束，不挂住", async () => {
    const q = new EventQueue<number>()
    q.close()
    assert.deepEqual(await collect(q), [])
  })
})
