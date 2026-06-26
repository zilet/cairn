# Cairn Design System — "Atelier"

The visual language of the Cairn PWA. Warm-gallery / studio-catalog aesthetic: training and
nutrition presented like a beautifully printed museum catalog — warm paper, ink typography,
studio-lit illustration plates, generous whitespace, soft layered shadows, quiet motion.

This document is the **frozen contract** between `public/styles.css` (design system),
`public/art.js` (illustration library), and the view modules in `public/js/` (formerly
the single `app.js`). Class names and APIs
listed here are load-bearing — change them in all three places or not at all.

## Palette (CSS variables in `:root`)

```css
--paper:   #f4efe7;  /* page background, warm cream */
--card:    #fffdf8;  /* card surface */
--card-2:  #f8f3ea;  /* inset surfaces: inputs, wells, chips */
--ink:     #211d17;  /* primary text, near-black warm ink */
--ink-2:   #57503f;  /* secondary text */
--muted:   #746c5c;  /* tertiary text, labels — darkened from #8c8475 to clear WCAG AA on --card-2 */
--line:    #e7dfd2;  /* hairlines */
--line-2:  #d8cfbd;  /* stronger hairlines */
--accent:  #b4552d;  /* terracotta — primary actions, highlights */
--accent-deep: #93421f;
--sage:    #6e7f5c;  /* success, completion, "done" states */
--sage-bg: #eef0e6;
--warn:    #b3402e;  /* warnings, destructive */
--warn-bg: #f6e8e2;
--gold:    #c9a86a;  /* PR moments, streaks, small celebrations */
--stone-deep:  #2c2620;  /* stone, warm neutrals from the mark — charcoal stack, dark surfaces */
--stone:       #473f36;  /* stone — flat mark, small sizes */
--stone-taupe: #7d6a56;  /* stone — capstone, quiet secondary */
--shadow-sm: 0 1px 2px rgba(72,58,35,.07), 0 4px 14px rgba(72,58,35,.07);
--shadow-md: 0 2px 4px rgba(72,58,35,.08), 0 14px 36px rgba(72,58,35,.11);
--radius: 18px;
--radius-sm: 12px;
```

Theme-color / manifest background: `#f4efe7`. Color-scheme: light. Status bar: `default`.

## Typography

- **Display: `Fraunces`** (Google Fonts, variable: opsz 9..144, wght 300..700, + italic).
  Headings, day names, big numerals (calories, weights, stat strip), section titles.
  Big numerals use `font-variation-settings:"opsz" 144` and weight 560–620.
- **Body/UI: `Schibsted Grotesk`** (400/500/700). All body copy, inputs, buttons.
- **Labels:** Schibsted Grotesk uppercase, `letter-spacing:.18em`, `font-size:.62rem`,
  color `var(--muted)` — the "PROTEIN ───" caps style. Class: `.lbl`.
- Load fonts in `index.html` from Google Fonts CDN (replaces Oswald + Hanken Grotesk).

## Texture & atmosphere

- Subtle paper grain over `--paper`: inline SVG `feTurbulence` noise data-URI, ~3% opacity,
  on `body::before` (fixed, pointer-events none).
- Cards: `--card` + `--shadow-sm`, hover/active lift to `--shadow-md` on devices with hover.
- No borders on primary cards; hairlines only inside (dividers) and on inset wells.

## Motion

- View enter: cards stagger in — `.reveal` class + inline `style="--i:0..n"`;
  `animation: rise .5s cubic-bezier(.22,1,.36,1) both; animation-delay: calc(var(--i)*45ms)`.
  `rise` = translateY(14px) + fade. Cap `--i` at ~12.
- Chips/log entries pop in with a soft scale-fade.
- Buttons compress slightly on press (`transform: scale(.97)`).
- Rest bar slides up; fill animates linearly.
- All motion wrapped in `@media (prefers-reduced-motion: reduce){ *{animation:none!important;transition:none!important} }`.

## Illustration library — `public/art.js`

