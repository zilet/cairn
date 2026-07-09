# Track E — 3D Atelier Materials & Lighting Study

**Status:** RETIRED 2026-07-08 — 3D was built, evaluated live, and rejected; Cairn's body figure is **elite 2D** (see epilogue at the end)  
**Branch / worktree:** `feat/v1-track-e` · `~/workspace/playground/cairn-viz`  
**Contract parent:** [`docs/DESIGN.md`](./DESIGN.md) (frozen Atelier system)  
**Plan:** `.local/docs/CAIRN-V1-PLAN.md` Track E  

This document freezes the *look*, *data binding*, and *runtime contract* for the moonshot visualizations. Implementation must not invent palette, motion, or decorative dimensions outside what is listed here.

---

## 0. North star

> Elite = quiet and precise. The 3D must read as a **museum-catalog figure plate** under soft studio light on warm cream paper — never a neon fitness HUD, never a sci-fi medical sim, never a gamified score orb.

Cairn already ships a strong 2D body (`CairnBodyFigure`) and a data-bound SVG risk ribbon. Track E **promotes** those surfaces when the client can afford it; it never replaces first paint and never changes layout.

---

## 1. Palette → materials (hex truth from DESIGN.md)

All 3D colors derive from Atelier tokens. No free-floating RGB.

| Role | Token | Hex | 3D use |
|------|-------|-----|--------|
| Paper / clear | `--paper` | `#f4efe7` | Scene clear alpha over card; no full-bleed 3D chrome |
| Card | `--card` | `#fffdf8` | Slot background remains the card (canvas transparent) |
| Skin base (cool mid) | mix paper→stone | `#c2b092` | Diffuse base of living mesh (not literal skin sim) |
| Skin highlight | paper-warm | `#eee4d2` | Specular / rim soft-lift |
| Skin shadow | stone-taupe | `#7d6a56` | Ambient occlusion tint, contact shadow on ground disc |
| Ink | `--ink` | `#211d17` | Silhouette edge only if needed; never black |
| Terracotta focus | `--accent` | `#b4552d` | Selected region wash (≤32% mix into base — matches scaffold) |
| Terracotta deep | `--accent-deep` | `#93421f` | Focus rim, risk current path, heart motif fill |
| Sage | `--sage` | `#6e7f5c` | Optimal-ghost outline + optimized risk path |
| Sage bg | `--sage-bg` | `#eef0e6` | Ghost fill wash (very low opacity) |
| Gold | `--gold` | `#c9a86a` | Milestone waypoints, provisional risk markers |
| Warn | `--warn` | `#b3402e` | High enhancer / plaque load only (never decorative) |
| Muted | `--muted` | `#746c5c` | Axis labels stay in DOM/SVG, not WebGL text |

### Material recipes (PBR-ish, low complexity)

**Living body (E1 current physique)**  
- `MeshStandardMaterial` (or equivalent in trimmed Three):  
  - `color` = skin base `#c2b092`  
  - `roughness` ≈ **0.72** (matte clay / plaster cast, not plastic)  
  - `metalness` = **0**  
  - `emissive` = terracotta only when region selected, intensity ≤ **0.08**  
- No normal maps of pores/skin detail (reads medical-sim; banned).  
- Soft vertex AO baked into morph base shade (the scaffold already shades ellipses; keep that language).

**Optimal ghost (E1 target overlay)**  
- Same topology as living mesh, independent morph weights.  
- Material: sage `#6e7f5c` at **opacity 0.18–0.28**, `depthWrite: false`, `transparent: true`, doubleSide off.  
- Optional dashed silhouette is **not** drawn in WebGL — the 2D SVG already has a dashed optimal-waistline; in 3D the ghost *is* the full-body target, not a second dashed stroke language.  
- Ghost is **hidden** when every bound target is already met (no empty decoration).

**Ground contact**  
- Ultra-soft elliptical disc under feet: ink at **3–5% opacity**, scale locked to slot aspect. Studio still-life cue from `CairnArt` plates — not a grid floor.

