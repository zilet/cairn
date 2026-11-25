// The capability read's two protocol surfaces and the Progress lead it feeds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../dist/mcp.js";
import { programRouter } from "../dist/routes/program.js";
import { repo } from "./_seed.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function get(url, query = {}) {
  return new Promise((resolve, reject) => {
    const request = { method: "GET", url, originalUrl: url, query, headers: {} };
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        resolve({ status: this.statusCode, body: value });
        return this;
      },
    };
    programRouter.handle(request, response, (error) => reject(error ?? new Error("unhandled")));
  });
}

test("REST and MCP return the capability read's shape", async () => {
  const date = "2026-11-24";
  const expected = JSON.parse(JSON.stringify(repo.capabilityRead(date)));
  const rest = await get("/strength-capability", { date });
  assert.equal(rest.status, 200);
  assert.deepEqual(rest.body, expected);
  assert.equal(typeof rest.body.available, "boolean");
  assert.ok(Array.isArray(rest.body.units) && Array.isArray(rest.body.muscles));

  const server = buildMcpServer();
  const client = new Client({ name: "capability-test", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  try {
    const result = await client.callTool({ name: "get_strength_capability", arguments: { date } });
    const text = result.content.find((entry) => entry.type === "text")?.text;
    assert.deepEqual(JSON.parse(text), expected);
  } finally {
    await client.close();
    await server.close();
  }
});

function loadCapabilityClient({ apiResult } = {}) {
  const slot = { innerHTML: "", isConnected: true };
  let voiceRemoved = false;
  const context = {
    Object,
    String,
    Number,
    Array,
    stagger: (i) => `--i:${i}`,
    state: { tab: "progress", progressSeg: "program" },
    api: async () => apiResult,
    wireGuides() {},
    view: {
      querySelector(sel) {
        if (sel === "#progCapSlot") return slot;
        if (sel === ".prog-lifts-voice") return { remove: () => (voiceRemoved = true) };
        return null;
      },
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-capability-client.js"), "utf8"), context);
  return { cap: context.CairnProgressCapability, slot, voiceRemoved: () => voiceRemoved };
}

const read = {
  available: true,
  date: "2026-11-24",
  overall: { verdict: "climbing", line: "Strength is climbing <script>alert(1)</script>" },
  units: [
    {
      key: "squat", label: "Squat <img src=x>", kind: "pattern", compound: true, in_plan: true,
      verdict: "holding", qualifiers: ["cut", "run_build", "recovery"], hard_sets_trend: "steady",
      line: "Holding <b>steady</b>.",
      contributors: [
        { exercise: "Back Squat", exercise_id: 1, in_plan: true, last_trained: null, exposures: 3, direction: "holding", transfer: "own" },
        { exercise: "Goblet <x>", exercise_id: 2, in_plan: false, last_trained: null, exposures: 1, direction: "holding", transfer: "table" },
      ],
    },
    {
      key: "curl", label: "Curl region", kind: "region", compound: false, in_plan: false,
      verdict: "slipping", qualifiers: [], hard_sets_trend: null, line: "Off plan line.", contributors: [],
    },
  ],
  muscles: [{ group: "quads", verdict: "progressing", weekly_hard_sets: 12, band: null, volume_trend: null, units: ["squat"], line: "Quads are moving." }],
};

test("capability lead renders hero, on-plan units, contributors, qualifiers and the off-plan disclosure", () => {
  const { cap } = loadCapabilityClient();
  const html = cap.capabilityHtml(read);
  assert.match(html, /<h2 class="prog-lifts-line">Strength is climbing &lt;script&gt;/);
  assert.match(html, /Squat &lt;img src=x&gt;/);
  assert.match(html, /holding through the cut/);
  assert.match(html, /the legs are carrying the run build/);
  assert.match(html, /a lighter week/);
  assert.match(html, /Back Squat/);
  assert.match(html, /on your plan/);
  assert.match(html, /not on the plan now/);
  assert.match(html, /Quads are moving\./);
  const also = html.split("Also trained lately")[1];
  assert.ok(also && also.includes("Curl region"), "off-plan unit sits behind the disclosure");
  assert.ok(!html.split("Also trained lately")[0].includes("Curl region"), "off-plan unit never headlined");
  assert.ok(!/<script|<img|<b>|<x>/.test(html), "hostile strings are escaped");
  assert.ok(!/12/.test(html), "no set counts presented");
});

test("an unavailable read renders nothing and leaves the page as it was", async () => {
  const { cap } = loadCapabilityClient();
  assert.equal(cap.capabilityHtml({ available: false, date: "x", overall: null, units: [], muscles: [] }), "");
  assert.equal(cap.capabilityHtml(null), "");
  const off = loadCapabilityClient({ apiResult: { available: false, units: [], muscles: [], overall: null } });
  await off.cap.loadCapability();
  assert.equal(off.slot.innerHTML, "");
  assert.equal(off.voiceRemoved(), false);
  const on = loadCapabilityClient({ apiResult: read });
  await on.cap.loadCapability();
  assert.match(on.slot.innerHTML, /pcap-hero/);
  assert.equal(on.voiceRemoved(), true);
});
