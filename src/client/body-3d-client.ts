// Body 3D progressive enhancement.
//
// This intentionally stays tiny: no CDN, no Three.js in the app shell, and no
// replacement of the 2D body figure until WebGL has produced a nonblank first
// frame. It is a scaffold for the later rigged mesh work, but the runtime
// contract is real: capability gate, visible-only start, hidden-tab pause, and a
// same-slot fallback that remains first paint.

type Body3DReason = "ok" | "reduced_motion" | "hidden_document" | "no_canvas" | "no_webgl" | "offscreen" | "render_failed";
type Body3DSiteKey = "chest_in" | "waist_in" | "hip_in" | "shoulder_in" | "upper_arm_in" | "thigh_in";

interface Body3DModel {
  female?: boolean;
  unit?: "in" | "cm";
  heightIn?: number | null;
  selected?: string | null;
  focus?: string | null;
  sites?: Partial<Record<Body3DSiteKey, number | null>>;
}

interface Body3DEnhanceOptions {
  model: Body3DModel;
  onReady?: () => void;
  onSelect?: (site: Body3DSiteKey) => void;
}

interface Body3DEnhancement {
  status: "skipped" | "waiting" | "ready";
  reason: Body3DReason;
  destroy(): void;
}

(() => {
const BODY3D_SITE_KEYS: Body3DSiteKey[] = ["chest_in", "waist_in", "hip_in", "shoulder_in", "upper_arm_in", "thigh_in"];
const BODY3D_VERTEX = `
attribute vec2 a_pos;
attribute float a_shade;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform float u_focus;
varying float v_shade;
varying float v_focus;
void main() {
  vec2 p = a_pos * u_scale + u_offset;
  gl_Position = vec4(p, 0.0, 1.0);
  v_shade = a_shade;
  v_focus = u_focus;
}`;
const BODY3D_FRAGMENT = `
precision mediump float;
varying float v_shade;
varying float v_focus;
void main() {
  vec3 base = mix(vec3(0.76, 0.69, 0.57), vec3(0.93, 0.88, 0.78), v_shade);
  vec3 focus = mix(base, vec3(0.71, 0.33, 0.18), v_focus * 0.32);
  gl_FragColor = vec4(focus, 0.96);
}`;

function body3dReduced(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function body3dVisibleDocument(): boolean {
  return typeof document === "undefined" || !("visibilityState" in document) || document.visibilityState !== "hidden";
}

function body3dCanvas(): HTMLCanvasElement | null {
  try {
    return typeof document !== "undefined" && typeof document.createElement === "function"
      ? document.createElement("canvas")
      : null;
  } catch {
    return null;
  }
}

function body3dContext(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  try {
    return (canvas.getContext("webgl", { alpha: true, antialias: true, powerPreference: "low-power" }) ||
      canvas.getContext("experimental-webgl", { alpha: true, antialias: true })) as WebGLRenderingContext | null;
  } catch {
    return null;
  }
}

function canEnhanceBody3D(): { ok: boolean; reason: Body3DReason } {
  if (body3dReduced()) return { ok: false, reason: "reduced_motion" };
  if (!body3dVisibleDocument()) return { ok: false, reason: "hidden_document" };
  const canvas = body3dCanvas();
  if (!canvas) return { ok: false, reason: "no_canvas" };
  const gl = body3dContext(canvas);
  return gl ? { ok: true, reason: "ok" } : { ok: false, reason: "no_webgl" };
}

function inches(value: number | null | undefined, unit: "in" | "cm" | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return unit === "cm" ? value / 2.54 : value;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function ratioWidth(model: Body3DModel, key: Body3DSiteKey, fallback: number, scale: number): number {
  const raw = inches(model.sites?.[key], model.unit);
  return clamp(((raw ?? fallback) / fallback) * scale, scale * 0.72, scale * 1.22);
}

function pushEllipse(out: number[], cx: number, cy: number, rx: number, ry: number, focus: number): void {
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const b = ((i + 1) / steps) * Math.PI * 2;
    const shadeA = 0.55 + Math.cos(a - 0.8) * 0.28;
    const shadeB = 0.55 + Math.cos(b - 0.8) * 0.28;
    out.push(cx, cy, 0.82 + focus, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, shadeA + focus, cx + Math.cos(b) * rx, cy + Math.sin(b) * ry, shadeB + focus);
  }
}

function body3dVertices(model: Body3DModel): Float32Array {
  const female = !!model.female;
  const chest = ratioWidth(model, "chest_in", female ? 35 : 39, 0.29);
  const waist = ratioWidth(model, "waist_in", female ? 28 : 33, 0.24);
  const hip = ratioWidth(model, "hip_in", female ? 38 : 37.5, 0.29);
  const shoulder = ratioWidth(model, "shoulder_in", female ? 39 : 45, 0.38);
  const arm = ratioWidth(model, "upper_arm_in", female ? 10.5 : 12.5, 0.075);
  const thigh = ratioWidth(model, "thigh_in", 21.5, 0.12);
  const focusWaist = model.focus === "waist" || model.selected === "waist_in" ? 0.18 : 0;
  const out: number[] = [];
  pushEllipse(out, 0, 0.63, 0.09, 0.12, 0);
  pushEllipse(out, 0, 0.28, shoulder, 0.12, 0);
  pushEllipse(out, 0, 0.06, chest, 0.23, 0);
  pushEllipse(out, 0, -0.16, waist, 0.18, focusWaist);
  pushEllipse(out, 0, -0.38, hip, 0.18, 0);
  pushEllipse(out, -shoulder * 0.88, -0.08, arm, 0.39, model.selected === "upper_arm_in" ? 0.14 : 0);
  pushEllipse(out, shoulder * 0.88, -0.08, arm, 0.39, model.selected === "upper_arm_in" ? 0.14 : 0);
  pushEllipse(out, -hip * 0.38, -0.77, thigh, 0.42, model.selected === "thigh_in" ? 0.14 : 0);
  pushEllipse(out, hip * 0.38, -0.77, thigh, 0.42, model.selected === "thigh_in" ? 0.14 : 0);
  return new Float32Array(out);
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "compile");
  return shader;
}

function program(gl: WebGLRenderingContext): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("program");
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, BODY3D_VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, BODY3D_FRAGMENT));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
  return p;
}

