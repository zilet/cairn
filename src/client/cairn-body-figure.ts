// cairn-body-figure.ts — the elite body figure for Cairn (Train muscle balance
// + Stand tape figure). Compiled to /cairn-body-figure.js (loaded as a classic
// script BEFORE the bundles, like /art.js, and precached in sw.js).
//
// Vendored from the "Body Visualizations" Claude Design project — the approved
// shapes are options 2a/2b there, and the tape-driven measured figure is 3a/3b.
// One drawing serves everything: male and female come from the same paths via a
// per-body-zone x-warp, and the Stand figure re-proportions per body zone from
// REAL tape circumferences against a height-derived reference physique
// (`measuredSilhouette`) — the figure is honest to the numbers, never a
// caricature, and the reference is a reference, never a mandate.
//
// Convention preserved: SVG paint attrs use illustration hexes, not CSS var()
// (see docs/DESIGN.md).

type CbfPt = [number, number];
type CbfTape = Partial<Record<string, number | null>>;
type CbfScales = Record<string, number>;

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
  // Anchors are [y, scale]; one drawing serves both sexes.
  const K_ANCHORS: CbfPt[] = [
    [0, 0.96], [95, 0.92], [125, 0.88], [200, 0.88], [245, 0.85], [300, 1.05], [345, 1.0], [640, 0.93],
  ];
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

  // ---------- skeleton (viewBox 0 0 260 640, centerline x=130) ----------
  const HEAD_TOP: CbfPt = [130, 14];
  const RIGHT_TORSO: CbfPt[] = [
    [146, 18], [155, 34], [156, 48], [151, 62], [144, 72],      // skull, cheek, jaw
    [139, 80], [140, 92],                                        // under-jaw, neck
    [152, 99], [172, 107], [189, 117],                           // trap slope -> acromion
    [186, 152], [184, 166], [180, 190], [169, 214],              // armpit, chest, rib taper
    [161, 240], [164, 262], [167, 284], [169, 306],              // gentle waist -> iliac crest
    [171, 326], [172, 352], [168, 398], [163, 432], [160, 446],  // hip flows into quad sweep -> knee
    [164, 470], [166, 492], [159, 532], [156, 560], [155, 578],  // calf swell -> ankle
    [161, 596], [166, 610], [144, 613], [142, 584],              // foot
    [141, 560], [139, 530], [136, 492], [140, 462], [141, 448],  // inner calf, inner knee
    [139, 410], [135, 368], [132, 344],                          // inner thigh
  ];
  const CROTCH: CbfPt = [130, 322];
  const ARM_R: CbfPt[] = [
    [170, 110], [188, 113], [199, 124], [204, 140], [203, 162],  // delt cap
    [201, 190], [197, 226],                                       // outer bicep -> elbow
    [205, 252], [208, 278], [209, 306], [206, 328],               // forearm flare -> wrist
    [210, 346], [212, 362], [203, 371], [196, 356],               // hand
    [193, 332], [189, 300], [185, 270], [182, 240],               // inner forearm
    [180, 208], [177, 178], [174, 156],                           // inner bicep -> armpit
  ];

  // ---------- muscles (right-side loops; mirror:true adds the left copy) ----------
  type CbfMuscleDef = { g: string; mirror: boolean; pts: CbfPt[] };
  const MUSCLES_FRONT: CbfMuscleDef[] = [
    { g: "neck", mirror: true, pts: [[133, 78], [138, 80], [141, 94], [136, 98], [132, 86]] },
    { g: "shoulders", mirror: true, pts: [[143, 96], [158, 102], [173, 110], [168, 116], [150, 112], [141, 104]] },
    { g: "shoulders", mirror: true, pts: [[172, 110], [190, 114], [200, 126], [202, 142], [196, 156], [184, 158], [173, 138], [169, 120]] },
    { g: "chest", mirror: true, pts: [[133, 130], [152, 127], [168, 131], [180, 143], [180, 158], [170, 170], [152, 176], [137, 178], [132, 156]] },
    { g: "biceps", mirror: true, pts: [[181, 166], [196, 164], [201, 190], [198, 222], [188, 230], [181, 200]] },
    { g: "forearms", mirror: true, pts: [[184, 240], [198, 242], [206, 262], [209, 300], [207, 326], [200, 328], [191, 296], [183, 258]] },
    { g: "core", mirror: true, pts: [[155, 196], [166, 204], [162, 236], [152, 264], [148, 232], [150, 204]] },
    { g: "core", mirror: false, pts: [[117, 186], [143, 186], [148, 224], [144, 268], [130, 292], [116, 268], [112, 224]] },
    { g: "quads", mirror: true, pts: [[160, 336], [172, 344], [173, 378], [168, 416], [160, 438], [155, 400], [155, 360]] },
    { g: "quads", mirror: true, pts: [[144, 332], [158, 334], [160, 376], [157, 414], [149, 434], [142, 398], [141, 358]] },
    { g: "quads", mirror: true, pts: [[139, 408], [146, 420], [147, 440], [140, 446], [135, 430], [135, 416]] },
    { g: "calves", mirror: true, pts: [[146, 458], [153, 462], [156, 496], [152, 530], [147, 544], [144, 506], [143, 476]] },
    { g: "calves", mirror: true, pts: [[138, 470], [143, 492], [141, 516], [136, 500], [135, 480]] },
  ];
  const MUSCLES_BACK: CbfMuscleDef[] = [
    { g: "back", mirror: false, pts: [[130, 88], [142, 94], [160, 104], [174, 114], [156, 122], [142, 150], [133, 178], [130, 190], [127, 178], [118, 150], [104, 122], [86, 114], [100, 104], [118, 94]] },
    { g: "rear delts", mirror: true, pts: [[172, 110], [190, 114], [200, 126], [202, 142], [196, 156], [184, 158], [173, 138], [169, 120]] },
    { g: "back", mirror: true, pts: [[148, 130], [166, 128], [176, 140], [170, 156], [154, 158], [146, 144]] },
    { g: "back", mirror: true, pts: [[140, 158], [172, 162], [182, 172], [172, 204], [154, 236], [142, 248], [136, 210], [136, 178]] },
    { g: "back", mirror: true, pts: [[131, 200], [141, 200], [143, 252], [137, 294], [131, 294], [129, 252]] },
    { g: "triceps", mirror: true, pts: [[181, 164], [196, 162], [202, 192], [198, 224], [188, 230], [186, 200], [180, 178]] },
    { g: "forearms", mirror: true, pts: [[184, 240], [198, 242], [206, 262], [209, 300], [207, 326], [200, 328], [191, 296], [183, 258]] },
    { g: "glutes", mirror: true, pts: [[131, 292], [150, 286], [163, 296], [164, 314], [156, 330], [138, 334], [129, 320], [127, 306]] },
    { g: "hamstrings", mirror: true, pts: [[155, 344], [169, 350], [170, 392], [164, 432], [157, 442], [152, 400], [151, 364]] },
    { g: "hamstrings", mirror: true, pts: [[138, 342], [151, 346], [152, 398], [147, 436], [139, 428], [135, 386], [135, 360]] },
    { g: "calves", mirror: true, pts: [[152, 456], [164, 462], [167, 494], [161, 528], [154, 538], [150, 500], [149, 472]] },
    { g: "calves", mirror: true, pts: [[138, 460], [148, 466], [149, 502], [144, 532], [137, 520], [134, 490], [134, 472]] },
  ];
  // Interior hairlines (sternum, linea alba, ab rows, spine).
  const STROKES_FRONT: CbfPt[][] = [
    [[130, 134], [130, 174]],
    [[130, 190], [130, 272]],
    [[118, 206], [130, 210], [142, 206]],
    [[118, 228], [130, 232], [142, 228]],
    [[119, 250], [130, 254], [141, 250]],
  ];
  const STROKES_BACK: CbfPt[][] = [[[130, 118], [130, 288]]];

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
  // Callout anchors on the MALE figure (x warps per sex via warpPoint).
  type CbfCallout = { side: "L" | "R"; y: number; pt: CbfPt; site: string; label: string };
  const CALLOUTS: CbfCallout[] = [
    { side: "L", y: 88, pt: [120, 88], site: "neck", label: "NECK" },
    { side: "L", y: 118, pt: [71, 117], site: "shoulder", label: "SHOULDER" },
    { side: "L", y: 192, pt: [59, 192], site: "arm", label: "ARM" },
    { side: "L", y: 288, pt: [51, 288], site: "forearm", label: "FOREARM" },
    { side: "R", y: 164, pt: [184, 164], site: "chest", label: "CHEST" },
    { side: "R", y: 240, pt: [159, 238], site: "waist", label: "WAIST" },
    { side: "R", y: 294, pt: [168, 290], site: "hip", label: "HIP" },
    { side: "R", y: 372, pt: [171, 370], site: "thigh", label: "THIGH" },
    { side: "R", y: 496, pt: [166, 494], site: "calf", label: "CALF" },
  ];
  // Sites whose anchors/washes ride the ARM paths (vs the torso).
  const ARM_SITES = new Set(["shoulder", "arm", "forearm"]);
  // Per-site glow washes [cx, cy, rx, ry, clip] — clip: 't' torso, 'aR'/'aL' arms.
  type CbfGlow = [number, number, number, number, string];
  const GLOWS: Record<string, CbfGlow[]> = {
    neck: [[130, 86, 22, 16, "t"]],
    shoulder: [[196, 132, 26, 24, "aR"], [64, 132, 26, 24, "aL"], [130, 118, 54, 18, "t"]],
    chest: [[130, 152, 58, 28, "t"]],
    waist: [[130, 240, 52, 32, "t"]],
    hip: [[130, 294, 58, 28, "t"]],
    arm: [[195, 192, 18, 38, "aR"], [65, 192, 18, 38, "aL"]],
    forearm: [[199, 288, 17, 44, "aR"], [61, 288, 17, 44, "aL"]],
    thigh: [[152, 382, 30, 56, "t"], [108, 382, 30, 56, "t"]],
    calf: [[151, 500, 22, 48, "t"], [109, 500, 22, 48, "t"]],
  };

  // ---------- API ----------
  // Silhouette paths for a sex: { torso, armR, armL } (d strings). This IS the
  // reference physique — the Stand hero draws it dashed as the ghost under the
  // measured figure.
  function silhouette(sex: string): { torso: string; armR: string; armL: string } {
    const w = (pts: CbfPt[]) => warp(pts, sex);
    return {
      torso: loopD(w([HEAD_TOP, ...RIGHT_TORSO, CROTCH, ...mirrorPts(RIGHT_TORSO)])),
      armR: loopD(w(ARM_R)),
      armL: loopD(w(mirrorPts(ARM_R))),
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
  // Warp a single [x, y] male-figure point for a sex (callout anchors, glow centers).
  function warpPoint(pt: CbfPt, sex: string): CbfPt {
    return warp([pt], sex)[0];
  }
  // Dashed reference-waist chalk trace (right/left), male coords warped per sex.
  // guideScale is a width multiplier on the reference waist (e.g. the clinical
  // waist-height guide via widthScales), clamped so the chalk stays plausible.
  function waistTrace(sex: string, sign: 1 | -1, guideScale = 0.85): string {
    const scale = Math.min(1.2, Math.max(0.7, guideScale));
    const optHalf = 29 * scale * (sex === "female" ? kOf(240) : 1);
    return openD([
      [130 + sign * (optHalf + 8), 212], [130 + sign * (optHalf + 2), 228], [130 + sign * optHalf, 240],
      [130 + sign * (optHalf + 2), 254], [130 + sign * (optHalf + 6), 268],
    ]);
  }

  // ---------- Stand: measured figure (real tape -> silhouette) ----------
  // Circumferences in INCHES. The reference physique derives from height:
  // reference waist = WAIST_OF_HEIGHT × height (WHtR guidance: keep < 0.5),
  // every other site as a multiple of that reference waist. Neck ≈ arm ≈ calf
  // by design (classical balance). References, not mandates.
  const SITES = ["neck", "shoulder", "chest", "waist", "hip", "arm", "forearm", "thigh", "calf"] as const;
  const WAIST_OF_HEIGHT: Record<string, number> = { male: 0.46, female: 0.42 };
  const REF_MULT: Record<string, Record<string, number>> = {
    male:   { neck: 0.46, shoulder: 1.45, chest: 1.35, waist: 1, hip: 1.21, arm: 0.46, forearm: 0.37, thigh: 0.69, calf: 0.46 },
    female: { neck: 0.47, shoulder: 1.42, chest: 1.32, waist: 1, hip: 1.40, arm: 0.42, forearm: 0.36, thigh: 0.81, calf: 0.51 },
  };
  // Sane tape-entry bounds per site (inches) for input validation.
  const MEAS_LIMITS: Record<string, [number, number]> = {
    neck: [9, 24], shoulder: [30, 65], chest: [26, 60], waist: [22, 56], hip: [28, 60],
    arm: [8, 24], forearm: [7, 18], thigh: [14, 34], calf: [10, 22],
  };
  // Circumference ratio -> frontal-width ratio, per site. Limbs are near-circular
  // (width tracks girth ~1:1); waist gain goes disproportionately to DEPTH in a
  // front view, so its exponent is lowest; the ribcage absorbs part of a chest change.
  const WIDTH_EXP: Record<string, number> = {
    neck: 0.9, shoulder: 0.95, chest: 0.8, waist: 0.7, hip: 0.85, arm: 1, forearm: 1, thigh: 0.95, calf: 1,
  };

  // Reference tape (inches, rounded to 0.5) for a sex + height in inches.
  function referenceTape(sex: string, heightIn: number): Record<string, number> {
    const rw = heightIn * (WAIST_OF_HEIGHT[sex] || WAIST_OF_HEIGHT.male);
    const mult = REF_MULT[sex] || REF_MULT.male;
    const out: Record<string, number> = {};
    for (const k of SITES) out[k] = Math.round(rw * mult[k] * 2) / 2;
    return out;
  }
  // Per-site width scales. Smooth tanh compression instead of a hard clamp:
  // near-linear within ±20% of reference, asymptotes at ±50% width so extreme
  // tapes stay plausible. tape == ref -> all 1 (identical to silhouette()).
  function widthScales(tape: Record<string, number>, ref: Record<string, number>): CbfScales {
    const s: CbfScales = {};
    for (const k of SITES) {
      const r = (tape[k] / ref[k]) ** WIDTH_EXP[k];
      s[k] = 1 + 0.5 * Math.tanh((r - 1) / 0.5);
    }
    return s;
  }
  // y anchors mapping each torso zone to its site scale (male-figure coords).
  const zoneAnchors = (s: CbfScales): CbfPt[] => [
    [0, 1], [74, 1], [84, s.neck], [100, s.neck], [112, (s.neck + s.shoulder) / 2], [122, s.shoulder],
    [150, s.chest], [178, s.chest], [208, (s.chest + s.waist) / 2], [228, s.waist], [256, (s.waist + s.hip) / 2],
    [282, s.hip], [310, s.hip], [336, s.thigh], [408, s.thigh], [446, (s.thigh + s.calf) / 2],
    [468, s.calf], [540, s.calf], [576, (s.calf + 1) / 2], [592, 1], [640, 1],
  ];
  // The arm's own axis (x at y), authored on the male figure.
  const ARM_AXIS: CbfPt[] = [[104, 180], [130, 188], [170, 189], [220, 189], [262, 193], [300, 197], [335, 200], [380, 205]];
  function interpAnchors(y: number, A: CbfPt[]): number {
    if (y <= A[0][0]) return A[0][1];
    for (let i = 0; i < A.length - 1; i++) {
      const [y0, k0] = A[i];
      const [y1, k1] = A[i + 1];
      if (y >= y0 && y <= y1) return k0 + (k1 - k0) * ((y - y0) / (y1 - y0));
    }
    return A[A.length - 1][1];
  }
  function measuredTorsoPoint(pt: CbfPt, sex: string, zA: CbfPt[]): CbfPt {
    const p = warp([pt], sex)[0];
    return [130 + (p[0] - 130) * interpAnchors(p[1], zA), p[1]];
  }
  // Arms: thickness scales about the arm's own axis; the axis drifts out/in
  // with shoulder breadth so the arm stays socketed to the delt.
  function measuredArmPoint(pt: CbfPt, sex: string, s: CbfScales): CbfPt {
    const thickA: CbfPt[] = [[104, s.shoulder], [148, s.shoulder], [176, (s.shoulder + s.arm) / 2], [192, s.arm], [232, s.arm], [254, s.forearm], [318, s.forearm], [338, 1], [640, 1]];
    const shiftA: CbfPt[] = [[104, s.shoulder], [150, s.shoulder], [200, 1 + (s.shoulder - 1) * 0.55], [260, 1 + (s.shoulder - 1) * 0.35], [640, 1 + (s.shoulder - 1) * 0.25]];
    const p = warp([pt], sex)[0];
    const ax = 130 + (interpAnchors(p[1], ARM_AXIS) - 130) * (sex === "female" ? kOf(p[1]) : 1);
    const ax2 = 130 + (ax - 130) * interpAnchors(p[1], shiftA);
    return [ax2 + (p[0] - ax) * interpAnchors(p[1], thickA), p[1]];
  }
  // Silhouette re-proportioned by a real tape: { torso, armR, armL, scales, ref }.
  // tape may be PARTIAL — missing sites fall back to the reference (scale 1).
  // Draw the reference ghost with silhouette(sex) dashed underneath.
  function measuredSilhouette(sex: string, tape: CbfTape | null | undefined, heightIn: number): {
    torso: string; armR: string; armL: string; scales: CbfScales; ref: Record<string, number>;
  } {
    const ref = referenceTape(sex, heightIn);
    const full: Record<string, number> = {};
    for (const k of SITES) {
      const v = tape ? tape[k] : null;
      full[k] = v != null && Number.isFinite(v) && v > 0 ? v : ref[k];
    }
    const s = widthScales(full, ref);
    const zA = zoneAnchors(s);
    const armR = ARM_R.map((p) => measuredArmPoint(p, sex, s));
    return {
      torso: loopD([HEAD_TOP, ...RIGHT_TORSO, CROTCH, ...mirrorPts(RIGHT_TORSO)].map((p) => measuredTorsoPoint(p, sex, zA))),
      armR: loopD(armR),
      armL: loopD(armR.map(([x, y]): CbfPt => [260 - x, y]).reverse()),
      scales: s,
      ref,
    };
  }
  // Position a male-coord anchor (CALLOUTS pt / GLOWS center) on the measured
  // figure. clip: 't' torso (default), 'aR'/'aL' arms. scales from widthScales.
  function measuredPoint(pt: CbfPt, sex: string, scales: CbfScales, clip?: string): CbfPt {
    if (clip === "aR") return measuredArmPoint(pt, sex, scales);
    if (clip === "aL") {
      const p = measuredArmPoint([260 - pt[0], pt[1]], sex, scales);
      return [260 - p[0], p[1]];
    }
    return measuredTorsoPoint(pt, sex, zoneAnchors(scales));
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
    SITES, WAIST_OF_HEIGHT, REF_MULT, MEAS_LIMITS, WIDTH_EXP,
    loopD, openD, mirrorPts, warp, warpPoint, kOf, shrink,
    silhouette, muscles, detailStrokes, waistTrace, figureSvg,
    referenceTape, widthScales, measuredSilhouette, measuredPoint,
  };
  Object.assign(globalThis, { CairnBodyFigure: api });
  if (typeof window !== "undefined") {
    (window as unknown as { CairnBodyFigure: typeof api }).CairnBodyFigure = api;
  }
})();
