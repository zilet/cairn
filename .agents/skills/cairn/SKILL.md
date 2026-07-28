---
name: cairn
description: Quick natural-language logging and coaching for the Cairn training/nutrition tracker. Use when the user says things like "log my ride / run", "update my plan", "how am I tracking", "I'm down to X lb", "draft a meal plan", or "what's my workout today" over a configured Cairn MCP server.
---

# Cairn quick actions

Cairn is the user's self-hosted training, nutrition & performance tracker. It exposes an MCP
server; you drive it with the `cairn` MCP tools. This skill maps everyday phrases to those tools
so the user can log and adjust things by talking instead of opening the web app.

## Prerequisite: the `cairn` MCP server must be connected

If the `cairn` tools (e.g. `get_plan`, `log_activity`) aren't available, tell the user to add it:

```bash
Codex mcp add --transport http cairn http://localhost:8787/mcp
```

Replace the URL with the host where Cairn runs: `localhost`, a LAN host, or an
HTTPS Tailscale/MagicDNS address. If that deployment has `CAIRN_AUTH_TOKEN`
enabled, configure the MCP client to send `Authorization: Bearer <token>` (or
use the token support provided by the client).

## Intent → tool mapping

- **"What's my workout today / what should I train?"** → read `get_daily_session` first; when
  nothing has been accepted, use `preview_daily_session` for the exact evidence-aware candidate
  Cairn would persist. This is read-only: call `prepare_daily_session` only when the athlete
  explicitly starts or accepts it. **"Show my weekly plan/template"** → `get_plan` (or
  `get_plan_day` for one template day).
- **"Log my ride / run / swim / hike"** (e.g. *"did 2h on rolling trails, felt strong"*) → `log_activity`
  with the raw text in `text`. Cairn parses type/duration/distance/pace instantly, then (if enrichment
  is enabled) a background agent refines the entry and may distill a notable durable fact into memory.
  Read it back.
- **"What did I do on <date> / show a past session"** → `get_session` with `date: "YYYY-MM-DD"`
  (returns that day's session + sets, or null). Use `get_last_set` for an exercise's most recent set.
- **"Log a set"** (e.g. *"squat 195 for 8 at RIR 2"*) → `log_set` (weight in lb; negative = assisted,
  null = bodyweight). Today's session is created automatically; the response flags a new est-1RM PR.
- **"How do I do X / form for X / cues for X"** → `get_exercise` (muscle group, injury constraint,
  form cues, plan appearances, est-1RM, recent sets). Lead with the constraint if there is one.
- **"Log my weight / I weighed in at X"** → `log_weight` (lb). It also updates the profile's current
  weight, so the goal check stays accurate. Use `list_weight` for the trend.
- **"How am I tracking / am I on pace"** → `get_goal_check` (TDEE + lean-safe feasibility) and
  `get_progress` for the lifts they ask about (Epley est-1RM trend). Summarize honestly; if the goal
  is flagged aggressive, say so and quote the lean-safe recommendation.
- **"I'm down to 176 / push my goal date / change my weight / I live in Denver"** →
  `set_profile` (any subset). Store the usual base as `home_location`; never request browser
  geolocation or treat it as a daily current-location picker.
- **"My priorities are … / endurance supports my main goal / I want to stay ready for 2-hour MTB
  rides"** → `set_training_intent`. Keep the durable ordered priorities, endurance role, and
  sport-specific duration capability here. A temporary dated race belongs in `set_endurance_goal`;
  do not let the event silently replace the durable hierarchy. Read back with `get_training_intent`.
- **"Trail-system ride / trail MTB / downhill MTB / skiing in winter"** → preserve the terrain or modality
  in the `log_activity` text and in durable memory/intent when it describes identity. Trail/XC MTB
  includes climbs and descents and is not downhill-only; lift-served downhill, road, gravel, alpine
  skiing, Nordic skiing, touring, and unspecified skiing have different load meaning. Never invent a
  skiing subtype the athlete did not state.
- **"My run moved / what running still fits this week?"** → `get_training_agenda`. Treat run-plan
  days as suggested anchors: actual compatible runs close one weekly intention even on another day,
  completed work is not prescribed twice, and missed timing never creates catch-up volume.
- **"Update my plan / progress my targets for next week"** → `draft_plan_update` with `agent: "auto"`
  (uses the user's configured rotation), then route the result through `apply_proposal_with_autonomy`.
  In Lead mode, bounded reversible changes land now or at the next natural boundary; structural changes
  announce first. Review mode still returns a draft that needs confirmation.
- **"Make next week 4/5/7 days / change my split"** → restructure the plan. Use `set_plan` to replace the
  whole week (days not included are removed), or `save_plan_day` / `delete_plan_day` for one day. Build
  sensible days that honor injury `constraint_note`s and carry weights over where it makes sense; show
  the proposed split and confirm before writing.
- **"Draft / refresh a meal plan for the week"** → `draft_meal_plan` (`agent: "auto"`). In Lead mode,
  the returned `autonomy` sidecar announces when it becomes current automatically; summarize the upcoming
  plan and date. In review posture it remains a draft and needs confirmation.
- **"Remember that I … / I prefer …"** → `add_memory` (dedupes exact repeats). Memory feeds every
  future coach prompt. **"Fix / forget what you remember about …"** → `update_memory` / `delete_memory`
  (the user can also curate this in the app's Me → Memory view).
- **"I'm travelling / trip to X on these dates / I tweaked my knee / rough week coming up"** →
  `add_context_event` (`kind`: `trip` | `injury` | `life_event`, with `title`, `start_date`,
  optional `end_date`, and a `meta` object — trip `{location}`, injury `{area,severity}`, event
  `{impact}`). The coach plans **around** these: deload/travel-friendly weeks over trips, de-load
  an injured area, ease volume during life events. A trip location is optional and overrides
  `profile.home_location` only inside that trip's active date window; it never rewrites home.
  `list_context_events` (`{active}`), `update_context_event`, `delete_context_event` to
  review/curate.
- **Bloodwork / DEXA / a lab photo** (vision) → analyze it yourself from the Codex client, then
  `add_health_record` (`{kind, doc_date, summary, parsed}`) to store the summary + markers so the
  coach factors them in (this MCP path records an analysis WITHOUT a binary; in-app uploads with
  auto-analysis happen in Me → Health). `list_health_records` / `delete_health_record` to manage.
- **"Which agents are on / switch to round-robin / disable Grok"** → `get_settings` / `set_settings`
  (strategy: round_robin | random | priority; `disabled_agents`; weekly `coach_*` schedule).

## Rules

- Coaching outputs are ledgered proposals governed by Cairn's server autonomy policy. Under Lead mode,
  bounded reversible adaptations land at natural boundaries with rationale and Undo; structural changes
  announce first. Ask explicitly only for goal-identity, clinical, user-locked, high-risk, stale, or
  configured review-everything decisions. Never bypass the server policy with a direct apply.
- Respect injury constraints in the plan and in `list_memory`; never suggest contradicting them.
- For weight loss, defer to Cairn's lean-safe math (`get_goal_check`) — don't endorse crash deficits.
- After any write, read back what was stored so the user can confirm it landed.