**Risk artery / heart (E2 motif)**  
- Heart fill: terracotta deep at opacity driven by enhancer load (see §3).  
- Vessel: matte sage→terracotta gradient along length; **stroke width** bound to residual risk pressure.  
- Plaque discs: warn/gold discs whose **radius** binds to enhancer count + lever gap — same binding philosophy as the current SVG (but geometry endpoints become real PREVENT numbers once B6 projection lands).

**Journey arc (E3, optional)**  
- Arc path: ink-2 hairline; fill band sage wash under the traveled portion only.  
- Waypoint spheres: gold for future, sage for reached, terracotta for “now”.

---

## 2. Lighting (studio catalog, not stage)

Three lights only. No HDRI environment maps (payload + neon risk).

| Light | Type | Color | Intensity | Notes |
|-------|------|-------|-----------|-------|
| Key | Directional | `#fff8ef` warm white | 0.85 | 35° elevation, 25° azimuth from camera-left — catalog plate |
| Fill | Hemisphere | sky `#f4efe7` / ground `#d8cfbd` | 0.45 | Soft paper bounce; kills hard shadow sci-fi look |
| Rim | Directional | `#e7dfd2` | 0.22 | From camera-right rear — separates mesh from cream card |

- **No point lights** that pulse with HR / scores.  
- **No bloom, no SSAO post stack** in v1 (frame budget + mobile). Softness comes from material roughness + fill.  
- Shadow map optional, off by default on low-power; if on: single soft map, opacity ≤ 0.12.  
- Tone mapping: `ACESFilmic` or Linear + exposure ~1.0 — must still read warm cream, not teal/orange Instagram grade.

### Camera & framing

- Fixed orthographic-feel perspective: mild FOV (~28–32°), almost no perspective distortion so proportions read like the 2D croquis.  
- Framing matches `.bm-figure-slot` aspect **420∶645** (the shipped 2D measured figure’s box).  
- Idle: **no continuous orbit**. Optional 4° yaw ease on first promote only (respects reduced-motion → skip).  
- Drag orbit is **out of scope for E1** (keeps interaction identical to 2D: tap region → detail).

---

## 3. Data binding (every visual dimension → a real number)

### E1 — Living body morphs

**Geometry strategy (pragmatic elite, not full anatomical rig):**  
A hand-authored low-poly humanoid (~2–4k tris) with **named morph targets** (shape keys), not a full skeletal animation rig. “Rigged” in the plan sense means *regionally controllable mesh*, not Mixamo dancing.

> **As built (supersedes the glTF pack):** the mesh is a **runtime-sampled croquis
> loft** — at promote time the module rasterizes the same `CairnBodyFigure`
> silhouette paths the 2D draws (both sexes), scans the rows into elliptical
> cross-section rings, and lofts them into continuous clay surfaces (trunk, two
> legs, two arms; analytic normals). The 3D body IS the shipped croquis with
> depth: no binary asset, no drift when the 2D library evolves, and a compact
> baked male profile covers contexts where 2D sampling is unavailable. Girths
> bend the loft through smooth Gaussian influence bands anchored at the same
> callout points the 2D labels use; the focus wash is vertex color inside the
> mesh. **Composition:** the canvas renders BEHIND the 2D SVG in the same
> 420×645 plate space (orthographic camera mapped 1:1); promotion only fades
> the SVG silhouette fill — the editorial callouts and the dashed optimal-waist
> trace stay on top, still tappable. The sage ghost mesh renders only when a
> target EXCEEDS current girth (visible outside the body); the shrink case is
> told by the 2D dashed trace, never a shell hidden inside the mesh.
> `hidden_document` is a WAIT (promote on visibilitychange), not a skip.

| Morph / visual dim | Source field(s) | Mapping |
|--------------------|-----------------|---------|
| `waist_girth` | `sites.waist_in` / height | ratio vs sex baseline (existing scaffold math) |
| `chest_girth` | `sites.chest_in` | same |
| `hip_girth` | `sites.hip_in` | same |
| `shoulder_girth` | `sites.shoulder_in` | same |
| `upper_arm_girth` | `sites.upper_arm_in` | same |
| `thigh_girth` | `sites.thigh_in` | same |
| `trunk_depth` | body-fat % or visceral (when present) | shallow ↔ deeper midsection; clamp |
| `overall_mass` | weight vs height / lean mass | subtle uniform scale on limbs+torso, clamp ±12% |
| Focus emissive | `focus` / `selected` | region wash only |