function renderBody3DFrame(canvas: HTMLCanvasElement, model: Body3DModel): boolean {
  const gl = body3dContext(canvas);
  if (!gl) return false;
  const dpr = Math.min(2, Math.max(1, typeof devicePixelRatio === "number" ? devicePixelRatio : 1));
  const w = Math.max(260, Math.round((canvas.clientWidth || 420) * dpr));
  const h = Math.max(420, Math.round((canvas.clientHeight || 645) * dpr));
  canvas.width = w;
  canvas.height = h;
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const p = program(gl);
  gl.useProgram(p);
  const data = body3dVertices(model);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const stride = 3 * 4;
  const pos = gl.getAttribLocation(p, "a_pos");
  const shade = gl.getAttribLocation(p, "a_shade");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(shade);
  gl.vertexAttribPointer(shade, 1, gl.FLOAT, false, stride, 2 * 4);
  const scale = gl.getUniformLocation(p, "u_scale");
  const offset = gl.getUniformLocation(p, "u_offset");
  const focus = gl.getUniformLocation(p, "u_focus");
  gl.uniform2f(scale, 1.12, 1.0);
  gl.uniform2f(offset, 0, 0);
  gl.uniform1f(focus, model.focus === "waist" ? 0.08 : 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLES, 0, data.length / 3);
  const px = new Uint8Array(4);
  gl.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px[3] > 0;
}

function likelyVisible(el: HTMLElement): boolean {
  if (!body3dVisibleDocument()) return false;
  if (typeof el.getBoundingClientRect !== "function") return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom >= 0 && r.right >= 0;
}

