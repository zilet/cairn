// Settings -> Devices -> "Connected AI apps" (settings-mcp-client.ts): the /mcp address,
// a key shown once with its Claude Code / JSON setup, a Test against /mcp, the list of
// connections with Disconnect, and the open-instance line. Plus the server's answers for
// an instance with sign-in OFF: no OAuth documents, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule } from "./_dom.mjs";

function load() {
  return loadClientModule(["html-utils", "settings-mcp-client"]);
}

const TOKEN = `cairn_mcp_${"a".repeat(43)}`;

function mcpApi({ authRequired = true, oauth = true, clients } = {}) {
  const calls = [];
  const state = {
    clients: clients ?? [
      {
        id: 1,
        name: "Claude <app>",
        kind: "oauth",
        created_at: "2026-10-01T00:00:00Z",
        last_used_at: "2026-10-06T00:00:00Z",
        redirect_host: "claude.ai",
        device_name: "Safari on <iPhone>",
      },
      {
        id: 2,
        name: "Laptop",
        kind: "token",
        created_at: "2026-10-01T00:00:00Z",
        last_used_at: null,
        redirect_host: null,
        device_name: null,
      },
    ],
  };
  const api = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || "GET", body: opts.body });
    if (path === "/auth/mcp-clients" && (opts.method || "GET") === "GET") {
      return {
        auth_required: authRequired,
        mcp_url: "https://cairn.example.app/mcp",
        oauth_available: oauth,
        clients: authRequired ? state.clients : [],
      };
    }
    if (path === "/auth/mcp-clients" && opts.method === "POST") {
      state.clients.push({
        id: 3,
        name: "New",
        kind: "token",
        created_at: "x",
        last_used_at: null,
        redirect_host: null,
      });
      return { ok: true, token: TOKEN, client: { id: 3 }, mcp_url: "https://cairn.example.app/mcp" };
    }
    if (path.startsWith("/auth/mcp-clients/") && opts.method === "DELETE") {
      state.clients = state.clients.filter((c) => `/auth/mcp-clients/${c.id}` !== path);
      return { ok: true };
    }
    return null;
  };
  return { api, calls, state };
}

