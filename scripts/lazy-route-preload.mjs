// The cold deep-link preload table: which lazy bundles a canonical route needs, so
// index.html's inline boot script can start downloading them while the eager set is
// still on the wire instead of after it has executed.
//
// The bundle table is DERIVED at build time, never hand-kept, from:
//   - the route grammar itself (public/js/route-state.js: CairnRoutes.parseRoute over
//     every canonical /app/<home>[/<section>] path its own definitions name),
//   - which lazy bundle renders each view (the `views` each lazy entry of BUNDLES in
//     scripts/build-client.mjs declares, mirrored by render-dispatch.ts and held to it
//     by test/lazyRoutePreload.test.js),
//   - the bundle urls and dependencies ensureBundle itself uses (LAZY_BUNDLE_SRC /
//     LAZY_BUNDLE_DEPS read out of the built public/js/app-lazy-bundles.js).
// A preload only fetches; ensureBundle's later <script src> for the same url takes the
// already-fetched (or in-flight) response and executes it then, after the eager
// bundles, exactly as before.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

// The shell's own boot reads, which startAppShell asks for on EVERY open through api():
// maybeOnboard's /settings, primeArtManifest's /art/state and jobReconnect's
// /agent-jobs. They lead every lazy deep link's early reads (Today primes them from its
// aggregate instead, and never reaches this table). The inline script adds /profile on
// its own, only when primeDiscipline will ask for it (no SWR row survives the sweep).
export const SHELL_EARLY_READS = ["/settings", "/art/state", "/agent-jobs"];

// The reads a view's first paint ALWAYS asks for, whatever its section, on every
// entry: the inline script starts them next to the bundle preload and api() takes
// each response once (CairnTodayPrefetch.takeEarly), exactly like Today's early
// fetch. Only a request the view makes unconditionally belongs here, or the early
// response is never taken and costs a request. A screen that answers its reads from
// one fan-in (health-fan-in-client.ts, train-fan-in-client.ts) starts THAT request
// here, never the reads it primes: a primed read never reaches the wire, so an early
// copy of it would only be a second request. A key is a view, or `view:section`,
// which REPLACES the view's list for that section; `{date}` is the device's local
// date, filled in by the inline script. These lists are the only hand-written part,
// and test/lazyRoutePreload.test.js holds each to the call it mirrors.
export const VIEW_EARLY_READS = {
  // Health (the Stand view) primes CairnHealthFanIn with its section on every entry,
  // cold or revalidating (stand-screen.ts renderStand), before any view asks.
  stand: ["/you-health?leaf=health"],
  "stand:records": ["/you-health?leaf=records"],
  "stand:markers": ["/you-health?leaf=markers"],
  "stand:share": ["/you-health?leaf=share"],
  // Train › Program: renderProgressProgram primes CairnTrainFanIn("program") first.
  "progress:program": ["/train-home?view=program&date={date}"],
  // Horizon › Goal line: renderHorizonGoal primes CairnTrainFanIn("goal") first.
  "horizon:goal": ["/train-home?view=goal&date={date}"],
  // The plan editor asks its three head reads (CairnPlanHead.headReads) on every
  // paint, and /plan through cachedApi({key:"plan"}), which answers without asking
  // only from an SWR row younger than its 3 s serveFreshFor. A `[path, swrKey, ms]`
  // entry is started only when no stored row for swrKey is younger than ms.
  "plan:edit": ["/plan/week", "/plan/recovery-status", "/plan/upcoming", ["/plan", "plan", 3000]],
};

export const LAZY_ROUTES_MARKER = /\/\*cairn:lazy-routes\*\/[\s\S]*?\/\*end\*\//;

function runClientModule(root, file, extra = {}) {
  const context = { window: {}, globalThis: null, ...extra };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(path.join(root, file), "utf8"), context);
  return context;
}

/** The lazy bundle a parsed route renders from, per BUNDLES' `views` (`tab` or `tab:section`). */
export function viewBundleIndex(bundles) {
  const byView = new Map();
  for (const bundle of bundles) {
    if (!bundle.lazy) continue;
    for (const view of bundle.views || []) {
      if (byView.has(view)) throw new Error(`view ${view} is claimed by two lazy bundles`);
      byView.set(view, bundle.lazy);
    }
  }
  return (route) => byView.get(`${route.tab}:${route.section}`) ?? byView.get(route.tab) ?? null;
}

/** Every canonical path the route grammar can name, two segments deep (plus Settings' nested ones and the day page). */
function canonicalPaths(routes) {
  const defs = routes.routeDefinitions;
  const sections = new Set(Object.values(defs.sections).flat());
  // The v2-only slugs parseV2 names directly (not in any section list).
  for (const slug of ["session", "fuel", "menu", "day", "plan", "race", "changes", "health", "settings"]) sections.add(slug);
  const out = [];
  for (const home of defs.homes) {
    out.push([home]);
    for (const section of sections) out.push([home, section]);
  }
  for (const nested of defs.sections.settings) out.push(["you", "settings", nested]);
  // The home-free object pages (/app/day/<date>): keyed by their first segment alone,
  // which is what the inline script falls back to for /app/day/<any date>.
  out.push(["day"]);
  return out;
}

/**
 * One route's bundle indices as the string the inline script reads ONE DIGIT per index
 * (`T.b[+b[i]]`). An 11th bundle url would be index 10, read as 1 then 0 — the wrong
 * bundles, silently — so the build refuses it rather than emit it.
 */