Loaded via `<script src="/art.js"></script>` **before** the `js/*.js` view modules. Exposes `window.CairnArt`:

```js
CairnArt.food(text)        // → SVG string. Keyword-maps free text ("greek yogurt with berries")
                           //   to one of ~20 studio food illustrations. Always returns art
                           //   (generic plate fallback).
CairnArt.exercise(name, muscleGroup) // → SVG string. Maps exercise name to a movement-pattern
                           //   line-art figure (squat, hinge, press-h, press-v, row, pull,
                           //   curl, triceps, lunge, raise, calf, core, carry, cardio, stretch);
                           //   falls back on muscleGroup, then a generic kettlebell still-life.
CairnArt.activity(type)    // → SVG string for cardio/activity types (run, ride, swim, walk, hike, row).
```

- Every SVG: square viewBox `0 0 96 96`, no fixed width/height (CSS sizes it), drawn on a
  soft cream circle (`#efe8db`) with an elliptical studio shadow under the subject.
  Food: minimal flat-volume style (bowl/plate/glass/cup compositions) in the Atelier palette
  plus food-natural hues (salmon `#e8836a`, greens `#7d8f5e`, berry `#8e4f6d`, yolk `#e8b54a`...).
  Exercise: duotone ink line-art (stroke `#211d17`, 2.5px, round caps) with one terracotta accent
  (the barbell plate / dumbbell head / kettlebell), abstract figure (circle head + stroke limbs).
- **Never** interpolate caller text into the SVG markup — match keywords, return static strings.
- Deterministic: same input → same art.

## Component class contract

Shared layout: header is just `#header-title` (on Today it's the tappable date
control; it pins to the top of the scroll and condenses to a slim blurred band —
see `body[data-tab="today"] header.condensed` in styles.css).
Tab bar `.tabbar` / `.tab` / `.tab.active` (markup unchanged; restyled: cream blur bar,
ink icons, terracotta active with a small dot indicator; desktop ≥960px → left sidebar as today).

New/changed components (CSS must implement, app.js must emit):

- `.artile` — illustration tile: `display:grid;place-items:center`, transparent (art carries its
  own circle). Sizes: `.artile-lg` (96px), `.artile-md` (64px), `.artile-sm` (44px).
- `.lbl` — tracked caps label (see Typography).
- `.numeral` — Fraunces display numeral; `.numeral-xl` (2.6rem), `.numeral-lg` (1.6rem).
- Stat strip: `.statstrip` / `.stat` / `.stat-n` (now Fraunces numeral) / `.stat-l` (`.lbl` style).
- Today exercise card `.ex`: art thumb `.ex-art` (`.artile-sm/md`) left of `.ex-name`
  (Fraunces, ~1.15rem, weight 540); target weight as `.ex-target` Fraunces numeral;
  set chips `.chip` are cream pills; completed card gets `.ex-complete` → sage left-edge stamp
  + a small sage "✓ done" mark, slight desaturation.
- Plan tab (Program gallery): `.prog-day` card per plan day:
  `.prog-head` (day number small caps + `.prog-name` Fraunces italic + `.prog-focus` muted line),
  `.prog-strip` horizontal row of `.artile-md` art for the day's exercises (overlapping ~-10px,
  like a catalog contact strip), `.prog-list` of `.prog-row` (small art, name, `sets × reps`
  numerals right-aligned). A `.prog-edit` ghost button flips that day into the existing editor
  markup (`.pday`, `.pi-*` classes — keep them working, restyled as inset wells).
- Meal plans (Coach tab): `.mp-card`. Header `.mp-hero`: agent + status `.mp-badge` (draft/ok/off),
  daily kcal as `.numeral-xl` + `.lbl "per day"`, protein as `.numeral-lg`. Days `.mp-day`
  with `.mp-dayname` (Fraunces italic). Each meal `.meal-row`: `.meal-art` (`.artile-md` food art)
  | `.meal-main` (`.meal-name` 600, `.meal-items` muted) | `.meal-macros` right column —
  kcal numeral + tiny `P / C / F` caps figures when present.
