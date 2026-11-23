// The Session destination's warm instant paint (session-snapshot-client.ts): the last
// real paint for a date comes back only while the cached reads it was drawn from are
// untouched, so a faster first paint never shows another date or a pre-write surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load() {
  const context = { JSON, Object, String };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/session-snapshot-client.js"), "utf8"), context);
  return context.CairnSessionSnapshot;
}

function memoryStore() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  };
}

function cache(entries) {
  const map = new Map(Object.entries(entries));
  return { peek: (key) => (map.has(key) ? { data: map.get(key) } : null), map };
}

const DATE = "2026-09-26";

test("a saved session paint comes back for the same date while its reads stand", () => {
  const snap = load();
  const store = memoryStore();
  const { peek } = cache({ [`today:session:${DATE}`]: { id: 1, sets: [] }, plan: [{ day_number: 1 }] });
  snap.save(store, DATE, "<div class='sess-dest'>Pull</div>", peek);
  assert.equal(snap.load(store, DATE, peek), "<div class='sess-dest'>Pull</div>");
});

test("never another date's paint", () => {
  const snap = load();
  const store = memoryStore();
  const { peek } = cache({ [`today:session:${DATE}`]: { id: 1 }, "today:session:2026-09-27": { id: 1 } });
  snap.save(store, DATE, "<p>yesterday</p>", peek);
  assert.equal(snap.load(store, "2026-09-27", peek), null);
});

test("a write that replaces or drops a read retires the paint", () => {
  const snap = load();
  const store = memoryStore();
  const { peek, map } = cache({ [`today:session:${DATE}`]: { id: 1, sets: [] } });
  snap.save(store, DATE, "<p>before the set</p>", peek);
  // A logged set primes a newer session (swrSet) — the old paint must not show.
  map.set(`today:session:${DATE}`, { id: 1, sets: [{ reps: 5 }] });
  assert.equal(snap.load(store, DATE, peek), null);
  // An invalidation drops the key altogether — no read, no paint.
  map.delete(`today:session:${DATE}`);
  assert.equal(snap.load(store, DATE, peek), null);
  // A swap touches the composed session or the plan: same rule.
  map.set(`today:session:${DATE}`, { id: 1, sets: [] });
  snap.save(store, DATE, "<p>fresh</p>", peek);
  map.set(`today:daily-session:${DATE}`, { items: [{ exercise: "Row" }] });
  assert.equal(snap.load(store, DATE, peek), null);
});

test("nothing to stamp against means nothing is kept, and a broken store never throws", () => {
  const snap = load();
  const store = memoryStore();
  store.setItem(snap.KEY, JSON.stringify({ date: DATE, stamp: "x", html: "<p>old</p>" }));
  snap.save(store, DATE, "<p>new</p>", () => null);
  assert.equal(store.getItem(snap.KEY), null, "an unstampable paint clears the old one");
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  const { peek } = cache({ [`today:session:${DATE}`]: {} });
  assert.doesNotThrow(() => snap.save(broken, DATE, "<p/>", peek));
  assert.equal(snap.load(broken, DATE, peek), null);
  assert.equal(snap.load(null, DATE, peek), null);
});

test("the primer's early read is spelled exactly as the primer asks it", () => {
  const snap = load();
  assert.equal(snap.primerPath("2026-09-26", 3), "/session-primer?date=2026-09-26&day=3");
  assert.equal(snap.primerPath("2026-09-26", null), "/session-primer?date=2026-09-26");
});

test("a saved paint never carries a typed-draft marker into the next entry", () => {
  const snap = load();
  const store = memoryStore();
  const { peek } = cache({ [`today:session:${DATE}`]: { id: 1, sets: [] } });
  snap.save(store, DATE, '<input class="in-w" value="185" data-dirty="1"><input class="in-r" value="5">', peek);
  assert.equal(snap.load(store, DATE, peek), '<input class="in-w" value="185"><input class="in-r" value="5">');
});

