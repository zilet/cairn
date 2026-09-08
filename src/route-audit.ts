import type { Router } from "express";

/** One mount as api.ts declares it: its name, the prefix it is mounted at, and the router. */
export type ApiMount = { name: string; prefix: string; router: Router };

/** A registered endpoint, prefix-aware: "GET /sessions/:id". */
export type RouteKey = string;

/**
 * `/x/:id` and `/x/:slug` collide at the HTTP layer — a param's NAME is invisible to
 * a client, only its position is — so the collision key normalizes every `:name`
 * segment to `:param`. Keep the original, human-readable key for the thrown error.
 */
function normalizeRouteKey(key: RouteKey): RouteKey {
  return key.replace(/:[^/]+/g, ":param");
}

function joinPath(prefix: string, routePath: string): string {
  const left = prefix === "/" ? "" : prefix.replace(/\/+$/, "");
  const right = routePath.startsWith("/") ? routePath : `/${routePath}`;
  const joined = `${left}${right}`;
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
}

/**
 * Every (method, path) an express router registers, with a mount prefix applied.
 *
 * Express keeps a nested mount path inside a closure, so a router mounted INSIDE a
 * router cannot report its own prefix; there are none today, and a walk that inherits
 * the parent prefix is the honest reading if one ever appears.
 */
export function collectRouteKeys(mount: ApiMount): RouteKey[] {
  const keys: RouteKey[] = [];
  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack ?? []) {
      const route = layer?.route;
      if (route) {
        const paths = Array.isArray(route.path) ? route.path : [route.path];
        const methods = Object.keys(route.methods ?? {}).filter((m) => m !== "_all");
        for (const path of paths) {
          for (const method of methods) keys.push(`${method.toUpperCase()} ${joinPath(prefix, String(path))}`);
        }
        continue;
      }
      if (Array.isArray(layer?.handle?.stack)) walk(layer.handle.stack, prefix);
    }
  };
  walk((mount.router as any).stack ?? [], mount.prefix);
  return keys;
}

/**
 * Throw when two mounted routers claim the same method + path.
 *
 * ~20 routers all mount at "/", so a path defined twice is silently shadowed: the
 * first registration wins forever and the second is dead code that still reads as
 * live. Express reports nothing. This runs once at module load (api.ts), so the
 * mistake is a boot failure with both owners named rather than a runtime mystery.
 */
export function assertNoDuplicateApiRoutes(mounts: ApiMount[]): RouteKey[] {
  const owners = new Map<RouteKey, { originals: Set<string>; mounts: string[] }>();
  const all: RouteKey[] = [];
  for (const mount of mounts) {
    for (const key of collectRouteKeys(mount)) {
      all.push(key);
      const normalized = normalizeRouteKey(key);
      const entry = owners.get(normalized) ?? { originals: new Set<string>(), mounts: [] };
      entry.originals.add(key);
      entry.mounts.push(`${mount.name} @ ${mount.prefix}`);
      owners.set(normalized, entry);
    }
  }
  const duplicates = [...owners.entries()].filter(([, entry]) => entry.mounts.length > 1);
  if (duplicates.length) {
    const detail = duplicates
      .map(
        ([, entry]) =>
          `${[...entry.originals].join(" / ")} (${entry.mounts.length} registrations: ${entry.mounts.join(", ")})`
      )
      .join("; ");
    throw new Error(`duplicate API route registration: ${detail}`);
  }
  return all;
}