function selectedFromPoint(x: number, y: number, rect: DOMRect): Body3DSiteKey {
  const nx = x - rect.left;
  const ny = (y - rect.top) / Math.max(1, rect.height);
  if (ny < 0.33) return "chest_in";
  if (ny < 0.52) return "waist_in";
  if (ny < 0.65) return "hip_in";
  if (ny > 0.68) return "thigh_in";
  return nx < rect.width * 0.5 ? "upper_arm_in" : "shoulder_in";
}

function enhanceBody3D(slot: HTMLElement, opts: Body3DEnhanceOptions): Body3DEnhancement {
  const cap = canEnhanceBody3D();
  let destroyed = false;
  let detachVisibility: (() => void) | null = null;
  let observer: IntersectionObserver | null = null;
  if (!cap.ok) {
    slot.dataset.body3d = `fallback:${cap.reason}`;
    return { status: "skipped", reason: cap.reason, destroy() {} };
  }

  const start = (): Body3DEnhancement => {
    if (destroyed) return state;
    if (!likelyVisible(slot)) {
      slot.dataset.body3d = "fallback:offscreen";
      return state;
    }
    const canvas = body3dCanvas();
    if (!canvas) {
      slot.dataset.body3d = "fallback:no_canvas";
      state.status = "skipped";
      state.reason = "no_canvas";
      return state;
    }
    canvas.className = "bm-body3d";
    canvas.setAttribute("aria-label", "A capability-gated 3D body preview. The original 2D figure remains available as fallback.");
    canvas.setAttribute("role", "img");
    canvas.style.cssText = "display:none;width:100%;max-width:440px;aspect-ratio:420/645;margin:0 auto;cursor:pointer";
    try {
      const ready = renderBody3DFrame(canvas, opts.model);
      if (!ready) throw new Error("blank");
      slot.appendChild(canvas);
      const fallback = slot.querySelector(".bm-figure-fallback") as HTMLElement | null;
      if (fallback) fallback.hidden = true;
      canvas.style.display = "block";
      slot.dataset.body3d = "ready";
      state.status = "ready";
      state.reason = "ok";
      opts.onReady?.();
      canvas.addEventListener("click", (e) => {
        if (!opts.onSelect || typeof canvas.getBoundingClientRect !== "function") return;
        opts.onSelect(selectedFromPoint((e as MouseEvent).clientX, (e as MouseEvent).clientY, canvas.getBoundingClientRect()));
      });
    } catch {
      slot.dataset.body3d = "fallback:render_failed";
      state.status = "skipped";
      state.reason = "render_failed";
    }
    return state;
  };

  const state: Body3DEnhancement = {
    status: "waiting",
    reason: "offscreen",
    destroy() {
      destroyed = true;
      if (observer) observer.disconnect();
      if (detachVisibility) detachVisibility();
      const canvas = slot.querySelector(".bm-body3d");
      if (canvas && canvas.parentElement) canvas.parentElement.removeChild(canvas);
      const fallback = slot.querySelector(".bm-figure-fallback") as HTMLElement | null;
      if (fallback) fallback.hidden = false;
    },
  };

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") slot.dataset.body3dPaused = "true";
      else {
        delete slot.dataset.body3dPaused;
        if (state.status === "waiting") start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    detachVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
  }

  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer?.disconnect();
        observer = null;
        start();
      }
    }, { threshold: 0.1 });
    observer.observe(slot);
  } else {
    start();
  }
  return state;
}

const CAIRN_BODY_3D = {
  canEnhance: canEnhanceBody3D,
  enhance: enhanceBody3D,
  _test: { body3dVertices, renderBody3DFrame, selectedFromPoint },
};
Object.assign(globalThis, { CairnBody3D: CAIRN_BODY_3D });
if (typeof window !== "undefined") {
  (window as unknown as { CairnBody3D: typeof CAIRN_BODY_3D }).CairnBody3D = CAIRN_BODY_3D;
}
})();
