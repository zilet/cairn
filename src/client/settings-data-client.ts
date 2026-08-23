// @ts-check
// Small Settings -> Data helpers for setup/export-facing cards.

type SettingsPhoneAccessCardOptions = {
  inStandaloneApp?: boolean;
};

type SettingsDataApi = (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>;

type SettingsPhoneAccessWireOptions = {
  api?: SettingsDataApi;
  crypto?: Pick<Crypto, "getRandomValues"> | null;
  document?: Document | null;
  navigator?: Pick<Navigator, "clipboard"> | null;
  now?: () => number;
  random?: () => number;
  toast?: (message: string) => unknown;
};

function phoneAccessCardHtml(options: SettingsPhoneAccessCardOptions = {}): string {
  if (options.inStandaloneApp) return "";
  return `
      <!-- Phone & PWA access: web-only, collapsed-by-default operator hint.
           Hidden in an installed PWA, where this setup is already complete. -->
      <details class="sess phone-access route-card">
        <summary>
          <span class="phone-access-summary">
            <span class="lbl">Phone &amp; PWA access</span>
            <span class="phone-access-tease">Private phone setup and app install notes</span>
          </span>
        </summary>
        <div class="phone-access-body">
          <div class="sess-line">Reach Cairn from your phone <b>privately</b> with Tailscale <b>Serve</b> — tailnet-only, nothing on the public internet. Easiest: run this once on the host (from the cloned repo):</div>
          <div class="cmd-line">./scripts/setup-phone.sh</div>
          <div class="sess-line phone-access-then">It detects your exact <b>https://…ts.net</b> URL and prints the Add-to-Home-Screen steps. By hand:</div>
          <div class="cmd-line">sudo tailscale serve --bg --https=443 http://127.0.0.1:8787</div>
          <div id="phoneTokenRow" class="phone-access-token">
            <button id="phoneGenToken" class="ghostbtn" type="button">Prepare a token for phone</button>
            <span id="phoneTokenOut" class="phone-token"></span>
          </div>
          <div class="small-note">
            On a private tailnet a token is optional; set one if others share your tailnet, or if Cairn is reachable beyond it (then set <b>CAIRN_REQUIRE_AUTH=1</b> too). iOS needs the HTTPS URL for a full offline app. Details in <b>docs/DEPLOYMENT.md</b> and <b>SECURITY.md</b>.
          </div>
        </div>
      </details>`;
}

function makePhoneToken(options: SettingsPhoneAccessWireOptions = {}): string {
  const cryptoLike = options.crypto || (typeof crypto !== "undefined" ? crypto : null);
  let tok = "";
  try {
    if (cryptoLike && cryptoLike.getRandomValues) {
      const bytes = new Uint8Array(28);
      cryptoLike.getRandomValues(bytes);
      tok = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
    }
  } catch {}
  if (!tok) {
    const random = options.random || Math.random;
    const now = options.now || Date.now;
    tok = "cairn-" + random().toString(36).slice(2) + now().toString(36);
  }
  return tok;
}

function wirePhoneAccessCard(options: SettingsPhoneAccessWireOptions = {}): void {
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  if (!doc) return;

  const genTokenBtn = doc.querySelector<HTMLButtonElement>("#phoneGenToken");
  const genTokenOut = doc.querySelector<HTMLElement>("#phoneTokenOut");
  const nav = options.navigator || (typeof navigator !== "undefined" ? navigator : null);
  const toastFn = options.toast || (typeof toast !== "undefined" ? toast : null);
  if (genTokenBtn && genTokenOut) {
    genTokenBtn.addEventListener("click", async () => {
      const tok = makePhoneToken(options);
      genTokenOut.textContent = tok;
      genTokenOut.title = "Set as CAIRN_AUTH_TOKEN=… in .env / compose, then restart";
      // navigator.clipboard is undefined in insecure contexts (e.g. http://<lan-ip>) — the
      // exact case this card targets. Only claim "copied" when the write actually succeeds.
      let copied = false;
      try {
        if (nav && nav.clipboard && nav.clipboard.writeText) {
          await nav.clipboard.writeText(tok);
          copied = true;
        }
      } catch {}
      if (toastFn) {
        toastFn(copied
          ? "Token copied. Set CAIRN_AUTH_TOKEN=… in .env / compose, then restart."
          : "Token ready — copy it, set CAIRN_AUTH_TOKEN=… in .env / compose, then restart.");
      }
    });
  }

  // Auth-aware: if a shared token is already configured, generating a new one is the wrong
  // move — say so instead. GET /api/health is auth-exempt and reports auth_required.
  const phoneTokenRow = doc.querySelector<HTMLElement>("#phoneTokenRow");
  const apiFn = options.api || (typeof api !== "undefined" ? api : null);
  if (phoneTokenRow && apiFn) {
    apiFn("/health").then((h) => {
      if (h && typeof h === "object" && (h as Record<string, unknown>).auth_required) {
        phoneTokenRow.innerHTML =
          `<div class="sess-line phone-token-set">✓ A shared token is already set — your phone will be asked for it once.</div>`;
      }
    }).catch(() => {});
  }
}

type SettingsExerciseGuideWireOptions = {
  root?: ParentNode | null;
  api?: SettingsDataApi;
  toast?: (message: string) => unknown;
};

type SettingsExerciseGuideStatus = {
  imported?: unknown;
  guides?: unknown;
  linked?: unknown;
  suggested?: unknown;
  images_cached?: unknown;
};

type SettingsExerciseGuideImport = {
  ok?: unknown;
  error?: unknown;
  linked?: unknown;
  records?: unknown;
  dropped?: unknown;
};

function guideCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// One plain sentence about what the library holds — never a percentage or a grade,
// and honest that an unmatched movement simply has no guide.
function exerciseGuideStatusLine(status: SettingsExerciseGuideStatus | null): string {
  if (!status || !status.imported) return "Not fetched yet — exercise detail shows no how-to section.";
  const guides = guideCount(status.guides);
  const linked = guideCount(status.linked);
  const photos = guideCount(status.images_cached);
  const movements = linked === 1 ? "1 of your movements" : `${linked} of your movements`;
  const parts = [`${guides} movements stored, matched to ${movements}`];
  if (photos) parts.push(`${photos} demonstration ${photos === 1 ? "photo" : "photos"} cached`);
  return `${parts.join(" · ")}.`;
}

function wireExerciseGuideCard(options: SettingsExerciseGuideWireOptions = {}): void {
  const root = options.root || (typeof document !== "undefined" ? document : null);
  const apiFn = options.api || (typeof api !== "undefined" ? api : null);
  if (!root || !apiFn) return;
  const line = root.querySelector<HTMLElement>("#exGuideStatus");
  const button = root.querySelector<HTMLButtonElement>("#exGuideImport");

  const paint = (status: SettingsExerciseGuideStatus | null) => {
    if (line?.isConnected) line.textContent = exerciseGuideStatusLine(status);
    if (button?.isConnected) button.textContent = status?.imported ? "Refresh exercise guide" : "Fetch exercise guide";
  };

  apiFn("/exercise-guides/status")
    .then((status) => paint((status || null) as SettingsExerciseGuideStatus | null))
    .catch(() => paint(null));

  button?.addEventListener("click", async () => {
    if (!button.isConnected) return;
    button.disabled = true;
    button.textContent = "Fetching…";
    if (line?.isConnected) line.textContent = "Downloading the movement library…";
    let result: SettingsExerciseGuideImport | null = null;
    try {
      result = (await apiFn("/exercise-guides/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: true }),
      })) as SettingsExerciseGuideImport | null;
    } catch {
      result = null;
    }
    if (!button.isConnected) return;
    button.disabled = false;
    // ok:false at HTTP 200 is the designed failure signal here (offline, upstream
    // down) — say so plainly and leave the app exactly as it was.
    if (!result || !result.ok) {
      const why = String(result?.error ?? "").trim();
      if (line?.isConnected) line.textContent = why ? `Could not fetch the guide: ${why}` : "Could not fetch the guide.";
      button.textContent = "Try again";
      options.toast?.("Exercise guide unavailable");
      return;
    }
    options.toast?.(`Exercise guide ready — ${guideCount(result.linked)} matched`);
    try {
      paint((await apiFn("/exercise-guides/status")) as SettingsExerciseGuideStatus | null);
    } catch {
      paint(null);
    }
    // Rows the upstream file no longer shapes the way we read it. Normally none, so
    // it is said only when there are some — plainly, as a fact about the download.
    const dropped = guideCount(result.dropped);
    if (dropped && line?.isConnected) {
      line.textContent = `${line.textContent} ${dropped} upstream ${dropped === 1 ? "row was" : "rows were"} skipped as unreadable.`;
    }
  });
}

const CAIRN_SETTINGS_DATA = {
  phoneAccessCardHtml,
  wirePhoneAccessCard,
  exerciseGuideStatusLine,
  wireExerciseGuideCard,
};

Object.assign(globalThis, { CairnSettingsData: CAIRN_SETTINGS_DATA });

if (typeof window !== "undefined") {
  window.CairnSettingsData = CAIRN_SETTINGS_DATA;
}
