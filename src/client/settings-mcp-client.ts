// @ts-check
// Settings -> Devices -> "Connected AI apps": how Claude Code, the Claude app, ChatGPT or
// any other MCP client reaches this Cairn's /mcp (lazy settings bundle).
//
//   - The address: `<origin>/mcp`, with one line for apps that sign in on their own
//     ("Add custom connector" — paste the address, sign in to Cairn, Allow). That path is
//     OAuth (src/routes/oauth.ts); it needs an https address and sign-in turned on.
//   - "New key for an app": names a connection, then shows its key ONCE with copy-ready
//     setup for Claude Code and a generic JSON config, and a Test that makes a real
//     `initialize` call against /mcp with that key (and no cookie, so the browser's own
//     session can never make a bad key look good).
//   - Every live connection (where it returns to, which device approved it and when, last
//     use) with a Disconnect. Signing ANOTHER device out disconnects the apps it connected.
// The key is held in this closure only while it is on screen; it is never stored.

type SettingsMcpApi = (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>;

type SettingsMcpClientRow = {
  id: number;
  name: string;
  kind: "token" | "oauth";
  created_at: string;
  last_used_at: string | null;
  redirect_host: string | null;
  device_name?: string | null;
};

type SettingsMcpWireDeps = {
  root: ParentNode;
  api: SettingsMcpApi;
  origin: string;
  relTime?: (iso: string) => string;
  day?: (iso: string) => string; // injected in tests; default: the viewer's own short date
  toast?: (message: string) => void;
  confirm?: (opts: { title: string; body: string; action: string }) => Promise<boolean>;
  copy?: (text: string) => Promise<boolean>;
  /** Injected in tests; the browser build POSTs an MCP initialize to /mcp with the key. */
  testKey?: (token: string) => Promise<boolean>;
};

{
  function mcpUrlFor(origin: string): string {
    return `${String(origin || "").replace(/\/+$/, "")}/mcp`;
  }

  /** `claude mcp add` for Claude Code, with the key as a header. */
  function claudeCodeCommand(url: string, token: string): string {
    return `claude mcp add --transport http cairn ${url} --header "Authorization: Bearer ${token}"`;
  }

  /** The common `mcpServers` JSON shape most MCP clients read. */
  function jsonConfig(url: string, token: string): string {
    return JSON.stringify(
      { mcpServers: { cairn: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
      null,
      2
    );
  }

  function mcpCardHtml(): string {
    return `<section class="set-group set-group--flush mcp-group">
      <div id="mcpCard" class="sess mcp-card" hidden>
        <h2 class="lbl pair-h">Connected AI apps</h2>
        <div class="sess-line">Let Claude, ChatGPT or another AI app read and update your Cairn over MCP. Each app gets its own access, and you can take it back here.</div>
        <div class="mcp-addr">
          <div class="access-meta">Your MCP address</div>
          <div class="mcp-addr-row"><code class="mcp-code" data-mcp-url></code><button class="linkbtn-quiet" type="button" data-mcp-copy="url">Copy</button></div>
        </div>
        <div class="sess-line access-muted mcp-note" data-mcp-oauth-on hidden>In the Claude app, ChatGPT or any app with “Add custom connector”: paste this address, sign in to Cairn when asked, and tap Allow. Nothing else to copy.</div>
        <div class="sess-line access-muted mcp-note" data-mcp-oauth-off hidden>Apps that sign in on their own need this Cairn on a secure (https) address. A key below works anywhere.</div>
        <ul class="access-list mcp-list" data-mcp-list><li class="sess-line access-muted">Checking…</li></ul>
        <button class="ghostbtn access-wide" type="button" data-mcp-new>New key for an app</button>
        <form class="mcp-form" data-mcp-form hidden>
          <label class="signin-lbl" for="mcpName">Which app is this for?</label>
          <div class="mcp-form-row">
            <input class="token-sheet-in" id="mcpName" name="name" maxlength="60" autocomplete="off" placeholder="Claude Code on my laptop">
            <button class="token-sheet-btn" type="submit">Make key</button>
          </div>
          <button class="linkbtn-quiet" type="button" data-mcp-cancel>Cancel</button>
        </form>
        <div class="mcp-reveal" data-mcp-reveal hidden>
          <div class="sess-line"><strong>Copy this key now.</strong> Cairn shows it once and keeps only a fingerprint of it.</div>
          <div class="mcp-addr-row"><code class="mcp-code mcp-secret" data-mcp-token></code><button class="linkbtn-quiet" type="button" data-mcp-copy="token">Copy</button></div>
          <h3 class="mcp-h">Claude Code</h3>
          <pre class="mcp-snippet" data-mcp-snippet="claude"></pre>
          <button class="linkbtn-quiet" type="button" data-mcp-copy="claude">Copy command</button>
          <h3 class="mcp-h">Other apps (JSON config)</h3>
          <pre class="mcp-snippet" data-mcp-snippet="json"></pre>
          <button class="linkbtn-quiet" type="button" data-mcp-copy="json">Copy config</button>
          <div class="mcp-test">
            <button class="ghostbtn" type="button" data-mcp-test>Test connection</button>
            <span class="access-meta" data-mcp-test-result role="status" aria-live="polite"></span>
          </div>
          <button class="ghostbtn access-wide" type="button" data-mcp-done>Done</button>
        </div>
        <div class="sess-line access-muted mcp-foot">Signing out another device also disconnects the apps it connected. Signing this device out leaves them connected.</div>
      </div>
      <div class="sess-line access-muted" data-mcp-off hidden>Sign-in is off on this Cairn, so any MCP client that can reach <code class="mcp-code" data-mcp-url-off></code> connects without a key.</div>
    </section>`;
  }

  function mcpRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  }

  function mcpRows(body: unknown): SettingsMcpClientRow[] {
    const list = mcpRecord(body)?.clients;
    return Array.isArray(list) ? (list.filter((c) => mcpRecord(c)) as SettingsMcpClientRow[]) : [];
  }

  /** "Oct 3": the stored UTC stamp's day in the viewer's own calendar, through CairnFmt. */
  function mcpDay(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const day = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
    return typeof CairnFmt === "undefined" ? day : CairnFmt.date(day);
  }

  /** "approved from Safari on iPhone · Oct 3" — which device let it in, and when. */
  function mcpProvenance(client: SettingsMcpClientRow, dayFn: (iso: string) => string): string {
    const verb = client.kind === "oauth" ? "Approved" : "Made";
    const where = client.device_name ? ` ${client.kind === "oauth" ? "from" : "on"} ${client.device_name}` : "";
    const day = dayFn(client.created_at);
    return `${verb}${where}${day ? ` · ${day}` : ""}`;
  }

  function mcpRowHtml(client: SettingsMcpClientRow, relTimeFn: (iso: string) => string, dayFn = mcpDay): string {
    const how =
      client.kind === "oauth"
        ? `Signed in${client.redirect_host ? ` · returns to ${client.redirect_host}` : ""}`
        : "Key";
    const used = client.last_used_at ? `Last used ${relTimeFn(client.last_used_at)}` : "Not used yet";
    return `<li class="access-row" data-mcp-id="${escAttr(client.id)}">
      <div class="access-main">
        <div class="access-name">${escHtml(client.name)}</div>
        <div class="access-meta">${escHtml(`${how} · ${used}`)}</div>
        <div class="access-meta">${escHtml(mcpProvenance(client, dayFn))}</div>
      </div>
      <div class="access-actions"><button class="linkbtn-quiet" type="button" data-mcp-revoke>Disconnect</button></div>
    </li>`;
  }

  async function defaultCopy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** A real MCP `initialize` against /mcp with ONLY the key (no cookie), so a bad key fails. */
  async function defaultTestKey(token: string): Promise<boolean> {
    try {
      const response = await fetch("/mcp", {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "Cairn Settings connection test", version: "1" },
          },
        }),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  function settingsMcpConfirm(opts: { title: string; body: string; action: string }): Promise<boolean> {
    return new Promise((resolve) => {
      if (typeof CairnUiSheet === "undefined") return resolve(false);
      let answered = false;
      const sheet = CairnUiSheet.open({
        overlayClass: "token-sheet-ov",
        sheetClass: "token-sheet",
        labelledBy: "mcpConfirmTitle",
        html: `<h2 class="token-sheet-h" id="mcpConfirmTitle">${escHtml(opts.title)}</h2>
        <p class="token-sheet-p">${escHtml(opts.body)}</p>
        <div class="token-sheet-ft signin-offer-ft">
          <button class="linkbtn-quiet" type="button" data-ui-sheet-close>Cancel</button>
          <button class="token-sheet-btn" type="button" data-mcp-confirm>${escHtml(opts.action)}</button>
        </div>`,
        onClose: () => {
          if (!answered) resolve(false);
        },
      });
      sheet.sheet.querySelector("[data-mcp-confirm]")?.addEventListener("click", () => {
        answered = true;
        resolve(true);
        sheet.close();
      });
    });
  }

  function wireMcpCard(deps: SettingsMcpWireDeps): void {
    const card = deps.root.querySelector<HTMLElement>("#mcpCard");
    if (!card) return;
    const seenWhen =
      deps.relTime || ((iso: string) => (typeof relTime === "function" ? relTime(iso) : iso.slice(0, 10)));
    const say = deps.toast || ((message: string) => (typeof toast === "function" ? toast(message) : undefined));
    const confirm = deps.confirm || settingsMcpConfirm;
    const copy = deps.copy || defaultCopy;
    const testKey = deps.testKey || defaultTestKey;
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => card.querySelector<T>(sel);

    let url = mcpUrlFor(deps.origin);
    let clients: SettingsMcpClientRow[] = [];
    // The key being shown, and nothing else — cleared on Done or the next render.
    let shown: { token: string } | null = null;

    const setUrl = (value: string): void => {
      url = value;
      const el = q("[data-mcp-url]");
      if (el) el.textContent = url;
    };
    setUrl(url);

    const renderList = (): void => {
      const list = q("[data-mcp-list]");
      if (!list) return;
      list.innerHTML = clients.length
        ? clients.map((c) => mcpRowHtml(c, seenWhen, deps.day || mcpDay)).join("")
        : `<li class="sess-line access-muted">No app is connected yet.</li>`;
    };

    const refresh = async (): Promise<void> => {
      const body = mcpRecord(await deps.api("/auth/mcp-clients").catch(() => null));
      if (!body) return;
      if (typeof body.mcp_url === "string" && body.mcp_url) setUrl(body.mcp_url);
      if (body.auth_required !== true) {
        card.hidden = true;
        const off = deps.root.querySelector<HTMLElement>("[data-mcp-off]");
        const offUrl = deps.root.querySelector<HTMLElement>("[data-mcp-url-off]");
        if (offUrl) offUrl.textContent = url;
        if (off) off.hidden = false;
        return;
      }
      card.hidden = false;
      const on = q("[data-mcp-oauth-on]");
      const offNote = q("[data-mcp-oauth-off]");
      if (on) on.hidden = body.oauth_available !== true;
      if (offNote) offNote.hidden = body.oauth_available === true;
      clients = mcpRows(body);
      renderList();
    };
    void refresh();

    const form = q<HTMLFormElement>("[data-mcp-form]");
    const newBtn = q<HTMLButtonElement>("[data-mcp-new]");
    const reveal = q("[data-mcp-reveal]");
    const resultEl = q("[data-mcp-test-result]");

    const closeReveal = (): void => {
      shown = null;
      if (reveal) reveal.hidden = true;
      for (const sel of ["[data-mcp-token]", "[data-mcp-snippet=claude]", "[data-mcp-snippet=json]"]) {
        const el = q(sel);
        if (el) el.textContent = "";
      }
      if (resultEl) resultEl.textContent = "";
      if (newBtn) newBtn.hidden = false;
    };

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>("input[name=name]");
      const name = (input?.value || "").trim() || "AI app";
      const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
      if (submit) submit.disabled = true;
      const made = mcpRecord(
        await deps
          .api("/auth/mcp-clients", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          })
          .catch(() => null)
      );
      if (submit) submit.disabled = false;
      const token = typeof made?.token === "string" ? made.token : "";
      if (!token) {
        say("Couldn't make a key. Try again in a moment.");
        return;
      }
      if (typeof made?.mcp_url === "string" && made.mcp_url) setUrl(made.mcp_url);
      shown = { token };
      if (input) input.value = "";
      form.hidden = true;
      const tokenEl = q("[data-mcp-token]");
      const claude = q("[data-mcp-snippet=claude]");
      const json = q("[data-mcp-snippet=json]");
      if (tokenEl) tokenEl.textContent = token;
      if (claude) claude.textContent = claudeCodeCommand(url, token);
      if (json) json.textContent = jsonConfig(url, token);
      if (resultEl) resultEl.textContent = "";
      if (reveal) reveal.hidden = false;
      await refresh();
    });

    card.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.closest !== "function") return;

      if (target.closest("[data-mcp-new]")) {
        closeReveal();
        if (newBtn) newBtn.hidden = true;
        if (form) {
          form.hidden = false;
          form.querySelector<HTMLInputElement>("input")?.focus();
        }
        return;
      }
      if (target.closest("[data-mcp-cancel]")) {
        if (form) form.hidden = true;
        if (newBtn) newBtn.hidden = false;
        return;
      }
      if (target.closest("[data-mcp-done]")) {
        closeReveal();
        return;
      }

      const copyBtn = target.closest<HTMLElement>("[data-mcp-copy]");
      if (copyBtn) {
        const what = copyBtn.dataset.mcpCopy;
        const text =
          what === "url"
            ? url
            : !shown
              ? ""
              : what === "token"
                ? shown.token
                : what === "claude"
                  ? claudeCodeCommand(url, shown.token)
                  : jsonConfig(url, shown.token);
        if (!text) return;
        say((await copy(text)) ? "Copied." : "Couldn't copy — select the text instead.");
        return;
      }

      if (target.closest("[data-mcp-test]") && shown) {
        const button = target.closest<HTMLButtonElement>("[data-mcp-test]");
        if (button) button.disabled = true;
        if (resultEl) resultEl.textContent = "Testing…";
        const ok = await testKey(shown.token);
        if (button) button.disabled = false;
        if (resultEl)
          resultEl.textContent = ok
            ? "Connected — the key works."
            : "That didn't connect. Check the address and try again.";
        if (ok) await refresh();
        return;
      }

      const row = target.closest<HTMLElement>("[data-mcp-id]");
      if (target.closest("[data-mcp-revoke]") && row) {
        const client = clients.find((c) => c.id === Number(row.dataset.mcpId));
        if (!client) return;
        const ok = await confirm({
          title: `Disconnect ${client.name}?`,
          body:
            client.kind === "oauth"
              ? "It stops reaching your Cairn at once. To use it again, connect it again and sign in."
              : "Its key stops working at once. To use the app again, make it a new key.",
          action: "Disconnect",
        });
        if (!ok) return;
        const result = mcpRecord(
          await deps.api(`/auth/mcp-clients/${client.id}`, { method: "DELETE" }).catch(() => null)
        );
        say(result?.ok ? `Disconnected ${client.name}.` : "Couldn't disconnect it. Try again in a moment.");
        await refresh();
      }
    });
  }

  const CAIRN_SETTINGS_MCP = {
    mcpUrlFor,
    claudeCodeCommand,
    jsonConfig,
    cardHtml: mcpCardHtml,
    rowHtml: mcpRowHtml,
    wire: wireMcpCard,
  };

  Object.assign(globalThis, { CairnSettingsMcp: CAIRN_SETTINGS_MCP });
}
