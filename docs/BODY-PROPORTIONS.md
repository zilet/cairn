# Human figure proportion spec — Loomis canon + real anthropometry

Grounds an SVG body illustration (`viewBox 0 0 260 640`, crown at `y=16`, soles at `y=628`,
centerline `x=130`) in two complementary sources: **Andrew Loomis's idealized 8-head
canon** (the "Renaissance painter's figure" read — perfect, legible, adaptable) and **real
adult anthropometry** (ANSUR II, so the figure doesn't drift into "alien" stylization).

**Plate math used throughout:**
- `STATURE_PX = 628 − 16 = 612px` (one full figure height)
- Loomis: `HEAD_PX = 612 / 8 = 76.5px`; `plate_y = 16 + head_units × 76.5`
- Anthropometric heights (given as fraction of stature **measured up from the floor**):
  `plate_y = 628 − fraction_from_floor × 612`
- Widths: `width_px = fraction_of_stature × 612`; `half_width = width_px / 2` (from `x=130`)

---

## §1 Vertical landmarks

| Landmark | Loomis head-units | Loomis plate_y | Anthro frac-from-floor (M) | Anthro plate_y (M) | Anthro frac-from-floor (F) | Anthro plate_y (F) |
|---|---|---|---|---|---|---|
| Crown | 0 | 16.0 | 1.0000 | 16.0 | 1.0000 | 16.0 |
| Chin | 1 | 92.5 | — | — | — | — |
| Shoulder line (acromion) | 1.33 (text says "⅙ of the way down"; diagrams often read closer to 1.5 — range **1.33–1.5**, recommend **1.35**) | 117.8–130.8 | 0.8204 | 125.9 | 0.8198 | 126.3 |
| Nipple / chest line | 2 | 169.0 | 0.7352 | 178.1 | 0.7195 | 187.7 |
| Navel / natural waist | 3 | 245.5 | 0.6016 | 259.8 | 0.6019 | 259.6 |
| Iliac crest (top of hip bone) | — (Loomis doesn't name this separately) | — | 0.6045 | 258.1 | 0.6114 | 253.8 |
| Elbow (hanging arm) | 3 ("on a line with the navel" M / "above the navel" F) | 245.5 | 0.6297 (derived, see note) | 242.6 | 0.6286 (derived) | 243.3 |
| Greater trochanter (widest hip, skeletal) | — | — | 0.5130 | 314.0 | 0.5191 | 310.3 |
| Crotch / pubic line (mid-figure) | 4 | 322.0 | 0.4817 | 333.2 | 0.4804 | 334.0 |
| Wrist (hanging arm) | 4 ("just below crotch" M / "even with crotch" F) | 322.0 | 0.4826 | 332.7 | 0.4877 | 329.5 |
| Fingertips (hanging arm) | 4.75 (derived: wrist 4 + hand ¾) | 379.4 | 0.3670 (derived) | 403.4 | 0.3693 (derived) | 402.0 |
| Bottom of kneecap | 6 ("just above the lower quarter") | 475.0 | 0.2781 (mid-patella) | 457.8 | 0.2757 | 459.3 |
| Calf peak (widest point of gastrocnemius) | **~6.8 — convention, not a Loomis-stated number** | 536.2 | not directly in ANSUR (no standing calf-height landmark) | — | — | — |
| Ankle (narrowest point) | **~7.8 — convention** | 612.7 | ANSUR "lateral malleolus height" is a *floor offset*, not useful as a silhouette-narrowing landmark on its own | — | — | — |
| Soles | 8 | 628.0 | 0.0000 | 628.0 | 0.0000 | 628.0 |

**Notes on this table:**
- Loomis's own prose (verified against the OCR'd 1943 first edition, source [7]) gives the
  torso divisions explicitly — chin→nipple→navel→crotch are each exactly **1 head** apart —
  and states the elbow/wrist alignment rules and the "knees just above the lower quarter"
  rule. It does **not** give numeric head-unit positions for the shoulder line, fingertips,
  calf peak, or ankle in the text; those are either derived (fingertips, from his own arm-segment
  figures — see §2) or taken from the widely-reproduced tutorial-diagram convention, which I
  flag explicitly rather than presenting as a Loomis quote.
- **Elbow and fingertip anthro rows are derived, not directly measured**: ANSUR II has no
  standing "elbow height" or "fingertip height" field. I computed them as
  `acromialheight − acromionradialelength` (elbow) and
  `acromialheight − (acromionradialelength + radialestylionlength + handlength)` (fingertips),
  i.e. the standing arm hanging straight down. These land right where the folklore predicts:
  derived elbow height (M 0.630) sits just above the navel/iliac-crest band (0.602–0.605) —
  matching "elbow ≈ waist," slightly high — and derived fingertip height (M 0.367) sits just
  below the crotch–knee midpoint (M ≈ 0.380) — matching "fingertips reach to about mid-thigh."
  **Real wrist height (M 0.4826) and real crotch height (M 0.4817) are almost exactly
  equal** — a striking independent confirmation of Loomis's "wrist is level with the crotch"
  rule from a completely unrelated dataset.
- **The idealized (Loomis) crotch sits noticeably higher on the figure than the real
  average crotch** (4.000/8 = 0.500 from crown vs. real ≈ 0.518–0.520 from crown, i.e. real
  legs are proportionally *shorter* / the torso proportionally *longer* than the 8-head ideal).
  This is the single biggest place idealization diverges from reality — worth knowing before
  leaning fully on either column.

---

## §2 Widths / half-widths

All entries are ANSUR II means, converted at `width_px = fraction_of_stature × 612`,
`half_width = width_px / 2`.

| Site | Frac. of stature (M) | Half-width px (M) | Frac. of stature (F) | Half-width px (F) | Source measure |
|---|---|---|---|---|---|
| Head (breadth, ear-to-ear) | 0.0879 | 26.9 | 0.0907 | 27.8 | `headbreadth` |
| Neck (front-view width) | ~0.0788 *(derived, see caveat)* | ~24.1 | ~0.0726 *(derived)* | ~22.2 | `neckcircumferencebase / π` — **approximation**; a neck's cross-section is oval, flattened front-to-back, so true frontal width is somewhat less than circumference/π implies. Treat as an upper bound. |
| Shoulders, bideltoid (fleshy, widest shoulder point) | 0.2906 | 88.9 | 0.2765 | 84.6 | `bideltoidbreadth` |
| Shoulders, biacromial (bony, acromion-to-acromion) | 0.2367 | 72.4 | 0.2244 | 68.7 | `biacromialbreadth` |
| Chest (bust/nipple-line breadth) | 0.1648 | 50.4 | 0.1654 | 50.6 | `chestbreadth` |
| Natural waist | 0.1859 | 56.9 | 0.1842 | 56.4 | `waistbreadth` |
| Hip / iliac, widest (fleshy, standing) | 0.1969 | 60.3 | 0.2173 | 66.5 | `hipbreadth` |
| Hip, bony (bicristal — iliac crest to iliac crest) | 0.1568 | 48.0 | 0.1678 | 51.4 | `bicristalbreadth` |
| Mid-thigh (frontal span) | **not available** | — | **not available** | — | ANSUR II has `thighcircumference` only (single-leg girth), no two-leg frontal-span breadth. See §4 for the recommended construction workaround. |
| Knee (frontal span) | **not available** | — | **not available** | — | No standing frontal knee-breadth field in ANSUR II. See §4. |
| Calf, widest point | ~0.0711 *(derived)* | ~21.8 | ~0.0729 *(derived)* | ~22.3 | `calfcircumference / π` — same oval-cross-section caveat as neck. |
| Ankle (bimalleolar, narrowest point) | 0.0426 | 13.0 | 0.0412 | 12.6 | `bimalleolarbreadth` — this one **is** a direct, real frontal-breadth measurement. |

**Honest gap:** there is no public standing-frontal breadth measurement for mid-thigh or
knee in ANSUR II (or in any anthropometric survey I found — these surveys measure girths,
not left-right span, for the leg). Don't invent a number here; §4 gives a defensible
construction rule instead (interpolate between the real hip and ankle half-widths using the
Loomis leg-taper shape, not a fabricated data point).

---

## §3 Female-vs-male ratio at matched stature

This is the ratio to feed a **piecewise x-warp of a male base figure**: at the *same*
drawn stature (both figures normalized to the same 612px), how much narrower/wider is each
site on the female figure. (Note this is **not** the same as ANSUR's raw male-vs-female
mm ratio, which conflates the ~7% average stature gap between the sexes — the table below
already factors that out.)

| Site | F/M ratio (same stature) | Reads as |
|---|---|---|
| Head breadth | 1.032 | female head very slightly wider relative to her height |
| Shoulders, bideltoid | 0.952 | female shoulders ~5% narrower |
| Shoulders, biacromial (bony) | 0.948 | same, bony frame |
| Chest breadth | 1.004 | essentially equal |
| Natural waist | 0.991 | essentially equal (waist is *not* where the sexes differ most) |
| Hip, fleshy (widest) | **1.104** | female hips ~10% wider — the largest single divergence |
| Hip, bony (bicristal) | 1.070 | about a third of the fleshy-hip gap is bone, the rest is soft-tissue distribution |
| Ankle (bimalleolar) | 0.967 | female ankle ~3% narrower |

**The shoulder:hip taper is the real story, not any single width.** At matched stature:
male bideltoid-to-hip ratio = 88.9 / 60.3 = **1.47** (pronounced V-taper); female
bideltoid-to-hip ratio = 84.6 / 66.5 = **1.27** (much straighter/hourglass, not a V). Drive
the male/female silhouette difference primarily through this taper ratio, not through
scaling the whole figure narrower — chest and waist breadth are nearly identical between
sexes; shoulders and hips are where they actually diverge.

---

## §4 Silhouette shape rules

1. **The widest hip point is the greater trochanter**, at ≈0.513 of stature from the floor
   (male) / ≈0.519 (female) — both sexes land within 1% of the same *height*; what differs
   is the *width* there (§3). Don't place the hip bulge at the waist-adjacent iliac crest
   (higher, ≈0.60–0.61) or you'll draw the hips too high and too narrow.
2. **The female hip-to-shoulder ratio is far closer to 1 than the male's** (female fleshy-hip
   half-width 66.5px vs. shoulder half-width 84.6px, a ratio of 0.79, versus the male's 0.68 —
   see §3's 1.27 vs. 1.47 shoulder:hip taper). In practice: never let the female hip contour
   sit as far inside the shoulder contour as a male V-taper would suggest; the classic
   hourglass reads through a *straighter* torso silhouette, not simply a wider hip in isolation.
3. **Elbow crease sits at the lower ribs / just above the natural waist**, not exactly on
   the navel line — real data derived elbow height (M 0.630, F 0.629 of stature) lands
   between the iliac-crest line (0.60–0.61) and the tenth-rib line (0.638–0.649), a hair
   above where most tutorials draw it.
4. **Wrist sits almost exactly at the crotch line** when the arm hangs naturally — this is
   both Loomis's stated rule and independently confirmed by ANSUR (wrist height and crotch
   height differ by under 0.1% of stature for both sexes). This is the single most
   reliable landmark alignment to build the construction grid on.
