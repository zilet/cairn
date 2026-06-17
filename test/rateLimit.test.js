// Rate limiting (C5) — the decision core is a PURE function so it's deterministic
// and testable without env/clock/HTTP. The middleware (rateLimitGuard) just feeds
// it now()/config/state; this pins the windowing math it relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newRateState, rateLimitDecision } from "../dist/auth.js";

test("allows up to the limit, then blocks within the same window", () => {
  const s = newRateState();
  const win = 1000;
  for (let i = 0; i < 3; i++) {
    const d = rateLimitDecision(s, "ip", 0, 3, win);
    assert.equal(d.allowed, true, `hit ${i + 1} allowed`);
    assert.equal(d.remaining, 2 - i);
  }
  const blocked = rateLimitDecision(s, "ip", 10, 3, win);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= win, "retryAfter within the window");
});

test("the window resets once it has elapsed", () => {
  const s = newRateState();
  rateLimitDecision(s, "ip", 0, 1, 1000); // spend the one allowance
  assert.equal(rateLimitDecision(s, "ip", 500, 1, 1000).allowed, false, "still inside the window");
  assert.equal(rateLimitDecision(s, "ip", 1000, 1, 1000).allowed, true, "window rolled over");
});

test("keys are independent; limit<=0 means no limit", () => {
  const s = newRateState();
  rateLimitDecision(s, "a", 0, 1, 1000);
  assert.equal(rateLimitDecision(s, "a", 0, 1, 1000).allowed, false, "key a exhausted");
  assert.equal(rateLimitDecision(s, "b", 0, 1, 1000).allowed, true, "key b is fresh");
  for (let i = 0; i < 100; i++) {
    assert.equal(rateLimitDecision(s, "c", 0, 0, 1000).allowed, true, "no-limit never blocks");
  }
});