test("snippets: Claude Code's command and the mcpServers JSON carry the URL and the key", () => {
  const win = load();
  const m = win.CairnSettingsMcp;
  assert.equal(m.mcpUrlFor("https://cairn.example.app/"), "https://cairn.example.app/mcp");
  assert.equal(
    m.claudeCodeCommand("https://c.example/mcp", TOKEN),
    `claude mcp add --transport http cairn https://c.example/mcp --header "Authorization: Bearer ${TOKEN}"`
  );
  const json = JSON.parse(m.jsonConfig("https://c.example/mcp", TOKEN));
  assert.deepEqual(json, {
    mcpServers: {
      cairn: { type: "http", url: "https://c.example/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
    },
  });
});

test("the card lists connections (escaped), says how each connects, and disconnects one", async () => {
  const win = load();
  const host = createHost(win.document, { html: win.CairnSettingsMcp.cardHtml() });
  const { api, calls } = mcpApi();
  const toasts = [];
  win.CairnSettingsMcp.wire({
    root: host,
    api,
    origin: "https://cairn.example.app",
    relTime: () => "yesterday",
    day: (iso) => `day(${iso.slice(0, 10)})`,
    toast: (m) => toasts.push(m),
    confirm: async () => true,
  });
  await flush();
  await flush();
  const card = host.querySelector("#mcpCard");
  assert.match(card.textContent, /Signing out another device also disconnects the apps it connected/);
  assert.doesNotMatch(card.textContent, /never disconnects/);
  assert.equal(card.hidden, false);
  assert.equal(host.querySelector("[data-mcp-url]").textContent, "https://cairn.example.app/mcp");
  assert.equal(host.querySelector("[data-mcp-oauth-on]").hidden, false);
  assert.equal(host.querySelector("[data-mcp-oauth-off]").hidden, true);
  const list = host.querySelector("[data-mcp-list]");
  assert.match(list.innerHTML, /Claude &lt;app&gt;/);
  assert.match(list.textContent, /Signed in · returns to claude\.ai · Last used yesterday/);
  assert.match(list.textContent, /Key · Not used yet/);
  // Which device let each one in, and when (escaped; a master-token key names no device).
  assert.match(list.textContent, /Approved from Safari on <iPhone> · day\(2026-10-01\)/);
  assert.match(list.innerHTML, /Safari on &lt;iPhone&gt;/);
  assert.match(list.textContent, /Made · day\(2026-10-01\)/);
  await host.querySelector('[data-mcp-id="2"] [data-mcp-revoke]').click();
  await flush();
  await flush();
  assert.ok(calls.some((c) => c.path === "/auth/mcp-clients/2" && c.method === "DELETE"));
  assert.ok(toasts.includes("Disconnected Laptop."));
  assert.doesNotMatch(host.querySelector("[data-mcp-list]").textContent, /Laptop/);
});

test("New key: named, shown once with setup, tested against /mcp, cleared on Done", async () => {
  const win = load();
  const host = createHost(win.document, { html: win.CairnSettingsMcp.cardHtml() });
  const { api, calls } = mcpApi({ clients: [] });
  const copied = [];
  const tested = [];
  win.CairnSettingsMcp.wire({
    root: host,
    api,
    origin: "https://cairn.example.app",
    toast: () => {},
    copy: async (t) => {
      copied.push(t);
      return true;
    },
    testKey: async (t) => {
      tested.push(t);
      return true;
    },
  });
  await flush();
  await flush();
  assert.match(host.querySelector("[data-mcp-list]").textContent, /No app is connected yet/);
  await host.querySelector("[data-mcp-new]").click();
  const form = host.querySelector("[data-mcp-form]");
  assert.equal(form.hidden, false);
  form.querySelector("input").value = "Claude Code";
  form.dispatchEvent(new win.Event("submit", { cancelable: true }));
  await flush();
  await flush();
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post.body), { name: "Claude Code" });
  assert.equal(host.querySelector("[data-mcp-reveal]").hidden, false);
  assert.equal(host.querySelector("[data-mcp-token]").textContent, TOKEN);
  assert.match(
    host.querySelector("[data-mcp-snippet=claude]").textContent,
    /^claude mcp add --transport http cairn https:\/\/cairn\.example\.app\/mcp/
  );
  assert.match(host.querySelector("[data-mcp-snippet=json]").textContent, /"Authorization": "Bearer cairn_mcp_/);
  await host.querySelector('[data-mcp-copy="claude"]').click();
  await flush();
  assert.match(copied[0], /--header "Authorization: Bearer cairn_mcp_/);
  await host.querySelector("[data-mcp-test]").click();
  await flush();
  await flush();
  assert.deepEqual(tested, [TOKEN]);
  assert.match(host.querySelector("[data-mcp-test-result]").textContent, /the key works/);
  await host.querySelector("[data-mcp-done]").click();
  assert.equal(host.querySelector("[data-mcp-reveal]").hidden, true);
  assert.equal(host.querySelector("[data-mcp-token]").textContent, "", "the key leaves the page");
});

test("an open instance shows one line and no card; an http host says OAuth needs https", async () => {
  const win = load();
  let host = createHost(win.document, { html: win.CairnSettingsMcp.cardHtml() });
  win.CairnSettingsMcp.wire({ root: host, api: mcpApi({ authRequired: false }).api, origin: "http://pi.local:8787" });
  await flush();
  await flush();
  assert.equal(host.querySelector("#mcpCard").hidden, true);
  assert.equal(host.querySelector("[data-mcp-off]").hidden, false);
  assert.equal(host.querySelector("[data-mcp-url-off]").textContent, "https://cairn.example.app/mcp");

  host = createHost(win.document, { html: win.CairnSettingsMcp.cardHtml() });
  win.CairnSettingsMcp.wire({ root: host, api: mcpApi({ oauth: false }).api, origin: "http://pi.local:8787" });
  await flush();
  await flush();
  assert.equal(host.querySelector("[data-mcp-oauth-on]").hidden, true);
  assert.equal(host.querySelector("[data-mcp-oauth-off]").hidden, false);
});

test("sign-in off: no OAuth documents, no registration, and keys are refused", async () => {
  delete process.env.CAIRN_AUTH_TOKEN;
  const express = (await import("express")).default;
  const auth = await import("../dist/auth.js");
  assert.equal(auth.authEnabled, false);
  const oauth = await import("../dist/routes/oauth.js");
  const { mcpClientsRouter } = await import("../dist/routes/mcp-clients.js");
  const app = express();
  app.use(auth.authGuard);
  app.use(express.json());
  app.use(oauth.oauthRouter);
  app.use("/api", mcpClientsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    const reg = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://a.example.com/cb"] }),
    });
    assert.equal(reg.status, 404);
    const list = await (await fetch(`${base}/api/auth/mcp-clients`)).json();
    assert.equal(list.auth_required, false);
    assert.equal(list.oauth_available, false);
    assert.deepEqual(list.clients, []);
    const make = await fetch(`${base}/api/auth/mcp-clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(make.status, 409);
  } finally {
    server.close();
  }
});
