// Inspectable beliefs (W3.6): loader + dispute/restore wiring. Pure markup lives
// in health-beliefs-client.ts; this module owns the execution path — mirrors
// health-directives-loader-client.ts.
type BeliefsLoaderView = import("../contracts/client-api.js").ClientBeliefsView;

// Memory-only (the `health:` prefix keeps it out of localStorage), like the
// connected-brain directives cache.
const BELIEFS_CACHE_KEY = "health:beliefs";

function beliefsLoaderPaint(wrap: Element, data: BeliefsLoaderView | null): void {
  wrap.innerHTML = CairnHealthBeliefs.beliefsViewHtml(data);
  wrap.querySelectorAll<HTMLElement>("[data-belief-dispute]").forEach((b) =>
    b.addEventListener("click", () => void beliefsLoaderSetStatus(b.dataset.beliefDispute || "", "disputed"))
  );
  wrap.querySelectorAll<HTMLElement>("[data-belief-undispute]").forEach((b) =>
    b.addEventListener("click", () => void beliefsLoaderSetStatus(b.dataset.beliefUndispute || "", "active"))
  );
}

async function beliefsLoaderLoad(token: number): Promise<void> {
  const wrap = $<HTMLElement>("#standBeliefs");
  if (!wrap || !wrap.isConnected) return;
  const peek = peekCached<BeliefsLoaderView>(BELIEFS_CACHE_KEY);
  if (peek) beliefsLoaderPaint(wrap, peek.data);
  let res: BeliefsLoaderView | null = null;
  let ok = false;
  try {
    res = (await api("/beliefs")) as BeliefsLoaderView;
    ok = true;
  } catch {
    ok = false;
  }
  if (token !== pollToken || !wrap.isConnected) return;
  if (!ok) {
    if (!peek) beliefsLoaderPaint(wrap, null);
    return;
  }
  swrSet(BELIEFS_CACHE_KEY, res);
  if (!peek || JSON.stringify(peek.data) !== JSON.stringify(res)) beliefsLoaderPaint(wrap, res);
}

async function beliefsLoaderSetStatus(id: string, status: "active" | "disputed"): Promise<void> {
  if (!id) return;
  let res: unknown = null;
  try {
    res = await api(`/beliefs/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  } catch {
    res = null;
  }
  const row = res && typeof res === "object" ? (res as { ok?: unknown }) : {};
  if (!row.ok) {
    toast("Couldn't update");
    return;
  }
  toast(status === "disputed" ? "Set aside — won't shape prompts or defaults" : "Restored");
  swrInvalidate(BELIEFS_CACHE_KEY); // don't flash the just-changed row back from cache
  void beliefsLoaderLoad(pollToken);
}

const CAIRN_HEALTH_BELIEFS_LOADER = {
  load: beliefsLoaderLoad,
};

Object.assign(globalThis, { CairnHealthBeliefsLoader: CAIRN_HEALTH_BELIEFS_LOADER });

if (typeof window !== "undefined") {
  window.CairnHealthBeliefsLoader = CAIRN_HEALTH_BELIEFS_LOADER;
}
