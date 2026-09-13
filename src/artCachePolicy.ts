// Pure art-cache URL policy. public/sw.js inlines a mirror of these helpers
// (classic service workers cannot import this module). Tests assert THIS copy;
// if you change eviction, change the SW mirror in the same patch.

export interface ArtCacheIdentity {
  kind: string;
  q: string;
  v: number;
}

/** Parse /api/art?kind=&q=&v= into a cache identity. `v` missing → 0. */
export function artCacheIdentity(url: string): ArtCacheIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://cairn.local");
  } catch {
    return null;
  }
  if (parsed.pathname !== "/api/art") return null;
  const kind = parsed.searchParams.get("kind") || "";
  const q = parsed.searchParams.get("q") || "";
  if (!kind || !q) return null;
  const raw = parsed.searchParams.get("v");
  const v = raw == null || raw === "" ? 0 : Number(raw);
  return { kind, q, v: Number.isFinite(v) && v > 0 ? v : 0 };
}

/**
 * Drop a cached entry when a newer version of the same kind+q just landed.
 * Unversioned URLs (v=0, including a leftover `&r=1` retry) are older than any
 * positive v, so they get evicted too.
 */
export function shouldEvictCachedArt(cachedUrl: string, incomingUrl: string): boolean {
  const incoming = artCacheIdentity(incomingUrl);
  const cached = artCacheIdentity(cachedUrl);
  if (!incoming || !cached) return false;
  if (incoming.kind !== cached.kind || incoming.q !== cached.q) return false;
  return cached.v < incoming.v;
}