export function bundleDigits(indices) {
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i > 9) {
      throw new Error(`lazy bundle index ${i} is not one digit: widen index.html's preload encoding first`);
    }
  }
  return indices.join("");
}

// An ?id= rides along so /app/you/domain parses as the canonical id-carrying route it
// is; no other path's canonical form depends on it.
const routeUrl = (segments) => `/app/${segments.join("/")}?id=x`;

/**
 * Build the preload table:
 *   `{ b: [bundle urls], r: { "<home>[/<section>]": "<indices into b>" },
 *      q: [[early read paths]], e: { "<home>[/<section>]": <index into q> } }`.
 * A `<home>/<section>` key is written only where it differs from its `<home>` key, and
 * the inline script falls back to `<home>` exactly as parseRoute falls back to the
 * home's landing for a section it does not know.
 */
export function lazyRoutePreloadTable(root, bundles) {
  const { CairnRoutes: routes } = runClientModule(root, "public/js/route-state.js", { URL, URLSearchParams });
  const loader = runClientModule(root, "public/js/app-lazy-bundles.js", { document: undefined });
  const src = loader.LAZY_BUNDLE_SRC;
  const deps = loader.LAZY_BUNDLE_DEPS;
  const bundleOf = viewBundleIndex(bundles);
  for (const bundle of bundles) {
    if (!bundle.lazy) continue;
    if (src[bundle.lazy] !== `/${bundle.output.replace(/^public\//, "")}`) {
      throw new Error(`LAZY_BUNDLE_SRC[${bundle.lazy}] is ${src[bundle.lazy]}, but BUNDLES builds ${bundle.output}`);
    }
    // A route-less bundle (`routeless: true`) renders inside an EAGER view's own page —
    // today-ahead is Today's lower half — so no deep link ever needs it preloaded.
    if (!bundle.views?.length && !bundle.routeless) throw new Error(`lazy bundle ${bundle.lazy} declares no views`);
  }
  const urls = [];
  const closure = (name) => {
    const order = [];
    const visit = (n) => {
      if (order.includes(n)) return;
      for (const d of deps[n] || []) visit(d);
      order.push(n);
    };
    visit(name);
    return order;
  };
  const indicesFor = (segments) => {
    const route = routes.parseRoute(routeUrl(segments));
    const lazy = bundleOf(route);
    if (!lazy) return "";
    return bundleDigits(
      closure(lazy).map((name) => {
        const url = src[name];
        if (!urls.includes(url)) urls.push(url);
        return urls.indexOf(url);
      })
    );
  };
  const q = [];
  const readsFor = (segments, lazy) => {
    if (!lazy) return null; // an eager destination paints without waiting on a bundle
    const route = routes.parseRoute(routeUrl(segments));
    const own = VIEW_EARLY_READS[`${route.tab}:${route.section}`] || VIEW_EARLY_READS[route.tab] || [];
    const reads = [...SHELL_EARLY_READS, ...own];
    const at = q.findIndex((list) => JSON.stringify(list) === JSON.stringify(reads));
    if (at >= 0) return at;
    q.push([...reads]);
    return q.length - 1;
  };
  const bundlesByKey = new Map();
  const readsByKey = new Map();
  const collect = (map, key, value, segments, what) => {
    if (map.has(key) && map.get(key) !== value) {
      throw new Error(`/app/${segments.join("/")} needs different ${what} than /app/${key}`);
    }
    map.set(key, value);
  };
  for (const segments of canonicalPaths(routes)) {
    const parsed = routes.parseRoute(routeUrl(segments));
    if (parsed.legacy) continue; // not a path routeToUrl ever writes
    const key = segments.slice(0, 2).join("/");
    const bundles = indicesFor(segments);
    collect(bundlesByKey, key, bundles, segments, "bundles");
    collect(readsByKey, key, readsFor(segments, bundles !== ""), segments, "early reads");
  }
  // A <home>/<section> row only where it differs from what <home> alone would answer.
  const rows = (map, none) => {
    const out = {};
    for (const [key, value] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
      const home = key.split("/")[0];
      if (key === home ? value !== none : value !== (map.get(home) ?? none)) out[key] = value;
    }
    return out;
  };
  return { b: urls, r: rows(bundlesByKey, ""), q, e: rows(readsByKey, null) };
}

/** index.html with its inline boot script carrying `table`; throws when the marker is gone. */
export function withLazyRouteTable(html, table) {
  if (!LAZY_ROUTES_MARKER.test(html)) throw new Error("index.html's inline boot script has no /*cairn:lazy-routes*/ table");
  return html.replace(LAZY_ROUTES_MARKER, `/*cairn:lazy-routes*/${JSON.stringify(table)}/*end*/`);
}

/** Rewrite public/index.html's table in place (a no-op when it is already current). Returns whether it changed. */
export function writeLazyRouteTable(root, bundles) {
  const file = path.join(root, "public/index.html");
  let html;
  try {
    html = readFileSync(file, "utf8");
  } catch {
    console.log("• lazy-route preload: skipped (no public/index.html in this build stage)");
    return false;
  }
  const next = withLazyRouteTable(html, lazyRoutePreloadTable(root, bundles));
  if (next === html) return false;
  writeFileSync(file, next);
  console.log("✓ rewrote index.html's lazy-route preload table");
  return true;
}
