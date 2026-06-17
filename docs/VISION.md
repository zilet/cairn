# Cairn — Vision & Execution Plan

> A strategic north-star and a runnable execution plan for Cairn: a **personal wellness, longevity,
> and life-optimization buddy** that understands you, points at what needs attention and the way
> there, helps change stick — and otherwise **stays out of the way**.
>
> The governing image: a **daily driver**. The car you trust and use every day, where **you drive**.
> A calm dashboard that's glanceable and quiet, with a warning light only when something genuinely
> needs attention; a wise navigator who says "go this way" at the fork that matters and is silent on
> the straightaways. Not an app that pings you, gamifies you, or buries you in features.
>
> This document is meant to be **executed against**, in priority order, ideally by parallel agent
> teams. Read `CLAUDE.md` and `docs/DESIGN.md` first — they are the contracts every phase honors.

---

## 1. North Star

**Cairn is the one place that quietly understands your whole picture — body, training, food, labs,
sleep, and life — and, when you come to it, tells you the one thing worth doing today and the way
toward where you're going. Then it gets out of your way.**

A cairn is a stone marker on a trail. It doesn't walk for you and it doesn't shout. It sits quietly
and tells you *you're on the path; this way next*. That restraint is the product.

It is a **buddy, not a boss**. A peer who happens to be very smart about health and longevity, who
knows you, who's playing the decades-long game with you, and who only speaks up when it helps. It
optimizes for the long run — sustainability over intensity, consistency over heroics. It would rather
you do the right easy thing for ten years than the perfect brutal thing for three weeks.

And **you drive.** It navigates; you steer. It proposes; you decide. It never auto-applies, never
overrides you, never guilt-trips you toward compliance. The relationship is trust, not pressure.

This is **your own Jarvis** — a private, deeply personal health-and-body-and-longevity intelligence that
works *with* you. It is not a product built for a market, and it carries none of a market product's
habits: no nudges, no engagement loops, no retention tricks, no upsell, no "have you tried…" It assumes a
capable, self-directed owner who knows exactly why they're here. Its only job is to be *intelligent on your
behalf* and *instantly responsive to your direction* — to think deeply across your whole picture and then
do what you ask, the moment you ask it.

---

## 2. Operating principles (the constitution)

These are load-bearing. Every feature, screen, and prompt is judged against them. When a principle and
a feature conflict, the principle wins.

1. **You drive.** The app is the navigator and dashboard; you are the driver. It surfaces, suggests,
   and proposes — you choose. The existing **propose → review → apply** loop is the literal embodiment
   of this and must remain the spine. Nothing plan-affecting or clinical ever auto-applies. And **every
   read is only ever a suggestion** — never a gate, never imposed. From anywhere it offers, you can
   wave it off and go your own way in one move: do something else, log anything, explore your data, add
   to the plan, **ask it for a session right now**, or **pull your planned workout back in**. The smart
   default is pre-chosen for you; the wheel is always yours.