**Then → now morph**  
- `from` = previous tape session sites (already in `body-metrics` via `mergePreviousSites` / `figureModel().prev`)  
- `to` = latest  
- Duration **~1200ms**, house ease `cubic-bezier(.22,1,.36,1)` (matches legacy 2D morph)  
- Under `prefers-reduced-motion`: snap to `to`, no interpolation  

**Optimal ghost**  
- Waist target: height-scaled optimal (waist ≤ ½ height) — already computed for 2D  
- Optional DEXA regional targets from `dexaTargeting` / standing when present  
- Ghost morph weights = target physique; living mesh = current  

**Tap → detail**  
Reuse existing bridge: `onSelect(site)` → `bmSelectedSite` → `bmRepaintStandHero` / `bmStandDetail`. 3D only hits the same site keys as 2D callouts.

**Extended model (additive on `CairnBody3DModel`):**

```ts
interface Body3DModel {
  // existing
  female?: boolean;
  unit?: "in" | "cm";
  heightIn?: number | null;
  selected?: string | null;
  focus?: string | null;
  sites?: Partial<Record<Body3DSiteKey, number | null>>;
  // E1 additions (all null-safe)
  prevSites?: Partial<Record<Body3DSiteKey, number | null>>;
  bodyFatPct?: number | null;
  leanMassLb?: number | null;
  visceral?: number | null;       // score or cm² — labeled by source
  dexa?: Record<string, number | null> | null;
  optimalSites?: Partial<Record<Body3DSiteKey, number | null>>;
}
```

Missing fields → morph weight 0.5 baseline (neutral mesh). Never invent measurements.

### E2 — Risk ribbon + vascular motif

**Honesty guard (non-negotiable, already in DESIGN.md):**  
Vascular age is **never** rendered without the enhancer block. The motif sits *with* enhancers, not as a standalone “young heart” trophy.

| Visual dim | Bind to | Notes |
|------------|---------|-------|
| Current path y(t) | `prevent.estimates.total_cvd` 10-yr & 30-yr | Real PREVENT fractions |
| Optimized path y(t) | **`prevent.projection`** (when landed): `current` vs `targets_met` 10/30-yr | Until B6 counterfactual lands, keep 2D ribbon; do **not** invent a second clinical score |
| Gap band | area between the two paths | Motivation = the gap, not a grade |
| Heart fill opacity | enhancer count / severity | Calm when empty |
| Vessel stroke width | residual pressure (enhancers + unmet levers) | Wider = calmer |
| Plaque radius | enhancer pressure | Same philosophy as current SVG |

**Until real PREVENT recompute for `targets_met` exists on the DTO:**  
- Keep the shipping SVG ribbon as the promote/degrade baseline.  
- Do not re-encode the current invented `optimizedLift` into WebGL.  
- When DTO gains e.g. `prevent.counterfactual: { total_cvd: { ten_year, thirty_year }, vascular_age }`, bind y-coords 1:1.

Current client invents optimized geometry via lever pressure (`health-risk-client.ts` `optimizedLift`). Track E2’s acceptance criterion is: **optimized path endpoints equal server counterfactual numbers**, with a footnote that the path is a PREVENT recompute under lever targets — not decoration.

### E3 — Journey arc (optional / post-primary)

| Dim | Source |
|-----|--------|
| Arc progress | weight/BF trajectory from `getTrajectory` / journey milestones |
| Waypoints | `milestones[]` (≤4) |
| “Now” marker | today position on arc |

Defer implementation until E1+E4 green; do not block Body/Age.

---

## 4. Runtime architecture (hard constraints)

### 4.1 Vendor Three.js like xterm

```
public/vendor/three.min.js   # trimmed build (WebGLRenderer + core + morph targets)
```