- Finished-session **done card** `.sessiondone`: centered card with a sage `.done-mark`
  check, `.done-kicker` (`.lbl`), `.done-title` (Fraunces), `.done-chips` (cream pills:
  sets/tonnage/duration), optional `.done-notes` (italic), the `#feedbackSlot` ("how did
  that feel?"), and `.done-actions` (Log more / In your history →). No score, ever.
- History session card `.sess.hist` is tappable (`.hist-tap`, `role="button"`) → opens the
  edit overlay; a quiet `.hist-edit` caps cue sits by the weekday. Edit overlay reuses the
  `.detail` scaffold with `.ed-sets` / `.ed-exgroup` / `.edset` (inline number inputs +
  `.edset-del`) and `.ed-notes`.
- Exercise detail manage row `.detail-manage` / `.manage-row`: small `.pill-sm` pills to
  change type (reps⇄timed) or delete (`.pill-warn`). Off-plan cards reuse `.ex-skip` styling
  as `.ex-remove` (a remove ✕ before any set lands).
- Macro bars `.macrobar`: hairline track, ink fill, label left + value right (screenshot style).
- Activity entries `.qlent`: small `.qlent-art` (CairnArt.activity) + text + enrichment badge.
- Buttons: `.logbtn` terracotta ink-on-cream → solid terracotta circle/pill, cream glyph;
  `.ghostbtn` hairline pill; `.draftbtn` hairline terracotta text pill.
- Chat `.bubble.user` = ink on `--ink` (cream text); `.bubble.assistant` = card.
- Keep ALL other existing class names working (`.sess`, `.modal*`, `.heat*`, `.vol*`, `.mem*`,
  `.hdoc*`, `.life*`, `.enr*`, `.seg*`, `.daybtn`, `.logrow`, `.field`, `.toast`, `.rest*`,
  `.ob-*`, `.agentrow` family) — restyled to the Atelier language, same selectors.

## Hard rules

- `public/` stays dependency-free vanilla JS — no build step, no frameworks, no external images.
- All server-supplied strings rendered into `innerHTML` go through `escHtml`/`escAttr`.
- Don't break behavior: every element id, `data-*` attribute, and event-wiring pattern in
  `app.js` is functional. Polling (`pollToken`), rest timer, day switcher, editor, onboarding —
  all must keep working.
- Light theme only. `color-scheme: light` (date inputs etc. follow).
- **Dates read human, never raw.** Don't surface bare `YYYY-MM-DD` in UI copy. Three date helpers,
  one per context:
  - `humanDate(iso)` → "today" / "yesterday" / "3 days ago" / "2 weeks ago" / "Apr 2024" (relative
    when recent, month-year when old). Used for the `.hpic-asof` "As of …" caption and for
    humanizing dates that appear inside coach/review prose.
  - `relAge(iso)` → "today" / "N days ago" / "N weeks ago" / "N months ago" / "a year ago" /
    "N years ago" — never falls back to a bare month-year. Used for **reading/marker recency**,
    where "3 months ago" reads warmer than "Apr 2024". Always pair it with a `title="${absDate(iso)}"`
    tooltip so the exact date is one hover away (relative-by-default, precise-on-demand).
  - `absDate(iso)` → full "June 11, 2026" — for those `title=` tooltips only.
  Coach/review prose runs through `humanizeReviewText(text, latestISO)`, which strips the
  most-recent panel date (shown once as the `.hpic-asof` "As of …" caption) so it isn't restated
  on every line, and humanizes any remaining ISO dates. Status timestamps stay on `relTime()`.
- **Action pills share one size.** Footer/action-row pills match the `.pillbtn`/`.ghostbtn`
  family (`padding:8px 14px`, `font-size:~.72rem`, ~33–34px tall); pair them with a height-matched
  `.iconbtn`/delete (34px) so the row sits on one baseline. Divider-separated sections (`.hdoc-foot`,
  `.himpacts`, `.mp-history`) use `margin-top:~16px; padding-top:14px`. Don't ship a one-off smaller
  pill — it reads as squashed next to the rest of the system.

## Motion tokens

One easing family, three speeds — defined in `:root`, used everywhere. Nothing snaps.

```css
--ease:  cubic-bezier(.22,1,.36,1);  /* the house curve — settle, don't bounce hard */
--dur-1: 200ms;   /* presses, hovers, small state flips */
--dur-2: 320ms;   /* segmented thumbs, sheets, overlays, view transitions */
--dur-3: 450ms;   /* list entrances, bars growing, photo fades */

/* tactile press — one intentional depth scale, keyed to target size.
   The press deepens as the target shrinks so it reads at any size. */
--press-lg: scale(.99);   /* large surfaces — cards, rows, tap-entries */
--press:    scale(.97);   /* standard — buttons, pills, day/seg buttons */
--press-sm: scale(.94);   /* compact action buttons */
--press-xs: scale(.9);    /* tiny icon buttons — ×, dots, swatches, chevrons */
```

The motion vocabulary on top of the existing `.reveal` stagger:

- **Count-up numerals** — `countUp(el, target)` in app.js eases big figures from 0
  (cubic ease-out, ~750ms). Markup contract: `data-cu="<number>"` (+ optional
  `data-cufmt="k"` for humanized `12.4k`) and a `runCountUps(scope)` call after render.
- **Bars grow to width** — give any `.volbar-fill`/`.macrobar-fill` the `.barfill` class;
  `@keyframes bargrow` animates from 0 to the inline width on first paint.
- **Sliding seg thumb** — `segBar()` emits `.seg.seg-sliding` with a `.seg-thumb` pill
  positioned by `--segn`/`--segi`; `wireSeg` updates `--segi` on tap and swaps the
  sub-view inside a view transition. Hand-built segs (onboarding) keep the classic
  background-swap active state — only `.seg-sliding` suppresses it. The thumb math
  assumes equal-width segments, so when a bar's pills won't fit (`fitSeg` measures
  `scrollWidth > clientWidth`) it adds `.seg-scroll`: the bar scrolls horizontally
  with content-width pills and the thumb yields to the solid active-pill background.
  Never clip the last pill — overflow always scrolls.
- **Finish micro-exit** — `@keyframes slideOut` (`.slide-out`, `--dur-2`) lifts the
  finished logging surface away (translateY + fade) before Today re-renders to the
  calm `.sessiondone` "done" card, which reveals in. Reduced-motion-gated in JS.
- **View transitions** — `withViewTransition(fn)` wraps tab and sub-view swaps in
  `document.startViewTransition` when available (instant fallback otherwise; disabled
  under reduced motion). Shared-element zooms use the `detail-art` view-transition-name
  (tapped tile ↔ overlay art) and `seg-thumb` for the segmented pill.
- **Toast** slides up + settles (`translate(-50%,14px) scale(.97)` → identity).
- **Tactile press** — every interactive surface compresses on `:active` using the
  `--press*` scale tokens above, never an ad-hoc literal. Pick by target size:
  `--press-lg` for cards/rows/tap-entries, `--press` for buttons/pills/day+seg
  buttons, `--press-sm` for compact action buttons, `--press-xs` for tiny icon
  buttons (×, dots, swatches, chevrons). This is the single load-bearing
  micro-interaction — a finger-following 1:1 response, so it is deliberately
  **kept under reduced motion** (it's affordance, not decoration); only the
  decorative entrances/loops/transitions are silenced.
- **Hover lift** (devices with `@media (hover:hover)` only) — cards and tap targets
  raise `--shadow-sm → --shadow-md`; pills/buttons tint their accent. Never on touch,
  where the press scale carries the feedback.
- Everything decorative dies under `@media (prefers-reduced-motion: reduce)`
  (`*{animation:none!important;transition:none!important}`, then a curated set of
  slowed loading indicators + functional transitions restored); JS checks
  `reducedMotion()` before count-ups, view transitions, and parallax.

## Loading & progress — one calm "an agent is thinking" vocabulary

Reached for by **every** surface where an operation can exceed ~400ms (agent
calls, day-reads, drafts, reviews, history fetches), so "working" always reads
the same warm way. Defined in `styles.css` + `app.js` helpers; never hand-roll a
one-off spinner. Motion is slow and legible under `prefers-reduced-motion`.

- **`.aspin`** — the calm spinner ring; size via `--asz` or `.aspin-sm` / `.aspin-xs`,
  and `.aspin-ghost` on a dark/terracotta button. The single in-flight glyph.
- **`btnBusy(btn, label, {ghost})`** — swaps a tapped button's label for an `.aspin`
  ring + working text (footprint pinned so nothing jumps); returns a `restore()`.
  The default for any button that kicks off an agent op (session-suggest, meal
  draft, nutrition check-in, recipe, health refresh).
- **`.is-thinking`** — an indeterminate terracotta→gold filament that sweeps a
  surface being (re)generated (e.g. the Brief reshaping on an override chip).
- **`.typing`** — three breathing dots for the chat reply; the pending assistant
  bubble renders an optional caption + `.typing`.
- **`loadingState(label)`** → `.loadstate`: a centered `.aspin` + Fraunces-italic
  label for a whole region that's fetching/thinking — the one case the inline
  pieces above don't cover (the chat log hydrating, the history overlay loading).
- **`.hshimmer`** — the shimmer skeleton placeholder (Health-view picture build).
- **`.is-thinking--determinate`** — the `.is-thinking` filament becomes a
  left-anchored progress fill driven by a `--frac` custom property (0..1), same
  gradient/glow family as the indeterminate sweep. The job runner sets `--frac`
  from real `phase` fractions (`job.meta.frac = {done, total}`). Reduced motion →
  the fill jumps to its width (transition killed), no sweep.
- **`thinkingCaption(el, op)`** — rotates a curated, op-specific script through `el`
  (~2.6s/line, the chat `.typing-cap`/`capfade` crossfade), looping the tail;
  returns `stop()`. Replaces a static "Drafting…/Reading…" line on a long-op anchor
  with evolving copy. Scripts live in `THINKING_SCRIPTS` (`session_suggest`,
  `meal_plan`, `recipe`, `nutrition_checkin`, `day_read_override`, `chat_distill`,
  `insight`). Under reduced motion it shows line 1 statically. The host carries a
  `.job-cap` (or `.typing-cap`) slot for it to write into.

## Instant, alive: SWR cache + durable agent jobs

The spine that makes the app feel instant. Two client layers (in `public/js/`),
both generalizing proven code (`upgradeBriefInPlace` + the chat SSE client):

- **Stale-while-revalidate** — `peekCached(key)` / `cachedApi(path,{key,freshFor,
  onUpgrade})` / `paintSWR({key,path,peek,render,token})` / `swrInvalidate(keyOrPrefix)`
  / `swrSweep()`. A surface paints **real last-known content instantly** (skeleton
  only on a true cold start), then revalidates in the background and upgrades in
  place **only when the JSON payload changed**. Both tiers (in-memory Map over
  `localStorage` `cairn.swr.v1.<key>`) are JSON-only — never cache DOM; rendering
  still flows through `escHtml`/`escAttr`. A stale paint flies the **`.swr-refreshing`**
  hairline (`body.swr-busy::after` — a calm low-opacity top filament, distinct from
  the `.offline-bar` warn band; reduced motion → a static tinted 1px border). A
  mutating write that changes a surface calls `swrInvalidate(key)` so the next paint
  refetches (the role `state.brief = null` plays for the Brief). **`SWR_NS`**
  (`"cairn.swr.v1."`) is the version segment — bump it in lockstep with any
  payload-shape change so old cached bodies are dropped.
- **Durable agent jobs** — the kind-agnostic counterpart to the chat-turn client:
  `enqueueJob(path,body)` / `openJobStream(id,handlers)` / `jobReconnect()` /
  `teardownJobs(pred)` / `runOp(kind,body,{path,anchor,render,onFail,caption})`.
  A heavy/agentic op is a server-side job streamed for evolving progress; it
  survives a tab switch / reload / restart (`jobReconnect()` re-attaches via a
  stable `data-job-anchor="<kind>"`, rebuilding handlers through a
  `registerJobReconnector(kind, factory)` for ops that should resume after a
  reload). A SEPARATE `jobStreams` map keeps the single chat `EventSource`
  untouched. **`runOp`** is robust to the server's `bg_ops_enabled` toggle: the op
  POST returns `{ok, job}` (background — stream it) or a legacy inline result (no
  `.job` — render now), and the `done` event's `result` is byte-for-byte the object
  the endpoint returned synchronously before, so the `done` render reuses the old
  await-path render verbatim.

## Progressive artwork — `artImg()`

The bridge from illustration plates to Morsel-style studio photos. Server contract:
`GET /api/art?kind=food|exercise|activity&q=<text>` → `200 image/*` when a generated
image is cached, `204` when not (the 204 itself enqueues background generation).

`artImg(kind, q, cls, svg?)` renders the CairnArt SVG **instantly** inside
`.artile.artimg`, layered with an `<img class="artimg-photo">` that fades in
(`opacity` + tiny `scale` settle, `--dur-3`) on `load`. A 204 or failure fires the
img error path: the photo stays invisible, the SVG plate remains — no flash, no broken
icon. One quiet retry fires ~20s later, guarded by `pollToken`. Photos are round-cropped
(`border-radius:50%`) so they sit on the same circular plate language as the SVGs.
The `q` is `encodeURIComponent`-ed and capped at 120 chars; alt text is escaped.
`settings.art_enabled` (Settings → "Artwork generation") gates the whole layer —
off means SVG-only, zero requests.

## Detail overlay anatomy — `.detail`

Full-screen item view (food note, exercise), opened with a shared-element zoom from the
tapped tile (`openDetailFrom(tile, build)`) and closed by ✕ / Escape / backdrop / pills
(`closeDetail()` — also called on every tab switch so overlays never leak).

```
.detail                fixed, z-70, paper
├ .detail-bg           blurred scaled photo (when cached) under a cream gradient wash
├ .detail-x            floating close button (top-right, safe-area aware)
└ .detail-scroll       centred column, max 560px
  ├ .detail-art        hero plate: artImg artile-xl · view-transition-name: detail-art
  │   └ .detail-art-zoom   wheel/pinch "lean in" zoom (CSS transform, clamped 1–2.2)
  ├ .detail-title      Fraunces ~1.8rem
  ├ .detail-ctx .lbl   tracked caps context ("19% of the day · 20:01" / muscle group)
  ├ .detail-kcal       .detail-num count-up numeral + .detail-unit label
  ├ .detail-spark      tiny terracotta sparkline (est-1RM trend / durations)
  ├ .detail-macros     .macrobar rows, hairline .barfill bars animating to width
  ├ .detail-section    .lbl heading + .detail-body copy / .detail-setline rows
  └ .detail-actions    .pillbtn row (.pill-warn destructive, .pill-accent primary)
```

The art drifts idly (`@keyframes drift`, 6.5s alternate) and parallaxes on overlay
scroll (translate + fade, JS, reduced-motion-gated). `.prbadge` is the gold PR pill.

## Meals planner (Plan tab · Meals)

The journal view over the current weekly meal plan (prefers an accepted/applied/kept
plan, falls back to the newest draft):

- `.mealhero` — week-of label + `.mp-badge` status + agent, count-up `daily_kcal` /
  `daily_protein_g` numerals, summary line, Keep/Discard `.pillbtn` row for drafts.
- `.mealday` — one section per day: `.mealday-head` (tiny caps date + `.mealday-name`
  big Fraunces day name, per-day kcal/protein `.mealday-total`) over a `.mealday-card`
  of `.meal-row`s (artImg food plate | name + items | kcal numeral + P/C/F caps).
- `.meals-empty` — illustration plate + italic Fraunces title + "Draft weekly meal plan"
  CTA (`.meals-cta`), with `.meals-status` for run feedback.
- `.mp-history` — `<details>` keeping the classic `.mp-card` list as collapsed history.
- `.shop-chips` — the plan's shopping list as cream chips.

## Timed exercises

- Encoding: a set with `duration_sec` (weight/reps null) is a timed set; an exercise's
  `mode:'timed'` or a plan item's `target_seconds` flips the card. Durations render as
  `m:ss` (`fmtDur`) everywhere — chips, history, plan gallery (`3 × 0:45`), detail view
  (best duration instead of est-1RM). Timed sets never count toward tonnage.
- Logging row swaps WT/REPS/RIR for one `.in-dur` input accepting `90`, `1:30`, or `2m`
  (`parseDur`), normalised back to `m:ss` after each log.
- The "+ Add exercise" form carries a Reps/Timed `.addex-mode` toggle (`.modebtn`).

## Stat strip (Today)

Five `.stat` cells — sessions · 7d, **lb moved · 7d** (humanized `12.4k`), sets · 7d,
day streak (flame in `.stat-flame`), and the bodyweight quick-add chip. All numerals
count up on render via `data-cu`.

## Marker trends (Me → Health → Markers)

Lab markers read as a grouped catalog, fed by `GET /api/markers/priority` (the superset that
carries optimal bands + group + trend on top of the flat marker shape). Each marker carries
`group`/`group_label`; the response's `groups` array is the canonical, ordered list of health
groups present, and headers render in that order. Markers within every group use a clinician-style
scan order first (CBC-like rows together, CMP-like liver/kidney rows together, standard lipid panel
before ApoB/Lp(a) and advanced lipoprotein details), then fall back to server order for unknown
markers. LDL-C and direct LDL-C remain separate rows with a local note when both are present.
**Never a numeric grade/score anywhere** — the constitution bans 0–100 grades; markers speak in
position-vs-optimal and direction only.

- `.hmk-groups` — vertical stack (gap 18px) of `.hmk-section` health-group sections; desktop flows
  those sections into two columns.
- `.hmk-grouphead` — `.lbl` caps section heading per group ("Lipids & Cardiovascular", "Metabolic
  & Glucose", "Iron & Red Blood", …) in `--ink-2`. It is sticky below the Health segmented controls
  so a long scroll always keeps the current clinical panel visible.
- `.hmk-groupnote` — a short muted panel note, used sparingly. The lipid group uses it to explain
  why standard LDL-C and direct LDL-C are shown as separate assays rather than merged.
- `.hmk-subhead` — uppercase inline row divider inside a ledger card. Only used where it improves
  scan speed, currently lipids ("Standard lipid panel", "Atherogenic particle risk", "Advanced
  lipoprotein detail").
- `.hmk-card` — one ledger card per group, holding `.hmk` rows. `.hmk-row` is a `<button>`
  (`aria-expanded`) when the marker has ≥2 numeric readings, else a static row. `.hmk-id` stacks
  `.hmk-name` over `.hmk-when` (relAge recency, `title=absDate`); `.hmk-right` carries the delta
  arrow `.hmk-delta`, the latest `.hmk-val` + `.hmk-unit`, and the `.hmk-chev` disclosure.
- Tapping opens `.hmk-panel` (grid-rows `0fr`→`1fr`) into the inline **progress chart**
  (`markerChartSvg` + `markerPanelHtml`) — a hand-built SVG, no library, in the house line style:
  - `.hchart-band` — the optimal-zone band shaded (sage @ ~14%), folded into the y-domain so it's
    always on-screen even when every reading sits outside it.
  - `.hchart-line` — a Catmull-Rom ink curve that draws on open (`sparkdraw`, reduced-motion-gated).
  - `.hchart-dot` — every numeric reading as a flag-tinted dot (warn `#b3402e` / sage `#6e7f5c`).
  - `.hchart-txt` — date labels at the axis ends (`sparkDateLabel`).
  - `.hchart-latest` — the latest value + relAge recency callout above the chart.
  - `.hchart-cap` — sentence-case caption (NOT `.lbl`) under the chart: optimal band + the trend in
    plain words ("optimal 40–80 mg/dL · rising over ~14 mo") from the server `trend` (`markerTrendWord`).
- The Brain tab's "what matters now" list (`.hb-mk`) keeps the compact generic `sparklineSvg()`;
  the richer `.hchart` is the detailed Markers-tab view. The two are intentionally distinct surfaces.

## Health sharing (Me → Health → Share)

Share is the utility shelf for moving data out of Cairn or cleaning the imported corpus. Keep it
separate from Markers so the detailed lab-history catalog stays scan-led.

- Lead with the doctor-facing clinical marker report (`GET /api/health-report`) because it is the
  human artifact: grouped clinical panels, findings first, dated history, DEXA when present, and a
  MyChart-ready text copy. The report opens from an about:blank new tab so the PWA stays in place,
  then the new tab navigates to the printable HTML/PDF surface.
- Keep structured JSON export (`GET /api/health-export`) secondary. It is for tools/imports, not the
  default physician handoff.
- Keep data-maintenance actions here too, currently "Align lab names" (`POST /api/markers/reconcile`).
  It affects how future marker trends group, but it is not part of reading today's health picture.

## Chat tab

A crafted chat surface, not a form. Layout + behavior contract:

- **Flex viewport column.** `.chatview` (`display:flex;flex-direction:column`, height
  set live by `measureChatTop()`) holds `.chatlog-wrap` (`position:relative`, flexes) over
  `.chatdock` (`flex:0 0 auto`). The log is the ONLY scroller; the composer dock is always
  the bottom row, so the input bar **can never scroll off** — even under iOS Display Zoom /
  Larger Text. The height is re-measured on every viewport shift (zoom, keyboard,
  orientation, resize) via `visualViewport`, so it's robust, never a magic number. The CSS
  `height:calc(100dvh - 240px)` on `.chatview` is only the pre-measure default.
- **Shell-first.** `renderChat()` paints the shell (composer usable immediately) and shows a
  `loadingState` in the log, THEN hydrates `GET /api/chat` in the background (`pollToken`-guarded).
- **Bubbles.** `.bubble.user` = ink-on-`--ink` (cream), `.bubble.assistant` = card. Live turns
  enter with `.bubble-in` (scale-fade). Consecutive same-role turns **group**: `.cont` tightens
  the top, `.grouped` squares off a non-last bubble's tail; only the run's last bubble keeps the
  tail + a subtle `.bubble-time` (clock time, side-aligned). A pending assistant turn early-returns a
  caption + `.typing` dots (no time/copy). Assistant replies carry a hover/long-press copy
  (`.bubble-copy`), applied actions render as sage `.bubble-tag` pills, drafts as `.draftbtn`.
- **Jump-to-latest.** `.chat-jump` floats bottom-right of the log when scrolled up >120px.
- **Header cluster.** `.hdr-chat-actions` (anchored to the `position:relative` header) holds a
  `.hdrcircbtn` history/search button + the `.freshbtn` fresh-start (distill & archive). Both are
  removed by `renderTab` on tab leave.
- **History overlay.** `openChatHistory()` opens the read-only `.detail` scaffold with a search box
  (`/api/chat/search`) over past conversations (`/api/chat/sessions`, grouped by `archived_at`).
  Tapping a session/hit renders that conversation read-only (`appendMsg(..., {readonly:true})` into a
  `.chat-hist-convo`). Nothing is ever hard-deleted; this only reads. Gotcha: `.chat-hist-convo` lives
  inside `.detail-scroll`, which is a `text-align:center` column and the page's real scroller — so the
  convo must reset `text-align:left` (else bubbles render centered) and must NOT inherit `.chatlog`'s
  `overflow/overscroll` (as a no-room scroll container those swallow the touch gesture and nothing
  scrolls). Both are pinned on `.chat-hist-convo` in `styles.css`.
