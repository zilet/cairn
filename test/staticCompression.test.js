// COMPRESSED TRANSFER — the precompressed static layer and the runtime JSON gzip.
//
// The installed PWA pulls the whole 2.7 MB shell over a tailnet on every CACHE
// bump, and every API body used to travel raw. Two mechanisms fix that, and both
// are easy to get subtly wrong: a wrong Content-Type, a missing Vary, a body that
// does not decode back to the original bytes, or — worst — an SSE stream silently
// buffered by a compressor, which would freeze streaming replies.
//
// Drives a real express app over loopback with the SAME mount order as
// src/server.ts, and speaks raw node:http so Accept-Encoding is fully controlled
// (global fetch always sends its own and transparently decodes the answer).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import express from "express";
import {
  acceptedEncodings,
  jsonCompression,
  precompressedStatic,
  MIN_JSON_COMPRESS_BYTES,
} from "../dist/staticCompression.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(root, "public");
const BUNDLE = "/js/bundle-01-core.js";

let server = null;
let port = 0;

async function listener() {
  if (server) return port;
  const app = express();
  app.use("/api", jsonCompression);
  app.use("/api", testRouter());
  app.use(precompressedStatic(PUBLIC_DIR));
  app.use(express.static(PUBLIC_DIR));
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  port = server.address().port;
  return port;
}

function testRouter() {
  const router = express.Router();
  // Comfortably over the threshold, and compressible (repeated keys).
  router.get("/big", (_req, res) => {
    res.json({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, label: "a repeated label" })) });
  });
  router.get("/small", (_req, res) => res.json({ ok: true }));
  router.get("/stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("data: one\n\n");
    res.write("data: two\n\n");
    res.end();
  });
  return router;
}

/** Raw request: no implicit Accept-Encoding, no transparent decoding. */
async function raw(urlPath, headers = {}) {
  const p = await listener();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: p, path: urlPath, method: headers.__method || "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

after(() => server?.close());

test("acceptedEncodings honours q-values, refusals and the wildcard", () => {
  assert.deepEqual(acceptedEncodings("gzip, br", ["br", "gzip"]), ["br", "gzip"]);
  assert.deepEqual(acceptedEncodings("gzip", ["br", "gzip"]), ["gzip"]);
  // A refusal is not an acceptance, even when the token is present.
  assert.deepEqual(acceptedEncodings("br;q=0, gzip", ["br", "gzip"]), ["gzip"]);
  assert.deepEqual(acceptedEncodings("gzip;q=0.5, br;q=0.9", ["br", "gzip"]), ["br", "gzip"]);
  assert.deepEqual(acceptedEncodings("*", ["br", "gzip"]), ["br", "gzip"]);
  assert.deepEqual(acceptedEncodings("identity", ["br", "gzip"]), []);
  assert.deepEqual(acceptedEncodings(undefined, ["br", "gzip"]), []);
});

test("a bundle is served brotli, and decodes to the file on disk byte for byte", async () => {
  const onDisk = readFileSync(path.join(PUBLIC_DIR, BUNDLE.slice(1)));
  const res = await raw(BUNDLE, { "accept-encoding": "br" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-encoding"], "br");
  assert.equal(res.headers.vary, "Accept-Encoding");
  // The ORIGINAL type, not the sibling's extension — a browser must still parse it as JS.
  assert.match(res.headers["content-type"], /^text\/javascript/);
  assert.equal(Number(res.headers["content-length"]), res.body.length);
  assert.ok(res.body.length < onDisk.length, "brotli must be smaller than the raw bundle");
  assert.deepEqual(zlib.brotliDecompressSync(res.body), onDisk);
  assert.match(res.headers.etag, /^W\/"/);
});

test("a gzip-only client gets gzip, decoding to the same bytes", async () => {
  const onDisk = readFileSync(path.join(PUBLIC_DIR, BUNDLE.slice(1)));
  const res = await raw(BUNDLE, { "accept-encoding": "gzip" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.deepEqual(zlib.gunzipSync(res.body), onDisk);
});

test("no Accept-Encoding falls through to express.static and serves the raw file", async () => {
  const onDisk = readFileSync(path.join(PUBLIC_DIR, BUNDLE.slice(1)));
  const res = await raw(BUNDLE, { "accept-encoding": "identity" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-encoding"], undefined);
  assert.deepEqual(res.body, onDisk);
  // Still varies: the raw answer is one representation among several.
  assert.equal(res.headers.vary, "Accept-Encoding");
});

test("a repeat request with the returned ETag is answered 304 with no body", async () => {
  const first = await raw(BUNDLE, { "accept-encoding": "br" });
  const second = await raw(BUNDLE, { "accept-encoding": "br", "if-none-match": first.headers.etag });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0);
});

test("HEAD reports the compressed length and sends no body", async () => {
  const get = await raw(BUNDLE, { "accept-encoding": "br" });
  const head = await raw(BUNDLE, { "accept-encoding": "br", __method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-encoding"], "br");
  assert.equal(head.headers["content-length"], String(get.body.length));
  assert.equal(head.body.length, 0);
});

test("an asset with no precompressed sibling is untouched", async () => {
  // sw.js and manifest.json are deliberately never precompressed: express.static
  // owns their `no-cache` contract, and a stale worker is the repo's #1 footgun.
  for (const asset of ["/sw.js", "/manifest.json"]) {
    const res = await raw(asset, { "accept-encoding": "br, gzip" });
    assert.equal(res.status, 200, asset);
    assert.equal(res.headers["content-encoding"], undefined, asset);
    assert.deepEqual(res.body, readFileSync(path.join(PUBLIC_DIR, asset.slice(1))), asset);
  }
});

test("a JSON body over the threshold is gzipped and decodes to the same JSON", async () => {
  const plain = await raw("/api/big", { "accept-encoding": "identity" });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.ok(plain.body.length > MIN_JSON_COMPRESS_BYTES);

  const res = await raw("/api/big", { "accept-encoding": "gzip" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(res.headers.vary, "Accept-Encoding");
  assert.match(res.headers["content-type"], /^application\/json/);
  assert.ok(res.body.length < plain.body.length / 2, "gzip must materially shrink a JSON body");
  assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body).toString("utf8")), JSON.parse(plain.body.toString("utf8")));
});

test("a repeat JSON request with the returned ETag is answered 304", async () => {
  const first = await raw("/api/big", { "accept-encoding": "gzip" });
  const second = await raw("/api/big", { "accept-encoding": "gzip", "if-none-match": first.headers.etag });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0);
});

test("a small JSON body stays uncompressed", async () => {
  const res = await raw("/api/small", { "accept-encoding": "gzip, br" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(res.body.toString("utf8")), { ok: true });
});

test("an SSE response is never compressed or buffered", async () => {
  const res = await raw("/api/stream", { "accept-encoding": "gzip, br" });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /^text\/event-stream/);
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.body.toString("utf8"), "data: one\n\ndata: two\n\n");
});