- Strict CSP: **no CDN**.  
- Precache in `sw.js` `OPTIONAL_ASSETS` (same pattern as xterm).  
- **Build, don't download:** official Three dropped the UMD `three.min.js` bundle (ESM-only since ~r160), and the client is IIFE/global-scope. Produce the trimmed vendor file ourselves — a pinned-version rollup/esbuild bundle (core + `WebGLRenderer` + morph-target support, no examples/controls) that self-executes and assigns `globalThis.THREE`. Pin the Three version + document the rebuild command next to the vendor file (mirror how xterm is vendored).  
- Expose `globalThis.THREE` only after lazy load.

### 4.2 Lazy load — never blocking bundles

**Today’s bug:** `body-3d-client.js` is concatenated into `bundle-03-capture-progress.js` (blocking parse for Progress/Stand siblings even when Body isn’t open).

**Target:**

1. Remove `body-3d-client.js` from all `BUNDLES` inputs.  
2. `body-metrics-client` (and risk, later) call a loader:

```ts
// pseudocode
async function loadBody3D(): Promise<typeof CairnBody3D | null> {
  if (!canEnhance()) return null;
  await loadScriptOnce("/vendor/three.min.js");
  await loadScriptOnce("/js/body-3d-client.js"); // built, not bundled
  return window.CairnBody3D ?? null;
}
```

3. First paint of Stand/Body remains pure 2D SVG in the slot.  
4. Enhancement runs only when: slot visible, document visible, gate ok, scripts loaded, first nonblank frame proven (`readPixels` alpha > 0 — keep scaffold contract).  
5. Engineering contracts tests updated: assert **absence** from every bundle; assert presence in `OPTIONAL_ASSETS` / dynamic loader.

### 4.3 Capability gate (`canEnhance`) — extend, don’t replace

| Check | Reason code | Behavior |
|-------|-------------|----------|
| `prefers-reduced-motion: reduce` | `reduced_motion` | 2D only |
| `document.visibilityState === "hidden"` | `hidden_document` | wait / skip |
| no canvas | `no_canvas` | 2D |
| no WebGL / context fail | `no_webgl` | 2D |
| `navigator.deviceMemory` ≤ 2 (when present) | `low_memory` | 2D |
| `navigator.connection.saveData` | `save_data` | 2D |
| offscreen (IO) | `offscreen` | wait until intersect |
| first frame blank / throw | `render_failed` | tear down canvas, 2D |
| fail to load vendor | `vendor_failed` | 2D |

**Low-power:** request context with `powerPreference: "low-power"` (already). Cap DPR at `min(devicePixelRatio, 1.5)` (scaffold uses 2 — tighten). Pause `requestAnimationFrame` when `visibilityState === hidden` or IntersectionObserver says <10% visible.

### 4.4 Zero layout shift

- Slot always reserves aspect-ratio **420/645**, max-width 440px (scaffold CSS).  
- 2D fallback and 3D canvas are **siblings**: canvas `position:absolute; inset:0` over fallback; fallback stays in flow for height.  
- On promote: hide fallback with `hidden` (or `visibility`/`aria-hidden`), canvas `display:block` — slot box unchanged.  
- On destroy/fallback: reverse.  
- Reviewer proof: screenshot/no-WebGL path has identical slot bounding box to WebGL path.

### 4.5 Client-only / Pi untouched

No new server endpoints for rendering. Consume existing `/api/body-metrics`, risk DTO, trajectory. Frame budget target: **≤1 rAF work after promote** (static mesh + rare morph animation); no continuous simulation loop when idle — render on demand (resize, select, morph tick).

---

## 5. Surface placement

| Surface | Route | Viz | First paint |
|---------|-------|-----|-------------|
| Stand → Body | existing body metrics | E1 living body + ghost | `CairnBodyFigure` SVG |
| Stand → Age risk card | existing `#hRisk` | E2 ribbon + motif | current SVG ribbon (keep) |
| Progress journey | optional | E3 arc | existing journey list UI |

No new primary nav. No Today tab imports.

---

## 6. What “elite” is *not* (reject list)

- Neon cyan/magenta wires, holographic grids, particle blood cells  
- 0–100 “physique score” rings or letter grades  
- Continuous idle spin / breathing that fights reduced-motion  
- Photoreal skin shaders, subcutaneous fat flythrough  
- Loading a multi‑MB GLB of a celebrity body  
- Any CDN (`unpkg`, `jsdelivr`, Google fonts for 3D)  
- Auto-playing then→now every re-render (once per visit / data change only)

