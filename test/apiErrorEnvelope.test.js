// The ONE error path (src/api.ts `apiErrorHandler`, mounted at the end of the /api
// router and again at the app level in src/server.ts). Everything an uncaught server
// failure can look like — a synchronous throw, a rejected async handler, a body that
// never parsed — must reach the caller as JSON, because the PWA's api() helper calls
// r.json() and would break on Express's default HTML error page.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { apiErrorHandler } from "../dist/api.js";

let server = null;
let base = "";

// The handler logs through src/log.ts, which writes to stderr. Swallow it so a
// deliberate failure under test does not read as a failing run.
function quiet(fn) {
  const error = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.error = error;
      console.warn = warn;
    });
}

async function listener() {
  if (server) return base;
  const app = express();
  // A tight limit so an ordinary body triggers the payload-too-large path.
  app.use(express.json({ limit: "100b" }));
  app.get("/api/throws", () => {
    throw new TypeError("private athlete detail that must not travel");
  });
  app.get("/api/rejects", async () => {
    await Promise.resolve();
    throw new RangeError("private athlete detail that must not travel");
  });
  app.post("/api/parsed", (_req, res) => res.json({ ok: true }));
  app.use(apiErrorHandler);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
  return base;
}

after(() => server?.close());

test("a synchronous throw answers JSON, not HTML, and leaks no message", async () => {
  const url = await listener();
  const res = await quiet(() => fetch(`${url}/throws`));
  assert.equal(res.status, 500);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "internal error");
  assert.doesNotMatch(JSON.stringify(body), /private athlete detail/);
});

test("a rejected async handler takes the same path", async () => {
  const url = await listener();
  const res = await quiet(() => fetch(`${url}/rejects`));
  assert.equal(res.status, 500);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assert.deepEqual({ ok: body.ok, error: body.error }, { ok: false, error: "internal error" });
  assert.doesNotMatch(JSON.stringify(body), /private athlete detail/);
});

test("a caller's own bad request is answered as a 4xx, never as a server defect", async () => {
  const url = await listener();
  const tooLarge = await quiet(() =>
    fetch(`${url}/parsed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(500) }),
    })
  );
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error, "request body too large");

  const malformed = await quiet(() =>
    fetch(`${url}/parsed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" })
  );
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "invalid JSON body");
});

test("a half-written response is delegated, never double-answered", () => {
  // Only Express's own finalhandler can close a socket whose headers are already on
  // the wire (a stream, a partially flushed body). Writing a second status here would
  // throw ERR_HTTP_HEADERS_SENT and lose the real error.
  let delegated = null;
  let statusCalls = 0;
  const res = {
    headersSent: true,
    status() {
      statusCalls++;
      return res;
    },
    json() {
      statusCalls++;
      return res;
    },
  };
  const boom = new Error("failed mid-stream");
  apiErrorHandler(boom, { method: "GET", originalUrl: "/api/streamed" }, res, (err) => {
    delegated = err;
  });
  assert.equal(delegated, boom);
  assert.equal(statusCalls, 0);
});
