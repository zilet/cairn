// cairn-body-figure.ts — the elite body figure for Cairn (Train muscle balance
// + Stand tape figure). Compiled to /cairn-body-figure.js (loaded as a classic
// script BEFORE the bundles, like /art.js, and precached in sw.js).
//
// Geometry follows the classical 8-head canon (Loomis) blended with real
// anthropometry — see the skeleton block. The Stand figure can additionally
// bend toward the athlete's OWN tape via `silhouette(sex, ratios)`: per-site
// Gaussian bands scale the plate x by measured/baseline ratios (clamped
// tight), so a 33in waist on a 40in hip silhouette reads as that body — the
// figure is honest to the numbers, never a caricature.
//
// Convention preserved: SVG paint attrs use illustration hexes, not CSS var()
// (see docs/DESIGN.md).

type CbfPt = [number, number];
type CbfSiteRatios = Record<string, number>;
type CbfWarpKind = "torso" | "arm";

(() => {
  // ---------- geometry helpers ----------
  const R10 = (n: number): number => Math.round(n * 10) / 10;

  // Catmull-Rom -> cubic Bézier through a CLOSED loop of points.
  function loopD(pts: CbfPt[]): string {
    const n = pts.length;
    let d = `M${R10(pts[0][0])} ${R10(pts[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      d += ` C${R10(p1[0] + (p2[0] - p0[0]) / 6)} ${R10(p1[1] + (p2[1] - p0[1]) / 6)} ${R10(p2[0] - (p3[0] - p1[0]) / 6)} ${R10(p2[1] - (p3[1] - p1[1]) / 6)} ${R10(p2[0])} ${R10(p2[1])}`;
    }
    return `${d} Z`;
  }
  // Same smoothing, open-ended (detail strokes, chalk traces).
  function openD(pts: CbfPt[]): string {
    const n = pts.length;
    const at = (i: number): CbfPt => pts[Math.min(n - 1, Math.max(0, i))];
    let d = `M${R10(pts[0][0])} ${R10(pts[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const p0 = at(i - 1);
      const p1 = at(i);
      const p2 = at(i + 1);
      const p3 = at(i + 2);
      d += ` C${R10(p1[0] + (p2[0] - p0[0]) / 6)} ${R10(p1[1] + (p2[1] - p0[1]) / 6)} ${R10(p2[0] - (p3[0] - p1[0]) / 6)} ${R10(p2[1] - (p3[1] - p1[1]) / 6)} ${R10(p2[0])} ${R10(p2[1])}`;
    }
    return d;
  }
  const mirrorPts = (pts: CbfPt[]): CbfPt[] => pts.map(([x, y]): CbfPt => [260 - x, y]).reverse();

  // Female warp: piecewise x-scale toward/away from the centerline by body zone.
  // Anchors are [y, scale]; one drawing serves both sexes. Ratios follow real
  // anthropometry (female vs male at the same stature): shoulders ~0.93,
  // defined waist ~0.89, hips genuinely wider ~1.08, legs near parity.
  const K_ANCHORS: CbfPt[] = [[0, 0.97], [93, 0.93], [125, 0.88], [170, 0.92], [235, 0.87], [290, 1.06], [318, 1.16], [365, 1.1], [470, 1.02], [640, 0.98]];
  function kOf(y: number): number {
    for (let i = 0; i < K_ANCHORS.length - 1; i++) {
      const [y0, k0] = K_ANCHORS[i];
      const [y1, k1] = K_ANCHORS[i + 1];
      if (y >= y0 && y <= y1) return k0 + (k1 - k0) * ((y - y0) / (y1 - y0));
    }
    return 0.93;
  }
  const warp = (pts: CbfPt[], sex: string): CbfPt[] =>
    sex === "female" ? pts.map(([x, y]): CbfPt => [130 + (x - 130) * kOf(y), y]) : pts;
  function shrink(pts: CbfPt[], f: number): CbfPt[] {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    return pts.map(([x, y]): CbfPt => [cx + (x - cx) * f, cy + (y - cy) * f]);
  }

  // ---------- measured-body warp (Stand): the figure bends toward the tape ----
  // Per-site Gaussian bands scale plate x by the athlete's measured/baseline
  // ratio. Clamped tight — the silhouette leans toward the truth, it never
  // caricatures. Bands are in MALE plate y (the sex warp composes first).
  const RATIO_BANDS: Record<CbfWarpKind, Array<{ site: string; y: number; sigma: number }>> = {
    torso: [
      { site: "neck", y: 94, sigma: 12 },
      { site: "shoulder", y: 122, sigma: 20 },
      { site: "chest", y: 168, sigma: 30 },
      { site: "waist", y: 236, sigma: 34 },
      { site: "hip", y: 306, sigma: 30 },
      { site: "thigh", y: 378, sigma: 52 },
      { site: "calf", y: 508, sigma: 42 },
    ],
    arm: [
      { site: "shoulder", y: 132, sigma: 22 },
      { site: "arm", y: 192, sigma: 42 },
      { site: "forearm", y: 292, sigma: 38 },
    ],
  };
  const RATIO_MIN = 0.88;
  const RATIO_MAX = 1.14;
  const clampRatio = (r: number): number => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));

  function ratioScaleAt(y: number, ratios: CbfSiteRatios | undefined, kind: CbfWarpKind): number {
    if (!ratios) return 1;
    let f = 1;
    for (const band of RATIO_BANDS[kind]) {
      const r = ratios[band.site];
      if (r == null || !Number.isFinite(r) || r === 1) continue;
      const d = (y - band.y) / band.sigma;
      f += Math.exp(-0.5 * d * d) * (clampRatio(r) - 1);
    }
    return f;
  }
  const bodyWarp = (pts: CbfPt[], ratios: CbfSiteRatios | undefined, kind: CbfWarpKind): CbfPt[] =>
    ratios ? pts.map(([x, y]): CbfPt => [130 + (x - 130) * ratioScaleAt(y, ratios, kind), y]) : pts;

  // ---------- skeleton (viewBox 0 0 260 640, centerline x=130) ----------
  // Proportions follow the classical 8-head canon (Loomis) blended with real
  // anthropometry: crown 16 -> soles 628 (one head unit ~ 76.5), chin at 1 head
  // (93), acromion ~1.35 (120), nipple line 2 (170), natural waist + elbow
  // ~2.85 (235), hip crest widest just above crotch, crotch + wrist at the
  // EXACT mid-figure 4 heads (324), fingertips 4.7 (377), bottom of knee 6
  // (478), calf 6.4 (507), ankle 7.55 (596). Widths as stature fractions:
  // shoulders .27, chest .19, waist .137, hips .17 — a human, not a wasp.
  // The jaw CLOSES the head decisively by ~y79 (a croquis head is an oval, not
  // a balloon on a string); the chin point itself lives on the centerline.
  // The head uses the Loomis ball-and-jaw CONSTRUCTION, not eyeballed points:
  // the cranium is a circle (center [130,44], R 28 — widest at ear level, round
  // above AND below), the jaw is a straight taper from the ball's lower arc
  // that lands EXACTLY on the neck line (the chin lives on the centerline and
  // never shows on the side silhouette) — so head->neck is one tangent flow
  // with no junction to wobble.
  const HEAD_TOP: CbfPt = [130, 16];
  const RIGHT_TORSO: CbfPt[] = [
    [144, 19.8], [152.9, 27.9], [157.6, 39.1], [157.6, 48.9], [154.2, 58], [150.5, 63.1], // cranium ball (circle samples)
    [144, 70], [142.5, 78],                                             // CONCAVE cut under the ear — the jaw shadow
    [143, 86], [144, 94], [145, 100],                                   // slim SHORT neck (~0.5 head width)
    [158, 105], [176, 114], [190, 124],                                 // trap rises high — less bare neck
    [188, 150], [188, 172], [185, 195], [180, 215],                    // armpit, chest widest, rib taper
    [172, 235], [173, 248], [176, 268], [180, 288],                    // natural waist -> iliac crest
    [182, 308], [182, 320], [180, 334],                                // hip crest IS the widest
    [178, 352], [175, 375], [172, 400], [170, 428], [169, 450],        // thigh — dense, smooth taper
    [168, 464], [167, 476],                                            // knee, NOT a wasp joint
    [169, 490], [173, 503], [172, 518], [168, 536],                    // gastrocnemius sweep — dense
    [164, 558], [162, 580], [162, 594],                                // shin -> ankle
    [166, 610], [170, 624], [143, 627], [141, 600],                    // foot
    [139, 588], [136, 566], [133, 540], [131, 518], [132, 502], [134, 490], // inner shin — dense
    [135, 478], [134, 466],                                            // inner knee
    [134, 445], [133, 420], [132, 395], [131, 370], [131, 348],        // inner thigh — dense
  ];
  const CROTCH: CbfPt = [130, 324];
  const ARM_R: CbfPt[] = [
    [184, 124], [199, 123], [209, 133], [212, 148],                    // deltoid cap tucked under the trap line
    [209, 175], [207, 208], [204, 236],                                // taper to the elbow AT the waist line
    [208, 262], [207, 292], [204, 318], [200, 330],                    // carrying angle: forearm angles gently out
    [202, 344], [200, 362], [193, 377], [186, 360],                    // hand, fingertips at 4.7 heads
    [186, 336], [184, 306], [181, 276], [178, 250],                    // inner forearm
    [177, 222], [178, 194], [178, 170], [176, 152],                    // inner arm -> armpit
  ];

  // ---------- muscles (right-side loops; mirror:true adds the left copy) ----------
  type CbfMuscleDef = { g: string; mirror: boolean; pts: CbfPt[] };
  const MUSCLES_FRONT: CbfMuscleDef[] = [
    { g: "neck", mirror: true, pts: [[132.4, 97.7], [136.8, 98.9], [136, 107.3], [132.9, 110], [131.9, 102.5]] },
    { g: "shoulders", mirror: true, pts: [[136.6, 108.7], [142.6, 112.7], [167.2, 118], [168, 122.9], [149.1, 119.3], [136, 114]] },
    { g: "shoulders", mirror: true, pts: [[166.4, 118], [190, 121], [200.2, 132.7], [202.4, 148.4], [197.8, 162.2], [185.8, 164.1], [173.2, 144.5], [169.1, 126.9]] },
    { g: "chest", mirror: true, pts: [[133, 136.7], [152.1, 133.7], [168.1, 137.6], [180.3, 149.4], [181.7, 164.1], [172.4, 175.1], [153.5, 180.3], [137.5, 182], [132.1, 162.2]] },
    { g: "biceps", mirror: true, pts: [[183.1, 171.7], [198.7, 170], [205.3, 192.2], [201.6, 219.6], [191.9, 224.7], [184.3, 200.8]] },
    { g: "forearms", mirror: true, pts: [[182.9, 237.2], [199.3, 236.1], [206.1, 253.5], [206.8, 286], [200.2, 312.1], [193.6, 314.2], [186.1, 287.1], [182.9, 254.5]] },
    { g: "core", mirror: true, pts: [[158.1, 197.4], [171.8, 204.2], [171.4, 231.6], [158, 261], [153, 228.2], [153.2, 204.2]] },
    { g: "core", mirror: false, pts: [[116, 188.8], [144, 188.8], [152.5, 221.3], [147.6, 265.4], [130, 291.4], [112.4, 265.4], [107.5, 221.3]] },
    { g: "quads", mirror: true, pts: [[165.2, 340.5], [176.9, 349.9], [175.8, 389.9], [171.4, 434.7], [165.2, 460.6], [155.4, 415.8], [157.9, 368.7]] },
    { g: "quads", mirror: true, pts: [[146.5, 335.8], [163, 338.1], [162.5, 387.6], [159, 432.3], [150.9, 455.9], [139.5, 413.5], [141, 366.4]] },
    { g: "quads", mirror: true, pts: [[136.7, 425.3], [146.1, 439.4], [148.9, 462.9], [139.7, 470], [133.3, 451.2], [132.4, 434.7]] },
    { g: "calves", mirror: true, pts: [[146.8, 479.7], [154.3, 482.9], [161.2, 511.1], [156.9, 546.3], [149, 560.8], [144.4, 521.5], [142.3, 494.1]] },
    { g: "calves", mirror: true, pts: [[136.3, 489.3], [143.5, 507], [139.6, 531.8], [133.4, 515.3], [132.6, 497.3]] },
  ];
  const MUSCLES_BACK: CbfMuscleDef[] = [
    { g: "back", mirror: false, pts: [[130, 103.6], [136.5, 107.3], [146.4, 114], [174, 121], [156, 128.8], [142.2, 156.3], [133.2, 182], [130, 192.2], [126.8, 182], [117.8, 156.3], [104, 128.8], [86, 121], [113.6, 114], [123.5, 107.3]] },
    { g: "rear delts", mirror: true, pts: [[166.4, 118], [190, 121], [200.2, 132.7], [202.4, 148.4], [197.8, 162.2], [185.8, 164.1], [173.2, 144.5], [169.1, 126.9]] },
    { g: "back", mirror: true, pts: [[148.1, 136.7], [166.1, 134.7], [176.2, 146.5], [171.1, 162.2], [154.8, 164.1], [146.1, 150.4]] },
    { g: "back", mirror: true, pts: [[140.3, 164.1], [173.8, 168], [185.2, 176.8], [178.8, 204.2], [161.1, 231.6], [145.6, 243.7], [137.2, 209.3], [136.4, 182]] },
    { g: "back", mirror: true, pts: [[131.1, 200.8], [142.6, 200.8], [146.8, 248], [138.4, 293.6], [131.2, 293.6], [128.7, 248]] },
    { g: "triceps", mirror: true, pts: [[183, 170], [198.7, 168], [206.5, 193.9], [202.5, 221.3], [191.9, 226.4], [189.7, 200.8], [182.5, 182]] },
    { g: "forearms", mirror: true, pts: [[182.9, 237.2], [199.3, 236.1], [206.1, 253.5], [206.8, 286], [200.2, 312.1], [193.6, 314.2], [186.1, 287.1], [182.9, 254.5]] },
    { g: "glutes", mirror: true, pts: [[131.2, 291.4], [154.5, 284.9], [169.4, 295.8], [170.2, 315.3], [160.7, 333.4], [139.4, 338.1], [128.8, 321.8], [126.4, 306.6]] },
    { g: "hamstrings", mirror: true, pts: [[158.8, 349.9], [175.5, 357], [173.6, 406.4], [169.2, 453.5], [162, 465.3], [151.8, 415.8], [152.6, 373.5]] },
    { g: "hamstrings", mirror: true, pts: [[138.5, 347.5], [153.9, 352.3], [151.6, 413.5], [148.5, 458.2], [138.1, 448.8], [131.1, 399.4], [133.6, 368.7]] },
    { g: "calves", mirror: true, pts: [[153.7, 478], [166, 484], [171.5, 507], [167, 540], [159, 553], [152, 515.3], [149.1, 490.9]] },
    { g: "calves", mirror: true, pts: [[137.6, 481.3], [148.2, 486.1], [151.6, 517.3], [144.2, 548.4], [133.2, 536], [131.3, 505.4], [131.7, 490.9]] },
  ];
  // Interior hairlines (sternum, linea alba, ab rows, spine).
  const STROKES_FRONT: CbfPt[][] = [
    [[130, 140.6], [130, 178.6]],
    [[130, 192.2], [130, 269.7]],
    [[115.9, 205.9], [130, 209.3], [144.1, 205.9]],
    [[114.8, 224.7], [130, 228.2], [145.2, 224.7]],
    [[115.8, 245.9], [130, 250.2], [144.2, 245.9]],
  ];
  const STROKES_BACK: CbfPt[][] = [[[130, 124.9], [130, 287.1]]];

  // ---------- Atelier illustration palette ----------
  const COLORS: Record<string, string> = {
    silhouetteFill: "#ede4d1", silhouetteLine: "#c9bda0",
    standFill: "#ece2ce", standLine: "#c4b89d",
    baseInk: "#3f382c", baseStroke: "#a99c82", detailStroke: "#a08f72",
  };
  // Train tones (matches TOV_TONE_FILL semantics).
  const TONES: Record<string, { fill: string; op: number }> = {
    due: { fill: "#b4552d", op: 0.42 },
    ok: { fill: "#6e7f5c", op: 0.38 },
    high: { fill: "#c9a86a", op: 0.55 },
    recover: { fill: "#57503f", op: 0.16 },
  };

  // ---------- Stand: measurement sites ----------
  // Callout anchors on the MALE figure (x warps per sex/ratios via warpPoint).
  type CbfCallout = { side: "L" | "R"; y: number; pt: CbfPt; site: string; label: string };
  const CALLOUTS: CbfCallout[] = [
    { side: "L", y: 104, pt: [116, 95], site: "neck", label: "NECK" },
    { side: "L", y: 134, pt: [53, 140], site: "shoulder", label: "SHOULDER" },
    { side: "L", y: 192, pt: [54, 192], site: "arm", label: "ARM" },
    { side: "L", y: 288, pt: [55, 288], site: "forearm", label: "FOREARM" },
    { side: "R", y: 166, pt: [185, 168], site: "chest", label: "CHEST" },
    { side: "R", y: 238, pt: [169, 236], site: "waist", label: "WAIST" },
    { side: "R", y: 294, pt: [177, 292], site: "hip", label: "HIP" },
    { side: "R", y: 374, pt: [174, 372], site: "thigh", label: "THIGH" },
    { side: "R", y: 500, pt: [172, 500], site: "calf", label: "CALF" },
  ];
  // Sites whose anchors/washes ride the ARM paths (vs the torso).
  const ARM_SITES = new Set(["shoulder", "arm", "forearm"]);
  // Per-site glow washes [cx, cy, rx, ry, clip] — clip: 't' torso, 'aR'/'aL' arms.
  type CbfGlow = [number, number, number, number, string];
  const GLOWS: Record<string, CbfGlow[]> = {
    neck: [[130, 96, 22, 14, "t"]],
    shoulder: [[198, 136, 26, 24, "aR"], [62, 136, 26, 24, "aL"], [130, 122, 56, 18, "t"]],
    chest: [[130, 168, 60, 28, "t"]],
    waist: [[130, 236, 48, 30, "t"]],
    hip: [[130, 306, 56, 28, "t"]],
    arm: [[193, 192, 17, 38, "aR"], [67, 192, 17, 38, "aL"]],
    forearm: [[194, 290, 14, 42, "aR"], [66, 290, 14, 42, "aL"]],
    thigh: [[156, 392, 26, 56, "t"], [104, 392, 26, 56, "t"]],
    calf: [[155, 510, 22, 46, "t"], [105, 510, 22, 46, "t"]],
  };

  // ---------- API ----------
  // Silhouette paths for a sex — optionally bent toward the athlete's own tape
  // via `ratios` (lib site name -> measured/baseline, clamped internally).
  function silhouette(sex: string, ratios?: CbfSiteRatios): { torso: string; armR: string; armL: string } {
    const t = (pts: CbfPt[]) => bodyWarp(warp(pts, sex), ratios, "torso");
    const a = (pts: CbfPt[]) => bodyWarp(warp(pts, sex), ratios, "arm");
    return {
      torso: loopD(t([HEAD_TOP, ...RIGHT_TORSO, CROTCH, ...mirrorPts(RIGHT_TORSO)])),
      armR: loopD(a(ARM_R)),
      armL: loopD(a(mirrorPts(ARM_R))),
    };
  }
  // Muscle paths: [{ group, d }] for 'front' | 'back'.
  function muscles(sex: string, side: string): Array<{ group: string; d: string }> {
    const defs = side === "back" ? MUSCLES_BACK : MUSCLES_FRONT;
    const out: Array<{ group: string; d: string }> = [];
    for (const def of defs) {
      const prep = (pts: CbfPt[]): string => {
        let p = warp(pts, sex);
        if (sex === "female") p = shrink(p, def.g === "chest" ? 0.82 : 0.93);
        return loopD(p);
      };
      out.push({ group: def.g, d: prep(def.pts) });
      if (def.mirror) out.push({ group: def.g, d: prep(mirrorPts(def.pts)) });
    }
    return out;
  }
  // Interior detail hairlines: [d strings].
  function detailStrokes(sex: string, side: string): string[] {
    return (side === "back" ? STROKES_BACK : STROKES_FRONT).map((pts) => openD(warp(pts, sex)));
  }
  // Warp a single [x, y] male-figure point for a sex (+ optional tape ratios).
  // kind: 'torso' (default) or 'arm' for points riding the arm paths.
  function warpPoint(pt: CbfPt, sex: string, ratios?: CbfSiteRatios, kind: CbfWarpKind = "torso"): CbfPt {
    return bodyWarp(warp([pt], sex), ratios, kind)[0];
  }
  // Dashed reference-waist chalk trace (right/left) — the OPTIMAL band, so it
  // warps by sex only, never by the athlete's current tape.
  function waistTrace(sex: string, sign: 1 | -1): string {
    const optHalf = 36 * (sex === "female" ? kOf(235) : 1);
    return openD([
      [130 + sign * (optHalf + 8), 208], [130 + sign * (optHalf + 2), 222], [130 + sign * optHalf, 235],
      [130 + sign * (optHalf + 2), 250], [130 + sign * (optHalf + 6), 264],
    ]);
  }

  // Full figure as an SVG string — drop-in successor to tovFigureSvg(side, tones).
  // tones: { chest: 'due', back: 'ok', ... } (group -> tone key). opts:
  //   { sex = 'male', className = 'tov-fig', anatomyInk = 0.14, pulseDue = false, stand = false }
  // pulseDue adds class "cbf-pulse" to due overlays — animate it from the stylesheet.
  type CbfFigureOpts = {
    sex?: string;
    className?: string;
    anatomyInk?: number;
    pulseDue?: boolean;
    stand?: boolean;
    dataAttrs?: boolean;
  };
  function figureSvg(side: string, tones: Record<string, string> | null | undefined, opts?: CbfFigureOpts): string {
    const o = opts || {};
    const sex = o.sex || "male";
    const ink = o.anatomyInk != null ? o.anatomyInk : 0.14;
    const fill = o.stand ? COLORS.standFill : COLORS.silhouetteFill;
    const line = o.stand ? COLORS.standLine : COLORS.silhouetteLine;
    const sil = silhouette(sex);
    const body =
      `<path d="${sil.armL}" fill="${fill}" stroke="${line}" stroke-width="1.15"/>` +
      `<path d="${sil.armR}" fill="${fill}" stroke="${line}" stroke-width="1.15"/>` +
      `<path d="${sil.torso}" fill="${fill}" stroke="${line}" stroke-width="1.15"/>`;
    let base = "";
    let over = "";
    let pulse = "";
    if (!o.stand) {
      for (const m of muscles(sex, side)) {
        base += `<path d="${m.d}" fill="${COLORS.baseInk}" fill-opacity="${ink}" stroke="${COLORS.baseStroke}" stroke-width="0.8" stroke-opacity="0.55"/>`;
        const tone = TONES[(tones || {})[m.group] || ""];
        if (tone) over += `<path d="${m.d}" fill="${tone.fill}" fill-opacity="${tone.op}"${o.dataAttrs ? ` data-group="${m.group}"` : ""}/>`;
        if (o.pulseDue && (tones || {})[m.group] === "due") pulse += `<path class="cbf-pulse" d="${m.d}" fill="#b4552d" pointer-events="none"/>`;
      }
      for (const d of detailStrokes(sex, side)) {
        base += `<path d="${d}" fill="none" stroke="${COLORS.detailStroke}" stroke-width="0.8" opacity="0.5"/>`;
      }
    }
    const cls = o.className || "tov-fig";
    return `<svg class="${cls}" viewBox="0 0 260 640" aria-hidden="true">${body}${base}${over}${pulse}</svg>`;
  }

  const api = {
    VIEWBOX: "0 0 260 640", CENTER_X: 130,
    COLORS, TONES, CALLOUTS, GLOWS, ARM_SITES,
    MUSCLES_FRONT, MUSCLES_BACK, STROKES_FRONT, STROKES_BACK,
    loopD, openD, mirrorPts, warp, warpPoint, kOf, shrink,
    silhouette, muscles, detailStrokes, waistTrace, figureSvg,
  };
  Object.assign(globalThis, { CairnBodyFigure: api });
  if (typeof window !== "undefined") {
    (window as unknown as { CairnBodyFigure: typeof api }).CairnBodyFigure = api;
  }
})();
