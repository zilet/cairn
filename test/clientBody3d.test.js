import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeGl(alpha = 255) {
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    COLOR_BUFFER_BIT: 9,
    BLEND: 10,
    SRC_ALPHA: 11,
    ONE_MINUS_SRC_ALPHA: 12,
    RGBA: 13,
    UNSIGNED_BYTE: 14,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    useProgram: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: (_p, name) => (name === "a_pos" ? 0 : 1),
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getUniformLocation: () => ({}),
    uniform2f: () => {},
    uniform1f: () => {},
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    enable: () => {},
    blendFunc: () => {},
    drawArrays: () => {},
    readPixels: (_x, _y, _w, _h, _fmt, _type, px) => {
      px[0] = 210;
      px[1] = 190;
      px[2] = 160;
      px[3] = alpha;
    },
  };
}

function el(className = "") {
  const node = {
    className,
    dataset: {},
    style: {},
    hidden: false,
    children: [],
    parentElement: null,
    attrs: {},
    listeners: {},
    clientWidth: 420,
    clientHeight: 645,
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(k, cb) {
      this.listeners[k] = cb;
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      child.parentElement = null;
    },
    querySelector(selector) {
      if (selector === ".bm-figure-fallback") return this.children.find((c) => c.className === "bm-figure-fallback") || null;
      if (selector === ".bm-body3d") return this.children.find((c) => c.className === "bm-body3d") || null;
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 420, bottom: 645, width: 420, height: 645 };
    },
  };
  return node;
}

function loadBody3D({ reduce = false, hidden = false, gl = fakeGl() } = {}) {
  const ctx = {
    console,
    Math,
    Number,
    Float32Array,
    Uint8Array,
    Error,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: reduce }),
    document: {
      visibilityState: hidden ? "hidden" : "visible",
      createElement: (tag) => {
        if (tag !== "canvas") return el();
        const canvas = el("");
        canvas.getContext = () => gl;
        return canvas;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInNewContext(readFileSync(join(root, "public/js/body-3d-client.js"), "utf8"), ctx);
  return ctx.CairnBody3D;
}

test("Body 3D capability gate rejects reduced motion, hidden documents, and missing WebGL", () => {
  const reduced = loadBody3D({ reduce: true }).canEnhance();
  assert.equal(reduced.ok, false);
  assert.equal(reduced.reason, "reduced_motion");
  const hidden = loadBody3D({ hidden: true }).canEnhance();
  assert.equal(hidden.ok, false);
  assert.equal(hidden.reason, "hidden_document");
  const noWebgl = loadBody3D({ gl: null }).canEnhance();
  assert.equal(noWebgl.ok, false);
  assert.equal(noWebgl.reason, "no_webgl");
  const ok = loadBody3D().canEnhance();
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, "ok");
});

test("Body 3D keeps the 2D fallback unless a nonblank first WebGL frame succeeds", () => {
  const body3d = loadBody3D({ gl: fakeGl(0) });
  const slot = el();
  const fallback = el("bm-figure-fallback");
  slot.appendChild(fallback);

  const result = body3d.enhance(slot, { model: { focus: "waist", unit: "in", sites: { waist_in: 40 } } });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "render_failed");
  assert.equal(fallback.hidden, false, "2D fallback remains visible on blank/failed render");
  assert.equal(slot.querySelector(".bm-body3d"), null, "failed canvas never promotes into the slot");
  assert.equal(slot.dataset.body3d, "fallback:render_failed");
});

test("Body 3D promotes only after ready and keeps region taps routed to the selected site", () => {
  const body3d = loadBody3D();
  const slot = el();
  const fallback = el("bm-figure-fallback");
  slot.appendChild(fallback);
  let ready = 0;
  let selected = null;

  const result = body3d.enhance(slot, {
    model: { focus: "waist", unit: "in", sites: { waist_in: 40, chest_in: 42, thigh_in: 23 } },
    onReady: () => { ready += 1; },
    onSelect: (site) => { selected = site; },
  });

  const canvas = slot.querySelector(".bm-body3d");
  assert.equal(result.status, "ready");
  assert.equal(result.reason, "ok");
  assert.equal(ready, 1);
  assert.equal(fallback.hidden, true, "2D fallback hides only after the ready callback path");
  assert.ok(canvas, "ready canvas is attached");
  canvas.listeners.click({ clientX: 210, clientY: 300 });
  assert.equal(selected, "waist_in");
  result.destroy();
  assert.equal(fallback.hidden, false, "destroy restores the fallback");
});
