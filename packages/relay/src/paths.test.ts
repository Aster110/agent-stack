import { describe, it } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import {
  MESH_DIRNAME,
  meshHome,
  dbPath,
  pidPath,
  contextDir,
  profilesDir,
  cacheDir,
  pingIntervalMs,
  pongTimeoutMs,
  sendRetryCount,
} from "./paths.js"

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const original = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    fn()
  } finally {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
}

describe("paths — runtime directory layout", () => {
  it("MESH_DIRNAME 是 .ccmesh（无连字符，统一口径）", () => {
    assert.equal(MESH_DIRNAME, ".ccmesh")
  })

  it("meshHome 默认返回 $HOME/.ccmesh", () => {
    assert.equal(meshHome(), path.join(os.homedir(), ".ccmesh"))
  })

  it("meshHome 接受 home 覆盖", () => {
    assert.equal(meshHome("/tmp/fake-home"), "/tmp/fake-home/.ccmesh")
  })

  it("dbPath 默认在 meshHome/db/mesh.db 下", () => {
    const original = process.env.MESH_DB_PATH
    delete process.env.MESH_DB_PATH
    try {
      assert.equal(
        dbPath("/tmp/fake-home"),
        "/tmp/fake-home/.ccmesh/db/mesh.db",
      )
    } finally {
      if (original !== undefined) process.env.MESH_DB_PATH = original
    }
  })

  it("dbPath 优先读 MESH_DB_PATH env 覆盖默认路径", () => {
    const original = process.env.MESH_DB_PATH
    process.env.MESH_DB_PATH = "/custom/mesh.db"
    try {
      assert.equal(dbPath("/tmp/fake-home"), "/custom/mesh.db")
    } finally {
      if (original === undefined) delete process.env.MESH_DB_PATH
      else process.env.MESH_DB_PATH = original
    }
  })

  it("空字符串 MESH_DB_PATH 视为未设置", () => {
    const original = process.env.MESH_DB_PATH
    process.env.MESH_DB_PATH = ""
    try {
      assert.equal(
        dbPath("/tmp/fake-home"),
        "/tmp/fake-home/.ccmesh/db/mesh.db",
      )
    } finally {
      if (original === undefined) delete process.env.MESH_DB_PATH
      else process.env.MESH_DB_PATH = original
    }
  })

  it("pidPath 在 meshHome 下", () => {
    assert.equal(pidPath("/tmp/fake"), "/tmp/fake/.ccmesh/relay.pid")
  })

  it("contextDir 在 meshHome 下", () => {
    assert.equal(contextDir("/tmp/fake"), "/tmp/fake/.ccmesh/context")
  })

  it("profilesDir 在 meshHome 下（和 profile.ts 约定对齐）", () => {
    assert.equal(profilesDir("/tmp/fake"), "/tmp/fake/.ccmesh/agents")
  })

  it("cacheDir 在 meshHome 下（和 device-registry.ts 约定对齐）", () => {
    assert.equal(cacheDir("/tmp/fake"), "/tmp/fake/.ccmesh/cache")
  })
})

describe("paths — heartbeat / retry env 接缝（D29）", () => {
  it("pingIntervalMs 默认 30000ms", () => {
    withEnv("MESH_PING_INTERVAL_MS", undefined, () => {
      assert.equal(pingIntervalMs(), 30000)
    })
  })

  it("pingIntervalMs 读 MESH_PING_INTERVAL_MS env 覆盖默认", () => {
    withEnv("MESH_PING_INTERVAL_MS", "20000", () => {
      assert.equal(pingIntervalMs(), 20000)
    })
  })

  it("pingIntervalMs 兜底:env 太小或非法时走最小 100ms", () => {
    withEnv("MESH_PING_INTERVAL_MS", "10", () => {
      assert.equal(pingIntervalMs(), 100)
    })
    withEnv("MESH_PING_INTERVAL_MS", "not-a-number", () => {
      assert.equal(pingIntervalMs(), 100)
    })
  })

  it("pongTimeoutMs 默认 60000ms", () => {
    withEnv("MESH_PONG_TIMEOUT_MS", undefined, () => {
      assert.equal(pongTimeoutMs(), 60000)
    })
  })

  it("pongTimeoutMs 读 MESH_PONG_TIMEOUT_MS env 覆盖默认", () => {
    withEnv("MESH_PONG_TIMEOUT_MS", "40000", () => {
      assert.equal(pongTimeoutMs(), 40000)
    })
  })

  it("pongTimeoutMs 兜底:env 太小或非法时走最小 200ms", () => {
    withEnv("MESH_PONG_TIMEOUT_MS", "50", () => {
      assert.equal(pongTimeoutMs(), 200)
    })
    withEnv("MESH_PONG_TIMEOUT_MS", "abc", () => {
      assert.equal(pongTimeoutMs(), 200)
    })
  })

  it("sendRetryCount 默认 1（一次重试）", () => {
    withEnv("MESH_SEND_RETRY", undefined, () => {
      assert.equal(sendRetryCount(), 1)
    })
  })

  it("sendRetryCount 读 MESH_SEND_RETRY env：0 合法（禁用 retry）", () => {
    withEnv("MESH_SEND_RETRY", "0", () => {
      assert.equal(sendRetryCount(), 0)
    })
    withEnv("MESH_SEND_RETRY", "3", () => {
      assert.equal(sendRetryCount(), 3)
    })
  })

  it("sendRetryCount 兜底:负数/非法走 0", () => {
    withEnv("MESH_SEND_RETRY", "-5", () => {
      assert.equal(sendRetryCount(), 0)
    })
    withEnv("MESH_SEND_RETRY", "xx", () => {
      assert.equal(sendRetryCount(), 0)
    })
  })
})
