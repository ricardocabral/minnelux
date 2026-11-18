import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";

const port = Number(process.argv[2] ?? 8782);
const rttMilliseconds = Number(process.argv[3] ?? 0);
const megabitsPerSecond = Number(process.argv[4] ?? 0);
if (!Number.isInteger(port) || port < 1 || port > 65_535 ||
    !Number.isFinite(rttMilliseconds) || rttMilliseconds < 0 ||
    !Number.isFinite(megabitsPerSecond) || megabitsPerSecond < 0) {
  throw new Error("Usage: node serve.mjs [port] [latency in ms] [bandwidth in Mbps]");
}

const page = await readFile(new URL("./index.html", import.meta.url));
const worker = await readFile(new URL("./benchmark.js", import.meta.url));
const objects = new Map();
const objectPath = /^\/objects\/(?:head\.json|revisions\/[0-9a-f-]{36}\.json|(?:catalog|index\/(?:text|tags))\/[0-9a-f]{64}\.json\.gz)$/;
const maxUploadBytes = 8 * 1024 * 1024;
const nextTransferAt = { GET: 0, PUT: 0 };

async function modelTransfer(direction, bytes) {
  // Requests can overlap latency but share the configured bandwidth in each direction.
  if (!rttMilliseconds && !megabitsPerSecond) return;
  const now = performance.now();
  const readyAt = Math.max(now + rttMilliseconds, nextTransferAt[direction]);
  const payloadMilliseconds = megabitsPerSecond ? bytes * 8 / (megabitsPerSecond * 1000) : 0;
  const finishAt = readyAt + payloadMilliseconds;
  nextTransferAt[direction] = finishAt;
  await wait(finishAt - now);
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("Cache-Control", "no-store");
  try {
    if (request.method === "GET" && path === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
    } else if (request.method === "GET" && path === "/benchmark.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(worker);
    } else if (request.method === "GET" && path === "/favicon.ico") {
      response.writeHead(204).end();
    } else if (!objectPath.test(path)) {
      response.writeHead(404).end();
    } else if (request.method === "PUT") {
      const expectedLength = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > maxUploadBytes) {
        response.writeHead(413).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      await modelTransfer("PUT", bytes.length);
      objects.set(path, bytes);
      response.writeHead(204).end();
    } else if (request.method === "GET") {
      const bytes = objects.get(path);
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      await modelTransfer("GET", bytes.length);
      response.writeHead(200, {
        "Content-Type": path.endsWith(".gz") ? "application/gzip" : "application/json",
        "Content-Length": bytes.length,
      }).end(bytes);
    } else {
      response.writeHead(405, { Allow: "GET, PUT" }).end();
    }
  } catch (error) {
    console.error(error.message);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

server.listen(port, "127.0.0.1");
await once(server, "listening");
console.log(`http://127.0.0.1:${port}/ (${rttMilliseconds} ms latency, ${megabitsPerSecond || "unlimited"} Mbps per direction)`);