---

## 7. Implementation sequencing (after this review)

| Step | Deliverable | Depends |
|------|-------------|---------|
| **E5** (this doc) | Materials/lighting study — **you are here** | — |
| **E4a** | Lazy-load plumbing + remove body-3d from bundles + SW optional entry + contract tests | E5 approve |
| **E1a** | Vendor trimmed Three; port scaffold to Three scene with same ellipse-or-simple mesh + gate | E4a |
| **E1b** | Authored low-poly + morph targets + data binding + then→now + ghost | E1a |
| **E1c** | Region pick → existing detail bridge; pause/offscreen; DPR/battery guards | E1b |
| **E2a** | Bind risk SVG (or light Three motif) to real counterfactual when DTO ready; honesty guard tests | B6 projection |
| **E3** | Optional arc | E1 stable + trajectory data |
| **Verify** | `npm test`, engineering contracts, no-WebGL layout parity, Stand first paint unaffected | all |

---

## 8. Acceptance checklist (reviewer)

- [ ] Scene reads warm cream / terracotta / sage under soft studio light — no neon  
- [ ] Every morph / path / plaque radius cites a real DTO field  
- [ ] 2D first paint unchanged; no-WebGL client identical slot geometry  
- [ ] Three.js only from `/vendor/`, precached optional, lazy on Body/Age only  
- [ ] Not present in Today bundle or any blocking bundle  
- [ ] Reduced-motion, hidden tab, low-power → no WebGL promote  
- [ ] Vascular age still paired with enhancers  
- [ ] Optimized risk path uses server counterfactual when available — no invented clinical %  
- [ ] Pi / server unchanged  

---

## 9. Design-review decisions (resolved 2026-07-08)

1. **Mesh source — DECIDED: staged E1a → E1b.** Start E1a with the Three port of the ellipse-pack / capsule body (proves lighting/materials/gate/lazy-load on cheap geometry, keeps continuity with the scaffold), then swap in the hand-authored low-poly morph glTF (~50–150 KB) in E1b with no API change.  
2. **E2 depth — DECIDED: refined SVG until `targets_met` lands.** The current `optimizedLift` is invented geometry; do not WebGL-encode it. Promote to a Three motif afterward only if it adds clarity over the bound SVG. Quiet elite may mean *better 2D*, not forced 3D.  
3. **Ghost opacity — DECIDED: 0.22 default**, tuned against real tape + DEXA fixtures before freeze (0.18–0.28 band stands).

---

*Approved 2026-07-08. Build proceeds in §7 order: E4a → E1a → E1b → E1c → E2a (blocked on B6 projection) → E3 (optional).*

---

## Epilogue (2026-07-08): 3D retired, elite 2D chosen

The full pipeline was built and evaluated live, twice: (1) an E1a croquis-loft
(runtime-sampling the 2D silhouette into revolved cross-sections) — continuous
and data-bound, but a human body is not a surface of revolution; the head/
shoulders never escaped "mannequin-alien". (2) An E1b bake pipeline from the
CC0 MakeHuman basemesh (hm08 + macrodetail gender targets, re-posed via the
OBJ's joint-cube skeleton, landmark-mapped into the 420×645 plate). Anatomy
was excellent, but hanging an A-pose arm without production skinning weights
kept tearing the shoulder/armpit web, and finishing it properly (MakeHuman's
CC0 `default.mhskel` + `default_weights.mhw` linear-blend skinning) plus a
~100 KB gz vendored Three.js was judged not worth the payload or the upkeep
for a figure the 2D already tells better.

**Decision: quiet elite means better 2D.** All Three.js/WebGL body code was
removed (including the pre-Track-E scaffold that shipped in bundle-03); the
effort moved to elevating the 2D figures (Stand→Body fitting sheet and the
Train muscle-balance figure) — sculpted-plate shading, richer selection
language, zero new dependencies. If 3D is ever revisited, the proven-viable
path is documented above: MakeHuman CC0 base + real skinning weights, baked
offline into compact plate-space meshes (the bake script lived at
`scripts/build-body-mesh.mjs` on this branch's history).
