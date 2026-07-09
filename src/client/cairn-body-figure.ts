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

  // Female warp: piecewise x-scale of the MALE base by body zone — female = a
  // TAPER, not a shrink (spec §3/§4 r15). Anchors [y, scale] are the F/M
  // same-stature width ratios pinned at the true landmark heights: head 1.03,
  // neck ~0.97, shoulders 0.95, chest ~1.00, waist 0.99 (near-identical — NOT a
  // narrowed ribcage), fleshy hip 1.10 (the one big divergence), ankle 0.97.
  // The female story is the gentler shoulder:hip taper (M 1.47 -> F 1.27) and a
  // straighter torso, carried here almost entirely by the hip, not the chest.
  const K_ANCHORS: CbfPt[] = [
    [0, 1.02], [44, 1.03],   // crown / temple — head breadth F/M 1.032 (§3)
    [92, 0.98], [106, 0.97], // jaw / neck — F/M ~0.97
    [122, 0.95], [140, 0.95],// acromion / deltoid — bideltoid F/M 0.952 (§3)
    [169, 1.00],             // chest — F/M 1.004 (§3), essentially equal
    [238, 0.99],             // natural waist — F/M 0.991 (§3), essentially equal
    [300, 1.06], [314, 1.10],// upper hip -> greater trochanter — fleshy hip F/M 1.104 (§3)
    [340, 1.07], [420, 1.02],// upper thigh (fuller) -> mid thigh
    [466, 1.00], [505, 1.00],// knee / calf — near parity
    [596, 0.97], [640, 0.97],// ankle — bimalleolar F/M 0.967 (§3)
  ];
  function kOf(y: number): number {
    for (let i = 0; i < K_ANCHORS.length - 1; i++) {
      const [y0, k0] = K_ANCHORS[i];
      const [y1, k1] = K_ANCHORS[i + 1];
      if (y >= y0 && y <= y1) return k0 + (k1 - k0) * ((y - y0) / (y1 - y0));
    }
    return 0.97;
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
      { site: "neck", y: 102, sigma: 12 },
      { site: "shoulder", y: 122, sigma: 20 },
      { site: "chest", y: 169, sigma: 30 },
      { site: "waist", y: 238, sigma: 34 },
      { site: "hip", y: 314, sigma: 30 },
      { site: "thigh", y: 380, sigma: 52 },
      { site: "calf", y: 505, sigma: 42 },
    ],
    arm: [
      { site: "shoulder", y: 138, sigma: 22 },
      { site: "arm", y: 200, sigma: 42 },
      // The forearm ratio tiles TWO bands (forearm + hand-follow) whose Gaussian
      // sum stays ~flat (≈1) from the forearm through the fingertips — one wide
      // band left the hand outside the warp, so a slimmer-than-baseline arm
      // pulled the elbow in while the wrist stayed put and the hand kicked
      // visibly outward (penguin wing). The hand band sits low + wide enough that
      // even the fingertips (y≈385) translate WITH the forearm, both directions.
      { site: "forearm", y: 292, sigma: 28 },
      { site: "forearm", y: 365, sigma: 36 },
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
  // Loomis 8-head canon blended with ANSUR II + the app's fit reference (see
  // proportion-spec.md). Vertical landmarks (hu = head units, y = 16 + hu*76.5):
  //   chin hu 1.0 (y92.5) · acromion hu 1.39 (y122, Loomis 1.33-1.5) · deltoid
  //   widest hu 1.62 (y140) · nipple hu 2.0 (y169) · natural waist hu 2.90
  //   (y238) · elbow hu 2.97 (y243, at navel) · iliac crest hu 3.16 (y258) ·
  //   greater trochanter = WIDEST hip hu 3.90 (y314, spec §4 r1) · crotch+wrist
  //   hu 4.08 (y328 — biased toward the real 0.51-of-stature crotch, not the
  //   Loomis exact half, spec §4 r6; wrist ON the crotch line, the most
  //   validated rule) · fingertips hu 4.82 (y385, wrist + ¾-head hand) · knee
  //   hu 5.88 (y466, between mid-patella 458 & Loomis 475) · outer calf peak
  //   hu 6.39 (y505, ⅓ down the lower leg) · ankle hu 7.58 (y596) · soles hu 8.
  // Half-widths (px from x=130): head 27 (spec §2 .088) · neck ~13 (§2 upper-
  // bound narrowed, §4 r10) · acromion trap ~71 (§2 biacromial .237) / deltoid
  // 85 (§2 bideltoid .29) · chest 60 (fit-ref 39in girth /2.71) · waist 52
  // (fit-ref 33in — visibly < chest) · trochanter hip 61 (fit-ref 37.5in ≈ §2
  // hipbreadth) · ankle ~10 (§2 bimalleolar .043).
  // Head = Loomis ball-and-jaw: cranium WIDEST at ear level (~y58), rounding UP
  // to the crown AND tapering DOWN to a soft flat chin — an oval head, not a
  // ball on a stem. The neck is SHORT (bare neck < 0.3 head; traps rise by
  // ~y113). LEGS: the closed torso loop winds down the outer right leg, around
  // a SEPARATE right foot, up the INNER right leg to a pinned crotch V at
  // [130,328] — the inner edges stay RIGHT of centerline so there is real
  // daylight between the legs, widening from ~6px (upper thigh) to ~24px (ankle)
  // (director/lead). SHOULDER reads: neck -> trap slope -> CORNER at the
  // acromion -> deltoid ball -> arm.
  const HEAD_TOP: CbfPt = [130, 16];
  const RIGHT_TORSO: CbfPt[] = [
    // head — cranium WIDEST at ear/cheek level (half 27.5, y56-64), rounding up
    // to the crown; the lower third VISIBLY narrows cheek -> gonion corner ->
    // soft flat chin at hu 1.0 (an oval WITH a jaw, not an egg) (spec §2 / §4 r11)
    [138, 17.5],                                                       // crown shoulder — round dome
    [147, 22], [153, 31],                                             // upper skull
    [156.5, 43],                                                      // skull widening
    [157.5, 56], [157.5, 64],                                         // EAR/cheek band — WIDEST half 27.5, sustained
    [154, 72],                                                        // cheek descending (half 24)
    [149, 80],                                                        // GONION (jaw angle) — half 19 — densify corner
    [145, 86],                                                        // jawline (half 15)
    [140, 92],                                                        // chin (half 10) — densify
    [138, 94.5],                                                     // chin — soft FLAT terminus (half 8) — densify
    // neck — gentle concave under-jaw INTO near-parallel sides (half ~14, spec §4 r10);
    // the trap flare begins only AT the trap line, not at the chin
    [142, 98],                                                       // under-jaw concave into the neck — densify
    [144, 105],                                                      // neck side — half 14 (parallel)
    [144, 112],                                                      // neck side — half 14 (still parallel)
    // trapezius: a convex knuckle off the neck, then FLATTENING into the acromial
    // shelf and a decisive corner at half ~74 (biacromial, spec §2)
    [153, 114],                                                     // trap knuckle (convex) off the neck — densify
    [174, 117],                                                     // trap rising, beginning to flatten
    [196, 118],                                                     // acromial shelf (flattening)
    [204, 119],                                                     // ACROMION corner — densify (deltoid ball springs below on ARM path)
    // torso — under the deltoid -> armpit -> chest (nipple hu 2.0, half 60) -> waist (hu 2.90, half 52)
    [199, 132],                                                      // under the acromion, tucking in steeply
    [188, 154],                                                      // toward the armpit
    [186, 168],                                                      // armpit — densify
    [190, 180], [188, 202], [184, 222],                             // chest / pec -> rib taper
    [182, 238],                                                      // natural waist — narrowest — densify
    // pelvis — iliac crest (hu 3.16) -> greater trochanter, WIDEST hip half 61 @ y314 (spec §4 r1)
    [184, 256], [188, 286],                                          // iliac crest -> upper hip filling
    [191, 314],                                                      // greater trochanter — widest hip — densify
    [189, 332],                                                      // hip -> outer thigh
    // right leg OUTER — thigh -> knee (hu 5.88) -> outer calf peak (hu 6.39, HIGHER §4 r7) -> ankle
    [185, 352], [180, 386], [175, 422], [172, 448],                 // thigh sweep, dense taper
    [170, 466],                                                     // outer knee — densify corner
    [173, 490],                                                     // below-knee tibial flare
    [177, 508],                                                     // OUTER calf peak — higher (§4 r7) — densify
    [173, 532], [166, 558], [161, 580],                            // gastrocnemius descending -> shin
    [162, 596],                                                     // outer ankle — narrowest — densify
    // right foot — SEPARATE, centered ~x152 under the hip; forefoot splay, rounded toes (lead)
    [166, 609],                                                     // outer forefoot widening
    [168, 620],                                                     // little-toe corner — densify
    [161, 628], [149, 628],                                         // toe box (sole y628) — densify
    [139, 626],                                                     // big toe / inner forefoot
    [137, 611],                                                     // instep — densify
    [142, 598],                                                     // inner ankle — densify (foot separates from the left)
    // right leg INNER — up the inner ankle/calf/knee/thigh; edge stays RIGHT of center, gap WIDENS downward
    [141, 570], [140, 540],                                         // inner shin (gap ~22)
    [140, 518],                                                     // inner (medial) calf peak — LOWER than outer (§4 r7)
    [139, 494], [137, 466],                                         // toward inner knee — densify (gap ~14)
    [135, 420], [134, 384],                                         // inner thigh (gap ~8)
    [132, 352],                                                     // inner thigh top — thighs NEARLY TOUCH (gap ~4) — densify
    [131, 337],                                                     // approach to the crotch V (gap ~2) — densify
  ];
  const CROTCH: CbfPt = [130, 328];
  const ARM_R: CbfPt[] = [
    // deltoid BALL — springs from just below the acromion corner, bulges to the
    // bideltoid max half ~85 @ y~140 (spec §2), the widest point of the figure
    [202, 121],                                                     // inner-top, just under the acromion corner
    [211, 129], [216, 142],                                        // deltoid rising -> BALL (widest, hu 1.62) — densify
    [211, 162],                                                    // deltoid lower — rounds in under the ball
    // upper arm -> elbow AT the navel/waist line (hu 2.97, spec §4 r3)
    [209, 186], [205, 214],
    [202, 240],                                                    // elbow — densify corner
    // forearm — gentle carrying angle out, to the wrist ON the crotch line (hu 4.08, spec §4 r4)
    [205, 266], [204, 298], [200, 322],
    [198, 330],                                                    // wrist — on the crotch line — densify
    // hand — back widens to knuckles, fingers taper to rounded tips (hu 4.82), thumb mass inner (director)
    [202, 344], [203, 356],                                       // back of hand -> knuckle line (widest)
    [199, 372],                                                   // fingers tapering
    [192, 385],                                                  // fingertips — rounded — densify
    [185, 376], [180, 360],                                      // finger inner -> thumb tip
    [178, 346],                                                  // thenar / thumb-base bump (inner) — densify
    [180, 332],                                                  // wrist inner
    // inner forearm -> inner upper arm -> armpit
    [182, 300], [183, 268],
    [180, 240],                                                  // inner elbow
    [179, 210], [179, 184], [177, 158],                         // inner arm toward the armpit
    [181, 150],                                                  // armpit / inner deltoid — densify
  ];

  // ---------- muscles (right-side loops; mirror:true adds the left copy) ----------
  type CbfMuscleDef = { g: string; mirror: boolean; pts: CbfPt[] };
  const MUSCLES_FRONT: CbfMuscleDef[] = [
    { g: "neck", mirror: true, pts: [[132.4, 97.7], [136.8, 98.9], [136, 107.3], [132.9, 110], [131.9, 102.5]] },
    { g: "shoulders", mirror: true, pts: [[137, 111], [144, 115], [168, 120], [169, 125], [150, 121], [137, 116]] },
    { g: "shoulders", mirror: true, pts: [[166, 118], [192, 122], [210, 134], [212, 152], [204, 165], [188, 166], [173, 145], [169, 127]] },
    { g: "chest", mirror: true, pts: [[133, 137], [154, 133], [172, 139], [183, 152], [179, 168], [165, 179], [149, 182], [135, 180], [131.5, 158]] },
    { g: "biceps", mirror: true, pts: [[183.1, 171.7], [198.7, 170], [205.3, 192.2], [201.6, 219.6], [191.9, 224.7], [184.3, 200.8]] },
    { g: "forearms", mirror: true, pts: [[182.9, 237.2], [199.3, 236.1], [206.1, 253.5], [206.8, 286], [200.2, 312.1], [193.6, 314.2], [186.1, 287.1], [182.9, 254.5]] },
    { g: "core", mirror: true, pts: [[158.1, 197.4], [171.8, 204.2], [171.4, 231.6], [158, 261], [153, 228.2], [153.2, 204.2]] },
    { g: "core", mirror: false, pts: [[116, 188.8], [144, 188.8], [152.5, 221.3], [147.6, 265.4], [130, 291.4], [112.4, 265.4], [107.5, 221.3]] },
    { g: "quads", mirror: true, pts: [[165.2, 340.5], [176.9, 349.9], [175.8, 389.9], [171.4, 434.7], [165.2, 460.6], [155.4, 415.8], [157.9, 368.7]] },
    { g: "quads", mirror: true, pts: [[146.5, 335.8], [163, 338.1], [162.5, 387.6], [159, 432.3], [150.9, 455.9], [139.5, 413.5], [141, 366.4]] },
    { g: "quads", mirror: true, pts: [[140, 425.3], [148, 439.4], [150, 462.9], [143, 470], [138, 451.2], [138, 434.7]] },
    { g: "calves", mirror: true, pts: [[146.8, 479.7], [154.3, 482.9], [161.2, 511.1], [156.9, 546.3], [149, 560.8], [144.4, 521.5], [142.3, 494.1]] },
    { g: "calves", mirror: true, pts: [[143, 489.3], [150, 507], [146, 531.8], [141, 515.3], [140, 497.3]] },
  ];
  const MUSCLES_BACK: CbfMuscleDef[] = [
    { g: "back", mirror: false, pts: [[130, 103.6], [136.5, 107.3], [146.4, 114], [174, 121], [156, 128.8], [142.2, 156.3], [133.2, 182], [130, 192.2], [126.8, 182], [117.8, 156.3], [104, 128.8], [86, 121], [113.6, 114], [123.5, 107.3]] },
    { g: "rear delts", mirror: true, pts: [[166, 118], [192, 122], [210, 134], [212, 152], [204, 165], [188, 166], [173, 145], [169, 127]] },
    { g: "back", mirror: true, pts: [[148.1, 136.7], [166.1, 134.7], [176.2, 146.5], [171.1, 162.2], [154.8, 164.1], [146.1, 150.4]] },
    { g: "back", mirror: true, pts: [[140.3, 164.1], [173.8, 168], [185.2, 176.8], [178.8, 204.2], [161.1, 231.6], [145.6, 243.7], [137.2, 209.3], [136.4, 182]] },
    { g: "back", mirror: true, pts: [[131.1, 200.8], [142.6, 200.8], [146.8, 248], [138.4, 293.6], [131.2, 293.6], [128.7, 248]] },
    { g: "triceps", mirror: true, pts: [[183, 170], [198.7, 168], [206.5, 193.9], [202.5, 221.3], [191.9, 226.4], [189.7, 200.8], [182.5, 182]] },
    { g: "forearms", mirror: true, pts: [[182.9, 237.2], [199.3, 236.1], [206.1, 253.5], [206.8, 286], [200.2, 312.1], [193.6, 314.2], [186.1, 287.1], [182.9, 254.5]] },
    { g: "glutes", mirror: true, pts: [[131.2, 291.4], [154.5, 284.9], [169.4, 295.8], [170.2, 315.3], [160.7, 333.4], [139.4, 338.1], [128.8, 321.8], [126.4, 306.6]] },
    { g: "hamstrings", mirror: true, pts: [[158.8, 349.9], [175.5, 357], [173.6, 406.4], [169.2, 453.5], [162, 465.3], [151.8, 415.8], [152.6, 373.5]] },
    { g: "hamstrings", mirror: true, pts: [[142, 347.5], [156, 352.3], [154, 413.5], [151, 458.2], [141, 448.8], [138, 399.4], [140, 368.7]] },
    { g: "calves", mirror: true, pts: [[153.7, 478], [166, 484], [171.5, 507], [167, 540], [159, 553], [152, 515.3], [149.1, 490.9]] },
    { g: "calves", mirror: true, pts: [[145, 481.3], [156, 486.1], [159, 517.3], [151, 548.4], [141, 536], [140, 505.4], [140, 490.9]] },
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
    { side: "L", y: 106, pt: [117, 106], site: "neck", label: "NECK" },
    { side: "L", y: 141, pt: [45, 141], site: "shoulder", label: "SHOULDER" },
    { side: "L", y: 200, pt: [51, 200], site: "arm", label: "ARM" },
    { side: "L", y: 290, pt: [56, 290], site: "forearm", label: "FOREARM" },
    { side: "R", y: 180, pt: [190, 180], site: "chest", label: "CHEST" },
    { side: "R", y: 238, pt: [182, 238], site: "waist", label: "WAIST" },
    { side: "R", y: 314, pt: [191, 314], site: "hip", label: "HIP" },
    { side: "R", y: 384, pt: [180, 384], site: "thigh", label: "THIGH" },
    { side: "R", y: 508, pt: [177, 508], site: "calf", label: "CALF" },
  ];
  // Sites whose anchors/washes ride the ARM paths (vs the torso).
  const ARM_SITES = new Set(["shoulder", "arm", "forearm"]);
  // Per-site glow washes [cx, cy, rx, ry, clip] — clip: 't' torso, 'aR'/'aL' arms.
  type CbfGlow = [number, number, number, number, string];
  const GLOWS: Record<string, CbfGlow[]> = {
    neck: [[130, 102, 20, 14, "t"]],
    shoulder: [[205, 142, 26, 24, "aR"], [55, 142, 26, 24, "aL"], [130, 124, 58, 18, "t"]],
    chest: [[130, 178, 62, 30, "t"]],
    waist: [[130, 238, 46, 28, "t"]],
    hip: [[130, 314, 58, 28, "t"]],
    arm: [[200, 200, 17, 40, "aR"], [60, 200, 17, 40, "aL"]],
    forearm: [[202, 292, 15, 42, "aR"], [58, 292, 15, 42, "aL"]],
    thigh: [[158, 395, 26, 58, "t"], [102, 395, 26, 58, "t"]],
    calf: [[158, 512, 22, 46, "t"], [102, 512, 22, 46, "t"]],
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
        // Female: the warp already re-seats loops in x by zone, so shrinking is
        // limited to the pecs (a gentle feminizing pull); everything else rides
        // the warp so nothing floats off the outline (spec §4 r15 / director).
        if (sex === "female" && def.g === "chest") p = shrink(p, 0.9);
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
    const optHalf = 46 * (sex === "female" ? kOf(238) : 1);
    return openD([
      [130 + sign * (optHalf + 8), 210], [130 + sign * (optHalf + 2), 224], [130 + sign * optHalf, 238],
      [130 + sign * (optHalf + 2), 252], [130 + sign * (optHalf + 6), 266],
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
