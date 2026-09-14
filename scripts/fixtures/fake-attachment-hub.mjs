import http from "node:http"
import { createHash } from "node:crypto"

const port = Number(process.env.TEST_ATTACHMENT_HUB_PORT)
const token = process.env.TEST_ATTACHMENT_HUB_TOKEN ?? ""
if (!Number.isSafeInteger(port) || port <= 0 || !token) process.exit(2)

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/api/blobs") {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: false, error: "not found" }))
    return
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }))
    return
  }

  const chunks = []
  req.on("data", (chunk) => chunks.push(chunk))
  req.on("end", () => {
    const bytes = Buffer.concat(chunks)
    const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    if (req.headers["content-type"] !== "image/png" || !bytes.subarray(0, 8).equals(pngMagic)) {
      res.writeHead(415, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: false, error: "invalid png" }))
      return
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const now = Date.now()
    res.writeHead(201, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      ok: true,
      data: {
        manifest: {
          version: 1,
          id: `att-${sha256}`,
          kind: "image",
          mime: "image/png",
          size: bytes.length,
          sha256,
          width: 1,
          height: 1,
          storageRef: `hub-blob:${sha256}`,
          createdAt: new Date(now - 1_000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        },
      },
    }))
  })
})

server.listen(port, "127.0.0.1", () => process.stdout.write("READY\n"))
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
