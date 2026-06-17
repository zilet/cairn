# Why Cairn

A calm, honest look at where Cairn fits — and where it doesn't. The tools below are
good at what they do; Cairn is a different shape of thing. This page is here so you can
tell quickly whether that shape is the one you want.

The product north-star that everything here follows lives in [`docs/VISION.md`](VISION.md).
The short version: Cairn is **your own** day-reading wellness OS — self-hosted, private,
and built to *understand your whole picture and point at the one thing worth doing today*,
then get out of the way. It is a buddy, not a boss. You drive.

---

## The one-line version

Most tools track a domain well. Cairn connects the domains — your labs, your training,
your food, your sleep, your life — into **one reasoning brain** that you own and run
yourself, and it speaks only when it has something useful to say.

---

## Cairn vs. MacroFactor

**MacroFactor is excellent.** Its adherence-neutral expenditure model — derive your real
TDEE from your weigh-ins and intake, re-target without judging whether you "were good" — is
the right way to do adaptive nutrition, and Cairn deliberately adopts the same philosophy
(see the Energy Balance view and `estimateExpenditure`). If you want a focused, polished
nutrition app and nothing else, MacroFactor is a great answer.

Where Cairn is different:

- **Nutrition is one domain, not the whole product.** The same expenditure loop runs inside
  a system that also reads your training, recovery, labs, and life — so a meal target can be
  shaped by a flagged lab (high ApoB tilts the menu toward fish, poultry, and soluble fiber)
  or suppressed during a travel week, automatically. A standalone nutrition app can't see
  any of that.
- **You own the data and the model.** MacroFactor is a subscription cloud service. Cairn is
  self-hosted: your numbers live in a SQLite file on your own machine, exportable any time,
  with no account and no recurring fee.
- **Coaching is conversational and agentic.** You talk to Cairn in plain language; it logs
  the easy things instantly and stages changes as drafts you approve.

**When MacroFactor wins:** you want a refined, single-purpose nutrition app on your phone,
maintained for you, and you don't want to host anything.

---

## Cairn vs. Oura / Garmin / Whoop

**Wearables are the best in the world at one thing: measurement.** Oura's sleep staging,
Garmin's training load, Whoop's recovery — these are sensors and models tuned over years,
and Cairn does not try to replace them. In fact Cairn *reads from* them: it ingests Garmin
daily metrics (sleep, HRV, resting HR, body battery, stress) and Apple Health via a Shortcut,
and folds that into its day-read.

Where Cairn is different:

- **Synthesis, not a metric wall.** A wearable hands you a dashboard of numbers and a score
  to interpret. Cairn leads with a single plain-language read — *"Lower body. You're recovered
  and it's been two days — go,"* or *"Rest today; your sleep's run short."* — and it's a
  **suggestion, never a gate**. Reading your day is a synthesis problem; the data is already
  flowing.
- **No scores, by design.** Cairn never shows a 0–100 grade to chase. A scary number you must
  decode is the opposite of calm (and orthosomnia is a real cost). It shows in/out-of-*your-own*
  baseline and a direction, not a rank.
- **It connects the sensor to the labs.** A persistently elevated running heart rate isn't
  just a chart in Cairn — it gets connected to the bloodwork that might explain it. That
  cross-domain link is the whole point, and a single-sensor device can't make it.
- **Pull, never push.** No nudges, no streaks, no "you haven't closed your rings." Cairn earns
  being opened by being useful when opened. Insights wait for you in-app; nothing pings you.

**When the wearable wins:** you want precise passive measurement and a refined ring/watch
experience. Keep it — and let Cairn read from it. They're complements, not competitors.

---

## Cairn vs. "ChatGPT + a spreadsheet"

This is the closest comparison, because a good LLM and a spreadsheet can genuinely take you
far: you can paste a lab panel into a chat, ask for a read, and keep your numbers in a sheet.
Plenty of capable people do exactly this. Cairn is what happens when you make that loop
**durable, grounded, and effortless** instead of manual every time.

Where Cairn is different:

- **It already knows you.** Every coaching call is grounded in `getCoachContext()` — your
  profile, goal, plan, recent sessions, activities, recovery, memory, labs, and life context —
  injected before the model generates anything. A fresh chat starts from zero every time; you
  re-explain yourself, re-paste your history, and hope it remembers. Cairn's **memory grows
  over time** and is editable, so the pointing gets more precise, not more repetitive.
- **The brain is connected, and it persists.** A finding doesn't sit in one conversation —
  it **propagates**. A flagged lab becomes structured directives that reshape your meals, your
  training caps, and your watch-items, and those directives are still there next week. In a
  chat, that connection evaporates when you close the tab.
- **Capture is effortless.** A photo, a tap on a time-of-day regular, a typed phrase, or just
  saying it out loud — *"ran 50 minutes easy, then a big salad with salmon"* — becomes a logged
  activity *and* a logged meal, parsed and structured in the background. A spreadsheet is
  manual entry forever.
- **Nothing silently changes your plan.** Cairn's spine is **propose → review → apply**: it
  drafts, you decide. An LLM that just edits your sheet (or confidently rewrites your program)
  has no such guardrail.
- **It's two surfaces over one brain.** The same logic is reachable from the PWA *and* from any
  MCP client — so you can talk to Cairn from Claude or another client on your own network, with
  vision and the full tool surface, while the scheduled/background coaching runs on your own CLIs.

**When ChatGPT + a sheet wins:** you want zero setup, you're happy re-grounding the model each
session, and you don't need the connections to persist. For a one-off question it's hard to
beat. Cairn is for when you want that intelligence *standing by, already grounded, every day*.

---

## What Cairn is **not**

Being honest about the edges is part of the voice.

- **Not a social app.** No feed, no friends, no leaderboards, no sharing. It's a private system
  tuned to one person.
- **Not a multi-user SaaS.** Cairn is single-user by design. There's no account system, no
  billing, no team management. (It ships with no auth by default — run it on a network you
  trust, and set `CAIRN_AUTH_TOKEN` if the port is reachable beyond loopback. See
  [`SECURITY.md`](../SECURITY.md).)
- **Not medical advice.** Health findings are informational. Cairn points at optimal-zone
  framing and lab trends and explains the reasoning, but anything clinical defers to a
  clinician. It is a buddy who reads your numbers, not a doctor.
- **Not a wearable.** It has no sensors of its own; it reads from the ones you already have.
- **Not an engagement machine.** No streaks, points, badges, push nags, upsell, or "have you
  tried…" feature-pushing. It has nothing to sell and no one to retain. If it ever feels like
  it's trying to keep you in the app, that's a bug.
- **Not zero-setup.** It's self-hosted. You run a container (or Node 24) on your own machine.
  That's the price of owning your data and your model — and [`docs/QUICKSTART.md`](QUICKSTART.md)
  gets you there in about thirty seconds.

---

## The honest summary

If you want the best single-domain tool, buy the best single-domain tool — Cairn will happily
read from your wearable and borrows MacroFactor's nutrition philosophy on purpose. If you want
a quick one-off read, a good chat model is hard to beat.

Cairn is for the person who wants **one private place that quietly understands the whole
picture**, connects a lab finding to the meals and the training it should change, captures
with almost no friction, never pushes or grades, and is *yours* — running on your own
hardware, with your own data, answering only when you come to it.

That's the trade. If it's the one you want, [`docs/QUICKSTART.md`](QUICKSTART.md) is thirty
seconds away.