2. **Calm by default.** Quiet reassurance is the *normal* state. On a day when all is well, the app
   should be nearly silent — "you're good, here's your session" — not a wall of metrics to interpret.
   The amount of interface scales with how much there genuinely is to say. (Apple Vitals' "only
   interrupt when something actually deviates" is the doctrine, applied everywhere.)

3. **No nudging. No pressure. No games.** No streaks, no points, no badges, no manufactured urgency,
   no "you haven't opened the app in 3 days." It does **not** engineer engagement. It earns being
   opened by being *useful when opened*. **Push notifications default to off** — the only ever-justified
   push is a genuinely time-sensitive thing the user opted into (e.g. "your ferritin retest is due"),
   delivered rarely, in a friend's voice, never as a nag.

4. **Restraint over features.** It does not offer you everything it can do. Capability is not the same
   as surface. Complexity stays hidden until it's relevant; the default screen is minimal. We resist
   feature-creep as a matter of taste — an overwhelming app is a failed app, however capable.

5. **Smart and pointed.** When it does speak, it points at the *one* thing that needs attention and the
   *concrete* way there — not a dashboard to decode. Synthesis, not data. If it can't turn a number
   into a decision, it doesn't show the number.

6. **It reads your patterns and suggests the day.** It's genuinely agentic: it looks at your recent
   training, rest, recovery, and life, and *forms a view of what kind of day this could be* — rest, easy
   movement, or a real session — and opens with that. But it's an opening suggestion, not a verdict: it
   does not mechanically open a full lifting plan every morning, and it never insists on rest either. Ask
   it for a session and it builds one on the spot; want your planned workout instead — it's one tap away.

7. **It understands you, and keeps understanding.** Memory is the relationship. It remembers your
   injuries, your kids, that you train fasted, that your ferritin ran low — and gets to know you a
   little better over time. That accumulating understanding is what makes the quiet pointing
   trustworthy instead of generic.

8. **Change sticks through trust, not coercion.** Adherence here comes from three calm sources: the
   right thing is the *easy* thing (friction removed), you can *see honest trajectory* (you're moving),
   and a buddy who *knows you* is in the passenger seat. Never from guilt, streaks, or fear of breaking
   a chain.

9. **Kind, and never anxious.** Rest is wisdom, not failure. A bad week resets nothing. A low signal is
   information, never a verdict — and your felt experience always overrides the number. Health findings
   are informational, not medical advice; anything clinical defers to a clinician.

10. **Your assistant, not a product.** This is a private system tuned to one person — a Jarvis, not an app
    chasing a market. It has no growth metrics to serve, no one to retain, nothing to sell. So it never
    behaves like a market product: no nudges, no streaks, no upsell, no "engagement," no feature-pushing.
    It works *with* you and *for* you — deep intelligence on your side, instantly responsive to what you
    ask, and otherwise quiet.

11. **One brain — everything connects, grounded in evidence.** This is what *agentic* truly means here:
    nothing is siloed. Every signal feeds one reasoning brain that pushes each important finding into every
    domain it touches. A bloodwork result changes your meals, your training, and what to watch —
    automatically: high LDL/ApoB tilts meals toward fish & poultry and more soluble fiber while training
    notes the cardiovascular angle; low ferritin caps endurance volume and watches fatigue; a pattern like
    a high running heart rate is connected to the labs that explain it. And it is **grounded in current
    clinical evidence** — when a finding matters or the right move is uncertain, the brain researches
    deeper, recalculates everything it affects, and writes a clear, cited note on what changed and why, for
    you to review. (See *The connected brain*, §5.)

12. **Capture is effortless — even by voice.** Logging must feel optimal and almost frictionless: a photo, a
    tap on a time-of-day regular, a typed phrase, or — **just saying it out loud** ("logged a 40-minute
    ride, easy; chicken and rice for lunch"). The brain parses, structures, and refines it in the
    background; you say the messy human sentence and it does the rest. If capture ever feels like work,
    that's a bug.

13. **It meets you in your sport.** Cairn adapts to your *primary discipline* — strength, endurance
    (running, riding, rowing…), or a hybrid of both — and it is neither a lifting app with cardio bolted
    on nor a running app that ignores the gym. It speaks the language of whatever you actually train: for
    a runner it thinks in easy / long / tempo / interval days, weekly mileage, pace, and time-in-zone; for
    a lifter, in sets, load, and the slow climb of a working weight; for a hybrid, both at once, balanced
    against recovery. The day's suggestion, the plan, progress, fueling, and the connected brain all
    reshape around the sport you're in — because the same calm pointing only earns trust when it's
    pointing in *your* terms. (Endurance is a modality to *program*, not merely a volume to cap.)

---

## 3. Where Cairn stands today (honest assessment)

Cairn is top-decile on **craft and architecture**. The gap is not capability — it's that the
quiet-intelligence layer hasn't been built. We have world-class plumbing and a world-class design
system wrapped around a logging app that doesn't yet read your day.

### Genuine strengths (do not rebuild these)

- **Elite design system.** The "Atelier" language (Fraunces + Schibsted Grotesk, warm-paper theme,
  view-transition shared-element zooms, count-up numerals, progressive SVG→photo artwork, reduced-motion
  discipline) is better than most funded health apps. `docs/DESIGN.md` is a real frozen contract.
  **This is a moat. Protect it.** Its calm, editorial restraint is *already* the right aesthetic for a
  stay-out-of-the-way buddy.
- **Two surfaces over one repo.** `api.ts` (REST) and `mcp.ts` (MCP) are thin mirrors over `repo.ts`,
  so the buddy is reachable from the PWA *and* from any MCP client on the tailnet.
- **Propose → review → apply is exactly right.** Coaching never auto-applies; drafts are reviewed. This
  is "you drive" already in code. We have the hard part.
- **`getCoachContext()` is the "inject real data before generation" pattern** — the single biggest lesson
  from studying Whoop Coach / Oura Advisor (both felt generic until grounded in the user's own data).
  Cairn already feeds profile + goal + plan + sessions + activities + Garmin recovery + memory + health +
  life-context into every coaching call. **This is the differentiator.**
- **The understanding layer exists:** `memory` (editable facts), `context_events` (trips/injuries/life
  the coach plans around), `health_documents` + marker history + `health_reviews`. Most products would
  kill for this.
- **The enrichment pipeline** (instant offline save → background agent refine → poll-and-upgrade) is the
  right substrate for invisible capture (photo-macros, fast logging).
- **Recovery data is already flowing.** `garmin_daily_metrics` ingests sleep, HRV, resting HR, body
  battery, stress, steps; `getGarminCoachSummary()` already summarizes it. **Reading your day is a
  synthesis problem, not a data-collection problem** — the highest-leverage unlock in the codebase.

### The core gap

**Today opens into a ledger, not a buddy.** The Today screen leads with last week's adherence and pace,
a wearable strip, a quick-log box, a day switcher, then exercise cards — and it silently assumes every
day is a lifting day (it just picks a plausible plan day). It's a lovely place to *record* and *check
trajectory*, but it never reads your situation and says "today's a rest day," or "you're good — lower
body, go," or "rough night; keep it easy." It doesn't judge the day. It doesn't point. It doesn't stay
out of the way — it presents the same full logging surface every morning regardless of whether that's
what the day calls for.

---

## 4. What the best do — what to adopt, what to refuse

Distilled from a deep study of ~30 products (Whoop, Oura, Apple Vitals, Garmin, Eight Sleep, Athlytic,
Gentler Streak; MacroFactor, Cronometer, Lose It, ZOE, Levels, Lumen; Fitbod, RP, JuggernautAI, Future;
Function Health, InsideTracker, Superpower; Cozi, PlateJoy; Duolingo, Strava, Rise, Finch).

### Refuse (the engagement-industrial complex — against our principles)
- **Streaks, points, badges, leaderboards** (Duolingo, Snapchat, Apple rings' guilt). Manufacture
  pressure; research links streak structures to measurable physiological stress and the "what-the-hell"
  collapse after one miss. *We don't build these.*
- **Push notifications as a retention lever** (Duolingo's bandit, Whoop's check-ins). Health is the
  lowest-tolerance vertical; a nag reads as the most-blocked kind of message. *Default off.*
- **Score anxiety / orthosomnia** (Whoop/Oura/Garmin's number-first framing). A scary 0–100 number you
  must interpret is the opposite of calm. *We lead with plain-language state, not a score.*
- **Metric sprawl** (Garmin's wound) and **feature bloat**. *One thing that matters, ruthlessly chosen.*
- **Anything that serves the product over the person** — upsell, "have you tried…" feature-pushing,
  onboarding completion bars, growth/retention mechanics. There is no market here; there is one owner.
- **CGM/glucose-score perfectionism** (Levels, ZOE) — flagged by dietitians for fostering food anxiety.

### Adopt (the mechanics that fit a calm buddy)
- **Read the day, then lead accordingly** (Garmin Morning Report; Whoop Recovery → Strain target). But
  *calmer*: a synthesized state and one focus, surfaced when you open the app — not pushed at wake.
- **Relative-to-your-own-baseline, never population** (Oura's banded contributor bars; Apple Vitals'
  Typical/High/Low vs *your* 7-day norm). "Within your own normal?" is the anti-anxiety framing.
- **Compassionate, non-shaming voice as a feature** (Gentler Streak: "rest is not quitting"). Rest is a
  legitimate, tracked, good state — not a gap.
- **Adapt to reality from real data, quietly** (MacroFactor's adherence-neutral expenditure loop: derive
  true TDEE from your weigh-ins + intake, re-target weekly, *regardless of whether you "were good"* — no
  red numbers, no good/bad foods). The adjustment surfaces *as a proposal you review*, calmly.
- **Autoregulation** (RP/Juggernaut: RIR → load, soreness/performance → volume; AMRAP → next block). The
  feedback that lets a plan bend to a real human. Caution: Fitbod's ML optimizing "freshness" *fights*
  progressive overload — recovery *informs* selection, never drives it.
- **Prioritize, don't dump** (InsideTracker's Impact Score; red-first sort; optimal zones vs clinical
  ranges; organ-system grades). 100 markers → the 3 that matter, with the way there.
- **Personal, not generic, AI** — inject the user's real numbers (✅), speak in deviation from *their*
  baseline, keep an **editable memory** (Oura Memories ≈ our `memory` ✅), surface the one cross-domain
  connection they couldn't make ("low ferritin + 4-week volume drop → likely iron-limited").
- **Family & time as context, not features** (Cozi/PlateJoy): kids' schedules the buddy plans *around*;
  "20 minutes today" reshapes the session; family dinner stays one dish, you adjust at the plate.
- **Invisible capture** (photo→macros as an *editable draft*; time-of-day frequent foods; natural
  language) — the less time you spend logging, the more it stays out of the way.

---

## 5. The daily experience

The product is felt as a **calm, pull-based loop**: you come to it; it shows you where you stand and the
one thing worth doing (or that today is rest); you act, logging with near-zero friction if you do; over
time it understands you better and points more precisely; and when something needs attention, it's
*there waiting for you*, surfaced quietly — never pinged at you.

### The soul: day intelligence

The heart of the whole product is a single agentic judgment, made fresh each day from everything in
`getCoachContext()` — recent training and rest, recovery signals (if present), what's programmed, days
since each movement pattern, life context — answering: **what kind of day should this be?**

- **Train day** (recovered, due, it's a programmed day) → it gets out of the way and drops you into the
  plan. *"Lower body. You're good — it's been two days. Go."* Minimal words, straight into the session.
- **Rest day** (several hard days running, recovery down, or scheduled rest) → it does **not** open a
  lifting plan. *"Rest today. Four sessions in five days and your sleep's been short — let it
  consolidate. A walk if you feel like it, nothing more."* It actively protects rest.
- **Easy / active-recovery day** (a bit run-down, or you've been sedentary) → it suggests easy movement
  instead of a hard session. *"Take it easy — a walk or some mobility. We'll hit legs tomorrow when
  you're fresher."*
- **Off-pattern** (you usually train today but haven't; back from travel) → it gently notices and offers,
  never insists.

This is the "really agentic" core: the buddy *looked at everything and made a call*, the way a friend
who knew your week would — not a fixed plan rendered on a schedule. It's a judgment, surfaced for you to
accept or override (you drive).

### The connected brain (cross-domain, evidence-grounded)

The deepest sense of *agentic* here: **one brain reasons over your whole picture and pushes every important
finding into every domain it touches** — then grounds itself in current clinical evidence and shows its
work. Nothing is siloed; a result in one place rewrites the others.

The flow, concretely:
1. **A finding surfaces** — from labs, a wearable pattern, a logged symptom, or a trend: *LDL/ApoB high*,
   *ferritin low*, *fasting glucose creeping up*, *resting and running HR elevated*, *vitamin D low*.
2. **The brain weighs it and decides whether to dig deeper.** For anything consequential or uncertain it
   **researches the current clinical evidence** (latest guidelines/literature) rather than trusting stale
   assumptions — and keeps the citation.
3. **It propagates the consequence and recalculates everything it touches:**
   - *Nutrition* — a derived directive enters the meal prompt ("emphasize oily fish & poultry over red
     meat, raise soluble fiber, cap saturated fat" for high ApoB; "iron-rich foods paired with vitamin C"
     for low ferritin), and targets/recipes recompute.
   - *Training* — caps and watch-items adjust ("low ferritin → hold endurance volume, watch fatigue";
     "elevated running HR → bias a zone-2 base, flag if it persists").
   - *The day-read and what-to-watch* update, so the change appears where you'll actually see it.
4. **It writes a clear, cited note** — "moved your protein toward fish & poultry because ApoB came back
   high (per current lipid guidance); revisit at the next panel" — into the health review / memory, so the
   reasoning is transparent, revisitable, and feeds the next cycle.
5. **You review and apply.** Nothing silently rewrites your plan; the recalculation arrives as a proposal,
   annotated with *why* (you drive).

Architecturally this is a **derived-directives layer**: findings → (optional research) → structured
cross-domain directives that `getCoachContext()` carries into the meal, training, and day-read prompts,
plus a human-readable cited note. It extends the existing `health_review` → coach/meal path into an
explicit, evidence-grounded propagation engine. *Runtime web research depends on the configured agent CLI
having web access; absent that, it falls back to the model's own knowledge and lowers its confidence in the
note.* This is the difference between a tracker that *stores* a lab result and an intelligence that **acts
on it across your whole life.**

### What comes first: the Today redesign

Replace the stats-first, always-a-lifting-day Today with a **day-intelligence-first** Today. The single
most important change in the plan. The surface adapts to the day:

```
TRAIN DAY — gets out of the way                REST DAY — only ever a suggestion
┌────────────────────────────────────┐         ┌────────────────────────────────────┐
│  Friday, Jun 13                 ▾   │         │  Sunday, Jun 15                 ▾   │
│                                     │         │                                     │
│  Lower body.                        │         │  Rest today.                        │
│  You're recovered and it's been     │         │  Four sessions in five days and     │
│  two days — good to go.             │         │  your sleep's run short. Let it     │
│                                     │         │  consolidate.                       │
│  [ Start session ]                  │         │                                     │
│                                     │         │  ↪ train anyway · ask for a plan   │
│  ⌁ short on time / rough night? →   │         │  pull in your plan · explore · log  │
│                                     │         │                                     │
│  log  ▸ food · activity · weight    │         │  log  ▸ food · activity · weight    │
│                                     │         │                                     │
│  ── this week (quiet, below fold) ──│         │  ── this week (quiet, below fold) ──│
└────────────────────────────────────┘         └────────────────────────────────────┘
```

Principles encoded:
- **The day's judgment is the hero**, in plain language — not a score, not a stat grid.
- **The surface fits the day.** Train day → straight to Start. Rest day → no plan, no pressure, no
  guilt. The interface is quiet when there's little to say.
- **The read is a suggestion, never a gate.** Every state — including "rest today?" — is phrased as an
  opening, and the redirects are right there: train anyway, **ask it to build a session now**, **pull your
  planned workout back in**, explore, or just log something else. "Short on time / rough night" reshapes the
  session on *your* tap. The app never decides you're tired for you, never imposes rest, and never marks a
  day "missed."
- **Trajectory is demoted below the fold.** Week adherence, pace, weight are the *trajectory* tier you
  scroll to — not the "what now" tier that greets you.
- **Capture is one quiet row** — there, invisible until you want it.

### Information architecture

Keep the six tabs (Today / Plan / Progress / Chat / Me / Settings) — the structure is sound — but:
- **Today** becomes day intelligence (above).
- **Chat** is the buddy you talk to: already reachable; every "ask about this" deep-links into it with
  the question pre-written (the codebase already does this via `gotoChatWith` / `state.chatPrefill`).
- **Me** is where understanding lives: Profile → Memory → Health → Life → **Family**, plus a richer,
  progressively-filled "About me."
- **Progress** stays the trajectory tier (History / 1RM / Volume / Weight / Calendar); add **Readiness**
  and **Markers** sub-views for those who want to look — never pushed.

---

## 6. Execution plan

Ordered by the new philosophy (intelligence and understanding first; capture and analytics in support).
Each phase splits into **parallel tracks** that meet at typed contracts (`repo.ts` signatures +
REST/MCP shapes) so independent agent teams can run them. Every phase honors §8's contracts and carries
a **restraint note** — what we deliberately *don't* surface.

---

### PHASE 1 — Day intelligence (the Brief)  *the soul; mostly uses data we already have*

**Goal:** Today reads your situation and judges what kind of day it should be — rest, easy, or train —
and leads accordingly, calmly, in plain language. This phase changes what the product *is*.

- **1A — Read the patterns (backend).** `repo.dayRead(date)` → `{ kind:'train'|'easy'|'rest', focus?,
  why, est_minutes?, signals }`. Deterministic signals first (consecutive training days, days since each
  pattern, recovery deltas from `garmin_daily_metrics` vs the user's own rolling baseline, scheduled
  rest), then the **agent makes the nuanced call and writes the human sentence** over `getCoachContext`
  (`buildDayReadPrompt`). Degrade gracefully: no wearable → lean on training pattern + optional check-in.
  Mirror `GET /api/today-read` + MCP `get_day_read`; fold the read into `getCoachContext` so chat agrees.
- **1B — Lead accordingly (frontend).** `renderToday()` (app.js ~908) opens with `renderBrief()` — a
  calm hero whose *shape changes with `kind`*: train → focus + Start; rest → protect-rest copy, no plan;
  easy → a light suggestion. New `.brief*` classes in `styles.css`, Atelier-faithful. Escape-hatch chips
  ("short on time", "rough night") re-call `dayRead` with an override and reshape (hold the compound,
  shed accessories, compress rest). Demote the compass strip below the fold. **Bump `sw.js`.**
- **1C — Optional readiness detail.** Tapping the state reveals Oura-style baseline-banded contributors
  (sleep/HRV/RHR vs *your* norm) in a `.detail` overlay — available, never in your face. Lead with
  **plain-language state — never a 0–100 number.** *Numbers are vanity:* any figure is secondary, shown
  only on a deliberate tap and even then framed against your own norm, never as a score to chase. *(Confirmed.)*
- **1D — The Brief is a launchpad, never a gate.** Every read carries one-tap redirects, so nothing is ever
  imposed: **train anyway / pull in your planned workout** (surface the existing `daybtn` plan switcher
  right on the Brief), **ask for a session now** — an on-demand agentic call (`buildSessionPrompt` over
  `getCoachContext` → `runChosen`, returning a today-session suggestion for review; mirror `POST
  /api/session-suggest` + MCP `suggest_session`), or **just do something else** (log food/activity/weight,
  explore Progress, add an exercise). The day read is the smart default already chosen for you — not a wall
  between you and the rest of the app.

**Restraint note:** the Brief is *small*. On a good train day it's three lines and a button. No score, no
contributor wall unless asked, no second card. The redirects are quiet (a single understated row), present
but never shouting.

**Acceptance:** a poor-sleep / many-days-in-a-row situation opens as a rest or easy day with no lifting
plan and no "missed" penalty; a recovered programmed day opens straight to Start in a few words; the
chat buddy references the same read.

---

### PHASE 2 — Understanding you  *the relationship that makes the pointing trustworthy*

**Goal:** the buddy knows who you are — life, work, family, why you're here — and learns more over time,
mostly through conversation, not forms.

- **2A — Rich "About me" + progressive understanding.** Extend profile/memory with a free-text "about me"
  (training history, work pattern, food likes/dislikes, what "better" means to you). **Onboarding never
  ends:** when `getCoachContext` has a gap, the buddy asks *one* question in chat when you're already
  there ("Do you train fasted in the mornings?") and writes the answer to `memory`. Cheap, compounding,
  uniquely suited to an agentic app. *Never a questionnaire wall.*
- **2B — Family as context.** New `family_members` (name, color, relationship, age, notes) + kids'/
  partner's recurring commitments as `context_events` (`kind:'family_event'`, "Tue 17:00 soccer"). Surface
  in **Me → Family** (mirror existing `life`/`hdoc` patterns). Fold a compact summary into
  `getCoachContext` + `CONTEXT_GUARDRAILS` so the buddy plans *around* the school run and the 6am-with-kids
  reality, and never programs the hardest day onto the chaos day.
- **2C — Life-aware reshaping.** Wire "how many minutes today?" and an active-trip/illness `context_event`
  into Phase 1's `dayRead`: travel → bodyweight option at the same duration; flagged life stress →
  bias toward easy. Encode the **minimum-effective-dose** framing (2×/week, ~20 min is enough; below that,
  movement snacks) as *the plan working as designed* — never a failure.

**Restraint note:** understanding is gathered in the flow of conversation, one question at a time. No
intake forms, no profile-completion bar, no "finish setting up your account."

**Acceptance:** the buddy references your kids' schedule when shaping a week; "I have 20 minutes" yields a
reshaped (not canned) session; a missed day during a flagged trip isn't penalized; facts you mention in
chat show up, editable, in Memory.

**Parallelizable:** 2A/2B/2C independent; 2C consumes Phase 1's `dayRead`.

---

### PHASE 3 — The quiet adaptive substance  *smart pointing at "how to get there"*

**Goal:** targets and progressions adapt to what actually happened — surfaced *calmly, only on a
meaningful change*, as a proposal you review.

- **3A — Adaptive nutrition (MacroFactor-style, adherence-neutral).** `repo.estimateExpenditure(window)` —
  derive real TDEE from `intake − Δ(weighted-trend bodyweight)` (reuse the slope math behind
  `getWeeklyStats`); tolerate missing days; converge ~2–3 weeks. `buildNutritionCheckinPrompt()` drafts a
  target change when the trend has genuinely moved, **regardless of adherence**, macro floors fat→protein→
  carbs under a deficit. Auto-suppress during an active travel/illness `context_event` (we have the
  events). A calm **Energy Balance** view in Progress: "you overshot your target but you're still in a
  deficit." Anti-guilt: "remaining," not "consumed"; no red overages, no good/bad foods. It also consumes
  **derived health directives** from the connected brain (see §5) — high ApoB tilts the menu toward fish &
  poultry and more soluble fiber — so your labs actually shape what you eat.
- **3B — Training autoregulation.** Capture light per-session feedback (RIR we mostly have; add optional
  1-tap soreness / performance / joint-pain on `sessions`/`logged_sets`). Extend `buildCoachPrompt`
  guardrails: RIR/RPE → load (within existing conservative caps); soreness/performance → set count;
  joint-pain → de-load that movement; optional AMRAP → est-1RM → next block (we already compute Epley).
  Recovery *informs* selection; never let it override progressive overload (the Fitbod lesson).

**Restraint note:** these loops run *silently* in the background and only ever produce a single, plainly
justified proposal when something real changed — never a weekly "here's your report" you must read.

**Acceptance:** after ~3 weeks a nutrition proposal appears with a trend-justified target change to review;
easy reps on a lift surface a small load-progression proposal; an active trip suppresses the retarget.

**Parallelizable:** 3A and 3B fully independent.

---

### PHASE 4 — Longevity & health intelligence  *point at the one marker that matters*

**Goal:** labs and the long-game become a prioritized few actions and a legible trajectory — never a lab
dashboard to decode.

- **4A — Prioritize.** `repo.prioritizeMarkers()` — **red-first**, then an **Impact-Score** rank (how many
  out-of-range markers an action moves × evidence × goal fit). Feed the top 3 into `buildHealthReviewPrompt`
  (already emits watchlist/focus/followups) so the review *leads* with what matters most. **Optimal-zone**
  framing (by age/sex/activity), distinct from clinical ranges — only act on out-of-*optimal* markers,
  never nag about good ones.
- **4B — Trajectory (PWA), calm.** A per-marker trend chart in Me → Health (reuse `sparklineSvg` /
  `getMarkerHistory`) and an optional organ-system grouping. Biological aging, if shown at all, is **plain
  language, not a number** ("you're aging a touch faster than ideal — here's the lever"), tracked as your
  own trend, never a score to compare. All of this is *there if you look* — the Brief only surfaces a health
  item when one genuinely needs attention.
- **4C — The propagation engine (the connected brain).** Turn a flagged finding into action everywhere: a
  `repo.deriveDirectives()` step maps out-of-optimal markers to **structured cross-domain directives**
  (nutrition tilts, training caps, watch-items) that `getCoachContext()` carries into the meal, training,
  and day-read prompts; `buildHealthReviewPrompt` is instructed to **consult current clinical guidance**
  when a finding is consequential or uncertain and to **cite it** in a plain-language note. The output is a
  reviewable proposal + an annotated note — labs that actually reshape meals and training, not a number that
  sits in a tab. (See *The connected brain*, §5.)

**Restraint note:** the longevity layer points at *one* thing at a time. It is not a quantified-self
dashboard; already-optimal markers stay silent.

**Acceptance:** uploading labs yields a review that leads with the single highest-impact action; the Health
tab shows each marker's trend on demand; good markers generate no noise.

---

### PHASE 5 — Invisible capture  *remove the friction so it stays out of the way*

**Goal:** logging food, activity, weight, and how-you-feel is sub-ten-seconds and sometimes one tap — or
just a sentence said out loud — so the buddy costs you almost nothing. *Effortless capture is a first-class
goal, not a nicety.*

- **5A — Photo → macros.** Snap a photo → instant plate → background agent (`buildFoodPhotoPrompt`, reuse
  the enrichment queue + food_notes' existing `image_path`) returns an **editable, confidence-banded**
  macro draft; the frontend polls and upgrades in place (pattern exists). One-tap ×0.5/×2 portion nudge.
- **5B — Fast manual logging.** `repo.frequentFoods(hour)` (time-of-day frequents from timestamped
  `food_notes`), multi-add with default servings, natural-language describe (extend `addFoodNote` /
  `parseActivity`). Barcode only if it stays simple.
- **5C — Optional how-you-feel.** A ≤1-tap mood/energy/sleep-feel input *offered, never demanded*, feeding
  `dayRead` (1A) as a parallel signal and the graceful-degradation path when there's no wearable. The app
  is fully usable if you never touch it.
- **5D — Apple Health / steps.** For passive steps/NEAT (feeds 3A and the "you've been sedentary → easy
  movement" read) and as a hub. Pragmatic path for a self-hosted PWA: a documented **Apple Shortcuts**
  automation POSTing daily metrics to `POST /api/health-metrics` → a generalized `daily_metrics` table
  (mirror `garmin_daily_metrics`, `source='apple'`); accept the Health XML export for backfill. Generalize
  `getGarminCoachSummary` → source-agnostic `getRecoverySummary`. Optional, gracefully absent.
- **5E — Say it out loud (voice).** A press-to-talk affordance on the quick-log row: the Web Speech API
  (`SpeechRecognition`) transcribes where available, the text flows straight into the existing
  natural-language parse + background enrichment (food or activity), and the entry upgrades in place. No
  keyboard, no forms — "ran 50 minutes easy, then a big salad with salmon" becomes a logged activity *and* a
  logged meal. Graceful fallback to the text field where speech isn't available; nothing depends on it.

**Restraint note:** capture is *offered, not pushed*. No "log your breakfast!" prompts. The simplest paths
(photo, natural language) lead; barcode/multi-add are there for those who want them.

**Acceptance:** a photo logs a meal with an editable draft in seconds; "chicken & rice" at 1pm surfaces as
a one-tap frequent; a mood tap (if used) moves the day read; iPhone steps appear in the recovery summary.

**Parallelizable:** all four tracks independent; can run anytime.

---

### PHASE 6 — Quiet intelligence  *pull, never push; the thing that makes it feel alive*

**Goal:** the buddy occasionally has something genuinely worth saying — and it's *there waiting for you
when you come*, surfaced calmly, **never pushed**.

- **6A — Cross-domain insight, in-app.** A periodic agent pass over `getCoachContext` hunts for *one*
  real connection you couldn't make ("ferritin ran low in March and your 4-week volume is down 30% —
  likely iron-limited; here's a food swap and a retest to consider"). It appears as a single quiet line
  in the Brief *when you open the app*, one at a time, only when there's something real. Thumbs up/down →
  `memory`. **No notification fires.**
- **6B — A standing weekly read, not a weekly nag.** Upgrade `scheduler.ts` to prepare a short "here's how
  your week went + the one change I'd suggest" that **waits in-app** for you to read whenever you like —
  packaged from the Phase 3 adaptive loops. Pull, not push.
- **6C — Honest continuity, not streaks.** Sustained change is supported by *seeing your real rhythm*
  ("you've trained three times a week for six weeks — nice"), shown calmly when you look at Progress —
  **not** a chain you fear breaking. Rest weeks read as rest weeks, not failures. No counters that reset.

**Restraint note:** this entire phase is **opt-in and pull-based**. Default: zero notifications. If we ever
add one, it's a single rare, opted-in, time-sensitive thing in a friend's voice — and the bar for adding
it is this whole constitution.

**Acceptance:** insights appear only on real signals, only in-app, one at a time; a week with two rest days
and a trip is shown as a healthy week; the app never pings the user in v1.

---

## 7. Data to capture (and the one rule)

**Only capture what changes a decision.** Don't add a field the buddy won't reason over. With that filter,
the high-ROI additions:

- **Optional how-you-feel** (`checkins`: mood/energy/sleep-feel/soreness) — feeds the day read; graceful
  path without a wearable. *Offered, never required.* *(5C)*
- **Per-session training feedback** (soreness/performance/joint-pain on `sessions`) — autoregulation. *(3B)*
- **Generalized `daily_metrics`** (source-agnostic steps/sleep/energy: Apple + Garmin). *(5D)*
- **Family** (`family_members` + family `context_events`) — realistic, life-aware coaching. *(2B)*
- **Rich "about me"** (profile/memory extension) — the understanding engine. *(2A)*

Deliberately **not** adding (low decision-value, anxiety risk, or surface bloat): CGM/glucose scoring,
per-supplement logging (capture as memory if notable), circumference/photos, menstrual tracking unless
relevant, hydration unless it ever drives a recommendation, and *anything gamified*.

---

## 8. Non-negotiables & guardrails

- **The constitution (§2) is binding.** You drive; calm by default; no nudging/streaks/push; restraint over
  features; smart and pointed; reads the day; understands you; change through trust; kind and never anxious.
- **Honor the Atelier contract** (`docs/DESIGN.md`) — palette, class names, motion tokens, reduced-motion,
  light-theme-only. New surfaces extend the language; they don't fork it.
- **Two surfaces, one repo.** Every capability lands in `repo.ts`, mirrored by near-identical `api.ts` +
  `mcp.ts` wrappers. Business logic never lives in an adapter.
- **Schema discipline.** New table → `CREATE TABLE IF NOT EXISTS` in `db.ts`. New column → both `db.ts` *and*
  a new `MIGRATIONS` entry in `migrate.ts` (idempotent `ALTER … ADD COLUMN` in try/catch). Down-migrations
  unsupported; back up first.
- **Bump `sw.js` `CACHE`** on every `public/` change, same commit.
- **Escape everything.** All server/agent strings into `innerHTML` go through `escHtml`/`escAttr`; `art.js`
  static SVGs are the only raw exception.
- **Nothing plan-affecting or clinical auto-applies.** It routes to the review-before-apply loop. Health
  findings are informational, not medical advice.
- **Graceful degradation everywhere.** No Garmin, no Apple Health, no API key, no agent reachable — every
  feature has a sensible reduced state, exactly as art/enrichment already do.
- **Self-hosted, own-your-data, no recurring fee, no account required to function.** A feature, not an
  afterthought.

---

## 9. Sequencing & how to run this

**Order:** Phase 1 (day intelligence) → Phase 2 (understanding) → Phase 3 (adaptive substance) →
Phase 4 (longevity) → Phase 5 (capture, parallel anytime) → Phase 6 (quiet intelligence). **Phase 1 is the
keystone** — it changes what the product *is* and is the surface every later phase quietly feeds. Land it
end-to-end first as the proof.

**As parallel agent teams** (your preferred mode): within each phase the tracks meet at typed contracts. A
natural batch is one agent on the `repo.ts` synthesis fn, one on the `api.ts`+`mcp.ts` mirrors, one on the
`prompt.ts` prompt/guardrail changes, one on the `app.js`+`styles.css` surface — converging on the named
contract. Land Phase 1, then fan out.

**The pitch of the finished thing.** You open Cairn when you want to — it never pulls you in. Most mornings
it's three calm lines: *"Lower body. You're good — go."* Some mornings it's *"Rest today; you've earned it,"*
and there's no plan and no guilt. You were up at 2am with the baby, so you tap "rough night" and it quietly
becomes twenty easy minutes — and that's a win, not a miss. A photo of lunch — or three words said out
loud — logs itself. It doesn't ping
you, doesn't gamify you, doesn't bury you in features. When your real metabolism drifts, it mentions —
once, when you're already there — that nudging calories up 200 would keep you losing safely, and asks if
you'd like that. It remembers your ferritin, so when your training dips it connects the dots before you do.
It knows Tuesdays are chaos, so it never puts your hardest day there. It's not an app you serve. It's a
buddy who knows you, plays the long game with you, points the way at the forks that matter — and otherwise
rides quietly in the passenger seat while **you** drive.

---

## 10. Parallelization & build orchestration

How the complete vision gets built by parallel agent teams in isolated git worktrees, then merged —
engineered around the one real hazard: many teams editing the same hot files (`repo.ts`, `api.ts`,
`mcp.ts`, `app.js`, `styles.css`, `db.ts`, `migrate.ts`, `prompt.ts`) and colliding on migration versions.

**Branch model.** All work on `feat/vision-build`; each Stage-2 team gets its own **git worktree** branched
from the locked-foundation commit; final review then merges to `main`.

**Stage 0 — Design lock (parallel, read-only).** Freeze the contracts before any code: the full schema
delta with **centrally-assigned migration versions** (v18…N — the critical anti-collision step), the
`repo.ts` signatures, the `api.ts`/`mcp.ts` endpoint + tool list, the connected-brain prompt architecture,
and a **file-ownership map + merge order**.

**Stage 1 — Foundation (sequential, single writer, on the branch).** One team writes the shared base so the
parallel teams stand on stable ground: all schema (`db.ts` + `migrate.ts` v18…N), the **connected-brain
core** (`deriveDirectives` + `getCoachContext` expansion + prompt scaffolding), the generalized
`daily_metrics` / `getRecoverySummary`, and `repo.ts` function stubs for every module. `npm run build`
green, commit. *Everything downstream branches from here.*

**Stage 2 — Feature teams (parallel, one worktree each).** One team per module, branched from the Stage-1
commit, each implementing its slice end-to-end (repo logic + api/mcp mirror + prompt specifics + PWA
surface) against the locked contracts:
- **T1 — Day intelligence** (Phase 1): `dayRead`, the Brief, launchpad redirects, on-demand session. *The keystone.*
- **T2 — Understanding & family** (Phase 2): about-me, progressive profiling, family model, life-aware reshaping.
- **T3 — Adaptive substance** (Phase 3): the expenditure loop + training autoregulation.
- **T4 — Connected health intelligence** (Phase 4): prioritization, calm trends, **the propagation engine**.
- **T5 — Effortless capture** (Phase 5): photo, frequents, **voice**, optional check-in, Apple Health.
- **T6 — Quiet intelligence** (Phase 6): in-app insight, the standing weekly read, honest continuity. No push.

Teams touch shared files **additively** (append functions / routes / tools / render fns); the ownership map
assigns any unavoidable shared edit to a single owner.

**Stage 3 — Integration (sequential).** Merge worktrees in dependency order (T1 → T2 → T4 → T3 → T5 → T6),
reconcile the additive edits, **bump `sw.js`**, `npm run build` to green, and run the `stub`-agent smoke
path over the propose/apply loop.

**Stage 4 — Review & iterate (parallel reviewers → fixes, ×2).** Independent passes: correctness/bugs,
security, **design-contract adherence** (`docs/DESIGN.md`), and the **"ultimate-user" whole-system feel** —
does it stay out of the way? is every read a suggestion? does a lab finding really move meals & training?
is capture effortless (incl. voice)? is it calm? A fix team applies findings; repeat ~twice.

**Stage 5 — Polish.** Slickness pass: microanimations, view-transition continuity, count-ups where they fit,
empty/loading/degraded states, reduced-motion — all within Atelier.

**Stage 6 — Housekeeping.** Update `CLAUDE.md`, `docs/*`, code comments, this doc's progress log, README;
final `npm run build`; final review; merge to `main`.

**Why this avoids the conflict trap:** Stage 0/1 centralize schema + contracts (no migration-version
collisions, no interface drift), worktrees isolate Stage-2 development, and integration is deliberately
sequential. Progress is tracked in §11 and the task list; each stage gates the next.

## 11. Progress log

_Updated as stages land._
- [x] Stage 0 — Design lock (contracts frozen) — VISION.md committed `ba7c313`
- [x] Stage 1 — Foundation (schema v19/v20 + connected brain) — `b91b63b`; `deriveDirectives`/`getRecoverySummary`/`dayRead` + new tables, build green
- [x] Stage 2 — Feature teams T1–T6 **backend** (parallel worktrees) — six branches `feat/vt{1..6}-be`, all build-green
- [x] Stage 3 — Backend integration + smoke — `f07deac`(T1)·`8a8b9dd`(T3)·`ce70e7a`(T5)·`d101911`(T6) cherry-picked; T2 `71bd397` + T4 `3386cc4` re-applied onto the foundation (their worktrees branched off a stale base); schema **v21**; fresh-DB boot + read/write/agentic smoke all green
- [x] Stage 2B — Frontend wave (coordinated, linear) — `f422d79` Brief · `2ba63df` capture+voice+insight · `c051b71` Me→Family + Health Brain · `641efa6` adaptive nutrition + autoregulation + Apple-Health; `sw.js`→v31, each step verified live
- [x] Stage 4 — Review & iterate ×2 — pass 1 `80ee877` (12 verified findings: 1 high / 4 med / 7 low) + pass 2 `8a1d3a6` (5: 1 high producer-gap / 4 coherence); all fixed, build green, `sw.js`→v33
- [x] Stage 5 — Polish (microanimations / slickness within the Atelier contract) — `9087446`; shared-element Brief reshape, `settle-in` async cards, count-ups, staggered directives, all reduced-motion gated; `sw.js`→v34
- [x] Stage 6 — Housekeeping & merge to main — `CLAUDE.md` brought current `4f0f064`; final clean build (tsc 0) + fresh-DB smoke (v21, all surfaces 200, no runtime errors); merged to `main`

**Build complete (2026-06-13).** The full vision is implemented end-to-end across PWA + REST + MCP + scheduler, build-green, smoke-verified, reviewed twice with all findings fixed, and merged to `main`.

**Integration note (for the record):** the Stage-2 worktrees were created off the pre-foundation commit `1062054`, not the foundation `b91b63b`. T1/T3/T5/T6 self-corrected (`git reset --hard b91b63b`); T2/T4 built on the stale base, so they were re-applied onto the integrated tip rather than merged (T4's richer directives engine — 16 cited markers + `marker`/`uncertain` columns via migration v21 — superseded the foundation's basic version in place, preserving `listActiveDirectives`/`renderConnectedBrain`).

---

*Living document. The constitution in §2 and the contracts in §8 are frozen; the plan in §6 is meant to be
revised as reality teaches us.*