// A repaint of the surface already on screen carries its primer card over (so the list
// keeps its place without waiting on the primer again) — never another date's card.
test("the primer card is carried only for the date the surface was painted for", () => {
  const snap = load();
  const slot = { innerHTML: '<div class="primer">Warm up the hinge</div>' };
  const root = { querySelector: (sel) => (sel === ".sess-dest #sessionPrimerSlot" ? slot : null) };
  assert.equal(snap.primerCarry(root, DATE), "", "nothing painted yet, nothing to carry");
  snap.markPainted(DATE);
  assert.equal(snap.primerCarry(root, "2026-09-27"), "");
  const carried = snap.primerCarry(root, DATE);
  assert.equal(carried, '<div class="primer">Warm up the hinge</div>');
  // The new paint's slot is empty; the carried card fills it until hydrate replaces it.
  slot.innerHTML = "";
  snap.painted(root, DATE, carried);
  assert.equal(slot.innerHTML, carried);
  // A slot the hydrate already filled is never overwritten by the carry.
  slot.innerHTML = "<div>fresh</div>";
  snap.painted(root, DATE, carried);
  assert.equal(slot.innerHTML, "<div>fresh</div>");
});

// A host whose `.sess-dest` is whatever node the last innerHTML write left there.
function sessionHost() {
  const host = {
    dest: null,
    retry: null,
    html: "",
    set innerHTML(value) {
      this.html = String(value);
      this.dest = this.html.includes("sess-dest") ? { isConnected: true } : null;
    },
    get innerHTML() {
      return this.html;
    },
    querySelector(sel) {
      if (sel === ".sess-dest") return this.dest;
      if (sel === "[data-sessretry]" && this.html.includes("data-sessretry"))
        return { addEventListener: (_type, fn) => { host.retry = fn; } };
      return null;
    },
  };
  return host;
}

test("a failed read keeps the live log exactly as it is", () => {
  const snap = load();
  const host = sessionHost();
  host.innerHTML = '<div class="sess-dest">three sets logged</div>';
  snap.painted(host, DATE, "");
  assert.equal(snap.liveSurface(host, DATE), true);
  snap.keepOnFailedRead(host, DATE, () => {});
  assert.equal(host.innerHTML, '<div class="sess-dest">three sets logged</div>', "never an error screen over logged sets");
});

test("a failed read with nothing live says so plainly and offers a retry, never an empty workout", () => {
  const snap = load();
  const host = sessionHost();
  // The inert snapshot (or a skeleton) is on screen: not a live log.
  host.innerHTML = '<div class="sess-dest">snapshot</div>';
  snap.markPainted(DATE);
  assert.equal(snap.liveSurface(host, DATE), false, "a snapshot paint is not the live log");
  let retried = 0;
  snap.keepOnFailedRead(host, DATE, () => retried++);
  assert.match(host.innerHTML, /role="alert"/);
  assert.match(host.innerHTML, /Couldn't load this session/);
  assert.match(host.innerHTML, /no need to log them again/);
  host.retry();
  assert.equal(retried, 1);
});

test("a live log belongs to its date: another date's surface is never kept", () => {
  const snap = load();
  const host = sessionHost();
  host.innerHTML = '<div class="sess-dest">yesterday</div>';
  snap.painted(host, "2026-09-25", "");
  assert.equal(snap.liveSurface(host, DATE), false);
});

test("renderSession takes its paint turn, keeps the log on a failed read, and paints only in order", () => {
  const source = readFileSync(join(root, "src/client/today-screen.ts"), "utf8");
  const body = source.slice(source.indexOf("async function renderSession("), source.indexOf("Object.assign(globalThis, {\n  openSession"));
  const claim = body.indexOf("CairnSessionSnapshot.claimPaint()");
  const load = body.indexOf("todayDataLoader.load(");
  assert.ok(claim > 0 && claim < load, "the turn is claimed before the reads begin");
  assert.match(body, /try \{\s*todayData = await todayDataLoader\.load\([\s\S]*?preparePlanSession[\s\S]*?\} catch \(err\) \{[\s\S]*?keepOnFailedRead\(todayView, enteredDate/);
  assert.match(body, /!CairnSessionSnapshot\.mayPaint\(paintSeq\)\) return;\s*const sessionDrafts/, "the order check guards the one innerHTML swap");
});

test("session paints land in the order they were asked: an older read never paints over a newer one", () => {
  const snap = load();
  const resume = snap.claimPaint(); // a resume's read, slow
  const replay = snap.claimPaint(); // an outbox replay's repaint, asked later
  assert.equal(snap.mayPaint(replay), true, "the later ask lands first");
  assert.equal(snap.mayPaint(resume), false, "the slower, older read is dropped");
  const next = snap.claimPaint();
  assert.equal(snap.mayPaint(next), true);
});