5. **Fingertips reach to just below mid-thigh**, not to the knee — roughly 0.367–0.369 of
   stature from the floor, versus a crotch–knee midpoint of ≈0.38. Don't let a hanging hand
   reach past the upper third of the thigh.
6. **The idealized 8-head crotch line sits higher than the real average crotch** — if the
   figure is meant to read as "perfect but human," bias the crotch/waist split slightly
   toward the anthropometric value (≈0.51–0.52 of stature from the crown) rather than the
   exact Loomis half (0.50), or the legs will read as unrealistically elongated.
7. **Calf peak is higher on the outer (lateral) line than the inner (medial) line** — this
   is a standard art-anatomy asymmetry (the two calf muscle bellies, gastrocnemius medialis
   and lateralis, don't peak at the same height); a symmetric calf bulge reads as generic/CG.
   No numeric split found in the sources researched — treat as a qualitative asymmetry, not
   a hard offset.
8. **The leg is triangular in cross-section-silhouette at the calf, and squares off at the
   ankle** — the calf-to-ankle transition should read as a taper into a narrower, flatter
   shape, not a uniform cylinder narrowing.
9. **Ankle is the true minimum width of the leg** (half-width ≈13px both sexes at this
   scale) — don't narrow the leg further below the ankle before the foot; the foot widens
   again at the ball.
10. **Neck is not a cylinder** — it rises from the trapezius/shoulder line at a visibly
    forward-and-up angle, not straight up, and the circumference-derived width estimate
    (~24px half-width male, ~22px female) should be read as a rough upper bound, since a
    true oval cross-section reads narrower from the front than circumference/π implies.
11. **Head width is commonly cited in art instruction as ≈0.72–0.75 of head height**
    (crown-to-chin) — flagged explicitly as **not verified against real data in this
    research**: no public anthropometric field gives frontal crown-to-chin head height, only
    circumference/breadth/depth. Treat the 0.72–0.75 figure as inherited convention, not a
    sourced anthropometric ratio.
12. **Foot length in reality is shorter, relative to height, than classical canon claims** —
    real ANSUR foot length is ≈0.154 of stature (male) / 0.151 (female), versus the classical
    "foot = ⅙ of height" (0.167) still repeated in some figure-drawing texts. Use the real
    ~0.15 fraction if the goal is anatomical accuracy over classical convention.
13. **Shoulder line, not chin, is the first major width break below the head** — it falls at
    roughly 1.33–1.5 heads down (Loomis) / 0.82 of stature from the floor (real, both sexes
    agree to within 0.1%), i.e. it is one of the *most* sex-consistent landmarks in the whole
    figure — the sexes diverge in width there, essentially not at all in height.
14. **Mid-thigh and knee frontal widths have no real anthropometric source** — construct them
    by interpolation: taper from the real hip half-width (§2) down to a knee half-width
    roughly 25–35% narrower (standard Loomis-style leg taper, not a sourced ratio), then
    taper further to the real ankle half-width, flaring back out slightly at the calf peak
    (rule 7) in between.
15. **Chest and waist breadth barely differ by sex** (F/M ratios 1.004 and 0.991
    respectively) — almost all of the male/female silhouette difference should be carried by
    the shoulder-to-hip taper (§3), not by narrowing the ribcage or waist box itself for the
    female figure. A female figure with a narrowed ribcage in addition to narrowed shoulders
    will read as generically "smaller," not as anatomically female.

---

### Neutral male baseline and measurement guardrails

The unwarped male plate is intentionally an ordinary adult, not an anatomy-model ideal:
**70 in, 185 lb, neck 15.5 in, shoulder circumference 46.2 in, chest 42.2 in, waist
35.8 in, hips 40.5 in, thigh 24.0 in, calf 15.8 in, upper arm 13.8 in, forearm
11.8 in**. The Navy equation puts this tape at approximately **20% body fat**. These are
seed/demo values and rendering anchors only; they are never presented as physique targets.

Input protection has two levels:

- **Hard site bounds** are intentionally wide adult-human limits. Values outside them are rejected
  without writing a partial tape session.
- **Height-scaled and cross-site checks** are soft. They identify likely unit mistakes, misplaced
  tapes, or transposed values, but an unusual real body remains loggable after an explicit recheck.

Surface definition follows the tape body-fat estimate. Around 20%, the figure keeps clavicle,
pectoral-envelope, patella and calf landmarks while suppressing visible abdominal segmentation;
leaner bodies reveal somewhat more relief and higher estimates reveal less. This is a visual
continuum, not a diagnostic claim.

---

## §5 Browser body-tracing options, and what Cairn should borrow

There are good JavaScript/browser tools for **reading a photo**, but they should not be the
primary renderer for the Stand tape figure:

- **MediaPipe Pose Landmarker** is the best browser-native starting point for a future photo
  capture/import flow: it runs in Web/JS, returns normalized landmarks plus 3D world landmarks,
  exposes the BlazePose-style 33 landmark model, and can optionally output a person segmentation
  mask. It is pose/posture intelligence, not a tape-measure renderer.
- **TensorFlow.js pose/body-segmentation** is the adjacent ecosystem: MoveNet/PoseNet/BlazePose
  keypoints plus segmentation models can identify foreground pixels and major joints in-browser.
  This can trace a person or validate pose framing, but clothing, camera distance, lens distortion,
  and perspective make raw circumference inference unreliable for Cairn's health UI.
- **OpenCV.js contours** are useful after segmentation: threshold/mask -> `findContours` ->
  simplify/smooth contour -> extract a clean outer body outline. This is a tracing step, not an
  anatomy model; it needs landmarks and anthropometric constraints to avoid lumpy silhouettes.
- **SMPL/STAR/BodyM-style statistical body models** are the serious path for measurement-to-body
  realism: learned 3D body shape from scans, pose-dependent blend shapes, and datasets pairing
  silhouettes with real measurements. They are too heavy/licensed/private for Cairn's offline PWA
  baseline today, but the design principle is directly useful: map local measurements to a
  constrained body model, then project to a clean front-view figure.

**Product decision:** Cairn's Stand figure should stay deterministic and private: an authored
anatomical SVG body, warped locally by the athlete's own tape ratios, with subtle surface anatomy
relief and clinical waist guides. Borrow the **pipeline ideas** from pose/segmentation/SMPL
(landmarks, contours, constrained shape space), not a black-box photo estimator. A future optional
"trace my photo" feature could use MediaPipe/TFJS + OpenCV.js only to extract landmarks/contours,
then reconcile them against the logged tape rather than replacing the tape as truth.

---

## §6 Sources

**Loomis canon:**
1. Kreated by Krause, "Andrew Loomis's 'Flat Diagram' — Part III" — https://kreatedbykrause.blogspot.com/2016/07/andrew-loomiss-flat-diagrampart-iii.html (8 horizontal divisions = 1 head each; diagram is 2⅓ heads wide; confirms male/female diagrams differ)
2. Darren C. Fisher, "Looming Proportions" — https://www.darrencfisher.com/2019/04/05/looming-proportions/ (torso: 1 head chin-to-nipple, 1 head nipple-to-navel, 1 head navel-to-perineum; overall-height variants 7.5/8/8.5/9 heads)
3. "Learning to draw: Learning to see," Proportions of the Figure — http://learningtodrawlearningtosee.blogspot.com/2014/03/proportions-of-figure.html (female shoulders 2 heads vs. male 2⅓; female waist 1 head vs. male 1⅓)
4. Jeff Kamangara, "Drawing the Solid Figure" — https://jeffkamangara.wordpress.com/2019/02/25/drawing-the-solid-figure/ (fullest secondary breakdown: torso/pelvis box dimensions, arm segment lengths, leg 2+2 heads, foot ≈1 head, male/female shoulder-waist-torso widths)
5. Proko, "Human Proportions – Idealistic Figures" — https://www.proko.com/course-lesson/human-proportions-idealistic-figures/ (elbow-at-navel / wrist-at-crotch rule stated for the idealized figure; fingertip-to-fingertip span ≈ height + 4%)
6. **Andrew Loomis, *Figure Drawing for All It's Worth* (1943 first edition), full OCR text — https://archive.org/stream/loomis_FIGURE_draw/loomis_FIGURE_draw_djvu.txt — PRIMARY SOURCE.** Direct quotes used: "The waist is a little wider than one head unit" (male); "The wrist drops just below the crotch" (male); "The elbows are about on a line with the navel" (male); "The knees are just above the lower quarter of the figure"; "The shoulders are one-sixth of the way down"; "two and one third of these units will be the relative width for the male figure"; "The female figure is relatively narrower — two heads at the widest point"; "The nipples and navel are one head apart" (female); "The elbow is above the navel" (female); "Wrists are even with crotch" (female); "The waistline measures one head unit across" (female).
7. Same Internet Archive text, second pass for calf/ankle/hip-width phrasing — confirms Loomis's prose does **not** give numeric head-unit positions for calf peak or ankle narrowing (diagram-only), and that "the calf is much less developed" / "ankles and wrists are smaller" in the female figure are qualitative, not quantified, statements in the book.

**Real anthropometry (ANSUR II):**
8. Penn State OPEN Design Lab, official ANSUR II host — https://www.openlab.psu.edu/ansur2/ (methodology, official CSV download pointers, summary-report existence)
9. **Raw ANSUR II Public data, N=4,082 men / N=1,986 women, downloaded and analyzed directly for this spec** — https://raw.githubusercontent.com/senihberkay/US-Army-ANSUR-II/master/ANSUR%20II%20MALE%20Public.csv and .../FEMALE%20Public.csv (mirror of the official 2012 U.S. Army survey, publicly released 2017). All §1–§3 fraction-of-stature figures, all derived (elbow/fingertip) heights, and all F/M same-stature ratios in this document were computed directly from this raw dataset — not copied from a secondary summary. Analysis script: `/private/tmp/claude-501/-Users-miloszikic-workspace-playground-cairn/9d004aee-9818-42fa-aec1-dd008de6c679/scratchpad/ansur/analyze.py`.
10. University of Michigan Transportation Research Institute, ANSUR ADAS Dimension Definitions — https://mreed.umtri.umich.edu/mreed/downloads/anthro/ansur/ADAS-Dimension_Definitions.pdf (confirms exact meaning of each ANSUR field name used above, e.g. `bideltoidbreadth`, `trochanterionheight`, `bimalleolarbreadth`)

**Renaissance canons:**
11. Australian Art History, "Proportion" — https://www.australianarthistory.com/proportion — and Back In Action, "What Are The Proportions In The Vitruvian Man?" — https://back-in-action.com/proportions-vitruvian-man (Leonardo da Vinci's Vitruvian Man, per Vitruvius: arm span = height; shoulder width = ¼ height; crown-to-mid-chest = ¼ height; mid-chest-to-crotch = ¼ height; hairline-to-chin = 1/10 height; chin-to-crown = ⅛ height — this last figure is the direct ancestor of the "8 heads tall" convention Loomis inherited)
12. ResearchGate / Open Book Publishers / History of Information / The Morgan Library, on Albrecht Dürer's *Four Books on Human Proportion* (1528) — https://www.researchgate.net/publication/376979645_The_Connection_between_Anatomy_and_the_Arts--From_Durer%27s_Four_Books_of_Human_Proportion , https://books.openedition.org/obp/12712 , https://www.historyofinformation.com/detail.php?entryid=2229 , https://www.themorgan.org/exhibitions/online/imperial-splendor/four-books-human-proportion (Dürer rejected a single fixed canon and instead catalogued ≈26 body types — fat/thin/tall/short/infant — each with its own measurements; the relevant takeaway for this product is his explicitly *relativistic*, adaptable approach, as opposed to Vitruvius/Leonardo's single ideal.)

