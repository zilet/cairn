// ~20 routers mount at "/" in src/api.ts, so two of them can claim the same
// method + path and Express will say nothing: the first registration wins forever and
// the second reads as live code while never running. assertNoDuplicateApiRoutes is the
// boot-time guard; these cases prove it fires and that the real api has no duplicate.
import test from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";
import { assertNoDuplicateApiRoutes, collectRouteKeys } from "../dist/route-audit.js";
import { api } from "../dist/api.js";

test("a duplicate method + path across two mounted routers throws, naming both owners", () => {
  const first = Router();
  const second = Router();
  first.get("/thing/:id", () => {});
  second.get("/thing/:id", () => {});

  assert.throws(
    () =>
      assertNoDuplicateApiRoutes([
        { name: "first", prefix: "/", router: first },
        { name: "second", prefix: "/", router: second },
      ]),
    (error) =>
      /duplicate API route registration/.test(error.message) &&
      /GET \/thing\/:id/.test(error.message) &&
      /first/.test(error.message) &&
      /second/.test(error.message)
  );
});

test("differently-named params at the same position collide too — a client can't tell :id from :slug", () => {
  const first = Router();
  const second = Router();
  first.get("/x/:id", () => {});
  second.get("/x/:slug", () => {});

  assert.throws(
    () =>
      assertNoDuplicateApiRoutes([
        { name: "first", prefix: "/", router: first },
        { name: "second", prefix: "/", router: second },
      ]),
    (error) =>
      /duplicate API route registration/.test(error.message) &&
      /GET \/x\/:id/.test(error.message) &&
      /GET \/x\/:slug/.test(error.message) &&
      /first/.test(error.message) &&
      /second/.test(error.message)
  );
});

test("the same path under different methods or different prefixes is not a duplicate", () => {
  const reads = Router();
  const writes = Router();
  reads.get("/thing", () => {});
  writes.post("/thing", () => {});
  const prefixed = Router();
  prefixed.get("/thing", () => {});

  const keys = assertNoDuplicateApiRoutes([
    { name: "reads", prefix: "/", router: reads },
    { name: "writes", prefix: "/", router: writes },
    { name: "prefixed", prefix: "/elsewhere", router: prefixed },
  ]);
  assert.deepEqual(new Set(keys), new Set(["GET /thing", "POST /thing", "GET /elsewhere/thing"]));
});

test("collectRouteKeys applies the mount prefix", () => {
  const router = Router();
  router.put("/a", () => {});
  assert.deepEqual(collectRouteKeys({ name: "r", prefix: "/pre", router }), ["PUT /pre/a"]);
});

test("the real API mounts no duplicate route — importing src/api.ts already asserted it", () => {
  // The assertion runs at module load, so a duplicate would have thrown on the import
  // above. This keeps the guard honest by proving the router actually has routes.
  assert.ok(api, "api router loads");
  const routes = (api.stack ?? []).filter((layer) => Array.isArray(layer?.handle?.stack)).length;
  assert.ok(routes > 0, "api mounts routers");
});