**Silhouette / art-anatomy landmark notes:**
13. Kenhub, "Greater trochanter of femur" — https://www.kenhub.com/en/library/anatomy/greater-trochanter-of-femur — and Wikipedia, "Greater trochanter" — https://en.wikipedia.org/wiki/Greater_trochanter (confirms the greater trochanter, not the iliac crest, is the widest skeletal landmark of the hip — used to justify placing the hip-width bulge at trochanter height, not waist-adjacent iliac-crest height)
14. Bardot Brush, "How to Draw Body Proportions" — https://bardotbrush.com/how-to-draw-body-proportions/ (calf widest point ≈⅓ of the way down the lower leg; ankle narrower than calf, only slightly wider than the heel in a relaxed pose)

**Browser tracing / statistical body models:**
15. Google MediaPipe Pose Landmarker for Web — https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js (Web/JavaScript setup, 33 landmarks, world landmarks, optional segmentation mask)
16. TensorFlow.js `pose-detection` — https://github.com/tensorflow/tfjs-models/tree/master/pose-detection (MoveNet / BlazePose / PoseNet keypoint models; BlazePose keypoint map)
17. TensorFlow.js `body-segmentation` — https://github.com/tensorflow/tfjs-models/tree/master/body-segmentation (browser-side person segmentation family)
18. OpenCV.js contours tutorial — https://docs.opencv.org/4.x/d5/daa/tutorial_js_contours_begin.html (`findContours` / `drawContours`; contour = continuous boundary of a binary object)
19. SMPL official site — https://smpl.is.tue.mpg.de/ (scan-learned 3D human body model, shape and pose blend shapes)
20. STAR official site — https://star.is.tue.mpg.de/ (compact sparse local corrective body model; improved realism/generalization vs. SMPL)
21. BodyM / Human Body Measurement Estimation with Adversarial Augmentation — https://adversarialbodysim.github.io/ (real silhouettes + measurements, SMPL-based adversarial simulation)

**Numbers NOT found / explicitly flagged as unsourced in this research** (do not treat as sourced if reused elsewhere): exact head-unit position of the shoulder line in Loomis's own diagrams (text gives ⅙-of-the-way-down = 1.33 heads, but reproduced charts commonly show it closer to 1.5 — presented as a range); exact head-unit position of calf peak and ankle narrowing in Loomis (diagram-only, not stated in prose — used the widely-reproduced tutorial convention ~6.8 / ~7.8 heads instead, flagged as convention not primary-source); any real standing frontal-breadth measurement for mid-thigh or knee (no such field exists in ANSUR II or in any other source checked); a verified real-data ratio of head width to head height (no public field for frontal crown-to-chin head height); a precise numeric offset between the calf's medial and lateral peak heights (only a qualitative "outer is higher" rule was found, no numeric split).
