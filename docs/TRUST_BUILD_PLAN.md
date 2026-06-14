# Cairn — Trust Build Plan (round 2)

> **Goal:** push Cairn toward an **elite agentic, verifiable, and trustworthy** system with **elite UX/UI**.
> Verifiable = its behavior is tested and its claims are inspectable. Trustworthy = safety is enforced in
> CODE not just prose, the agent checks its own work, and uncertainty/evidence are honest and visible.
> Every change holds the constitution (`docs/VISION.md`): calm, suggestion-not-a-gate, **no numeric scores**,
> pull-never-push, health findings informational-not-medical-advice.

Builds on the merged elite-build batch (schema v30). Integration branch: **`trust-build`** (off `main`).
Three streams, run in isolated git worktrees, merged back in meaningful groups by the orchestrator, then a
quality pass, then `trust-build` → `main`.

## File-ownership (kept disjoint for clean merges)
- **V1 trust-core** → backend: `src/repo.ts` (apply/guardrail region only), `src/coachOps.ts`, `src/prompt.ts`, `src/api.ts`, `src/mcp.ts`, `src/agents.ts` (env hardening only). **No new migration** (guardrails are logic; evidence endpoint reads the existing `evidence_cache`).
- **V2 verify-harness** → `test/**` (new), `package.json` (add the `test` script only). Does NOT touch `src/**`.
- **V3 trust-ux** → `public/**` only. Builds against the API contracts below (degrade gracefully if a field/endpoint is absent — backend lands alongside). MUST bump `public/sw.js` CACHE `cairn-v49` → `cairn-v50`.
- Docs (`CLAUDE.md`, `docs/*`) are orchestrator-owned (housekeeping). Streams don't touch them.

## Shared API contracts (so V3 builds against V1)
- `GET /api/evidence?marker=<name>` (V1) → `{ marker, evidence:[{claim, source_title, source_url, body, confidence, retrieved_at}] }`. Reads `evidence_cache`; `evidence:[]` when research never ran. Lets the UI make a citation INSPECTABLE.
- Apply result (V1): `applyProposal` / `POST /api/proposals/:id/apply` and chat `plan_update` apply now return `clamped: [{ exercise, field, requested, applied, reason }]` whenever the code guardrail adjusted a value. UI shows a calm "adjusted to a safe step" note.
- Self-verify (V1): meal-plan + session-suggest results carry an optional `verified: { checked: true, adjustments: [..] }` so the UI can show "checked against your protein/fiber/kcal floors."
- Trust/activity panel (V3) is built from the existing `GET /api/agent-stats` (`recent[]` + `by_agent`). No new endpoint needed.

---

## V1 — Trust core (code-enforced safety + self-verify + evidence + env hardening)
**Why:** safety guardrails today live only in prompts; nothing in code stops an off-spec agent value from being applied; high-stakes agentic outputs are single-shot/unverified; the web-capable agent subprocess inherits Cairn's secrets.
**Scope:**
1. **Code-enforced apply guardrails** in `src/repo.ts` `updateTarget`/`applyProposal`: clamp load-progression deltas to a safe step vs the current target (e.g. ≤ ~10% or a sensible absolute lb/kg cap, whichever is larger; symmetric for decreases that look like fat-finger errors), clamp `target_seconds` similarly, honor an exercise's injury `constraint_note` (do NOT increase load on a constrained/flagged exercise — hold or reduce), and for the nutrition-target advisory path clamp to the lean-safe kcal/protein floors (reuse `computeGoalCheck`/longevity floors). RETURN every adjustment as `clamped:[{exercise, field, requested, applied, reason}]` — transparency, not silent capping. Thread it through `applyProposal`'s result and the chat `plan_update` apply. Keep it a SUGGESTION-system: clamping makes an *applied* change safe; it never blocks the user from explicitly choosing a value via direct edit.
2. **Agentic self-critique verify pass** for the two highest-stakes generative ops — meal plan and session-suggest. After the draft, one bounded follow-up (`buildPlanVerifyPrompt` / reuse a generic verify) asks the agent to check the draft against the hard floors/constraints (protein ≥ floor, fiber, lean-safe kcal, injury constraints, equipment/time limits) and return `{ ok, violations:[], fixed_draft? }`; apply the fix when present, record `verified:{checked, adjustments}`. Degrade gracefully (verify off/agent down → ship the draft unverified, exactly today's behavior). Gate behind a setting `verify_enabled` ONLY if you add a column — prefer NO schema: make it always-on but cheap and fail-open.
3. **`GET /api/evidence?marker=`** (+ MCP `get_evidence`) reading `evidence_cache` via a repo helper — makes a directive's citation inspectable.
4. **Subprocess env hardening** (`src/agents.ts`): pass the agent CLI a copy of `process.env` MINUS a denylist of Cairn-only secrets the CLIs never need (`CAIRN_AUTH_TOKEN`, `GARMIN_PASSWORD`, `DB_PATH`, etc.) — keep `HOME`/`PATH`/`LANG` and each agent's declared `env_required`. A denylist (not allowlist) so no agent login breaks; reduces blast radius now that research grants web egress.
**Owns:** `src/repo.ts` (apply/guardrail + evidence helper), `src/coachOps.ts`, `src/prompt.ts`, `src/api.ts`, `src/mcp.ts`, `src/agents.ts`. **No migration.**

## V2 — Verification harness (the verifiable backbone)
**Why:** zero tests today; the constitution-critical deterministic floors and new logic are unverified.
**Scope:** a `node:test` suite (Node 24 built-in, ZERO deps) under `test/`, run via `npm test` (add the script to `package.json`; use a throwaway `DATA_DIR=$(mktemp -d)` per run so it never touches real data; build `dist` first or import `src` via tsx — prefer running against a fresh seeded in-memory/temp DB). Cover the stable, high-value cores:
- `extractJson` edge cases (braces in strings, escaped quotes, nested objects, fenced ```json block, trailing prose, truncated output → salvage/null).
- `dayRead` (rest on ≥3 consecutive training days / low recovery; train otherwise) and `estimateExpenditure` (adherence-neutral confidence, trip/illness suppression).
- Marker intelligence: `getMarkerHistory` trend (least-squares dir/slope/projection), `forecastMarker`, `prioritizeMarkers` — and a GOLDEN assertion that the serialized markers do **NOT** contain `impact_score` (constitution guard).
- `deriveDirectives` / `MARKER_MAPPINGS` / clusters / the vitamin-D side-guard (a HIGH vit-D must not emit "supplement D3").
- Self-updating memory: `addMemory` semantic dedup folds a near-duplicate, `supersedeMemory` marks-not-deletes, `memoryForCoach` keeps load-bearing kinds + hides superseded.
- Research/safety pure fns: `verifyCitation` (allowlist accept / unknown strip+uncertain), `safetyGate` (iron+replete ferritin etc. annotated), `isPlausibleSourceUrl` (rejects localhost/IP-literal/non-http).
- Settings round-trip (`proactive_enabled`/`research_enabled` persist) and the migration ladder (fresh DB → `user_version` 30, all applied in order).
A green `npm test` is the deliverable. Keep tests deterministic and offline (no agent CLI, no network — use the `stub` path or call pure fns directly).
**Owns:** `test/**` (new), `package.json` (test script). Does NOT touch `src/**`. Guardrail-clamp tests (V1's new behavior) are added by the orchestrator at integration once V1's exact API is known.

## V3 — Trust & transparency UX/UI (elite UX/UI, verifiable to the user)
**Why:** the user can't see WHY/EVIDENCE behind a suggestion; clamps/verification aren't visible; polish gaps remain.
**Scope (honor the Atelier contract in `docs/DESIGN.md`):**
1. **Evidence is inspectable** — where a directive (Me→Health→Brain) or insight shows a `citation`, add a calm "see the evidence" disclosure that fetches `GET /api/evidence?marker=` and lists the source(s) (title + an outbound link, `rel="noopener noreferrer"`, truncated body). Degrade to the citation string when evidence is empty. Makes a claim verifiable, not asserted.
2. **Clamp/verify transparency** — when an applied proposal was `clamped`, show a calm one-line "adjusted to a safe step — why" note on the apply result; when a meal plan/session was `verified`, a quiet "checked against your floors" badge. Trust through honesty, never alarm.
3. **A calm "What Cairn did" trust panel** (Settings, near Agent health) from `/api/agent-stats` `recent[]` — a quiet activity log of recent agentic runs (op + agent + when + clean/needed-retry), framed as transparency, NOT a grade/score.
4. **Uncertainty made honest** — ensure `uncertain`/uncitable directives + low-confidence reads read tentative consistently across surfaces.
5. **Polish the elite-build follow-ups** — soft fade on skeleton→content swap, the offline-banner placement nicety, any rough edges in the new Brief/provenance/chat-phase surfaces.
MUST bump `public/sw.js` CACHE → `cairn-v50`. Build against the contracts above; degrade gracefully.
**Owns:** `public/**`.

---

## Merge order & quality gates
1. Merge **V1** → `npx tsc --noEmit`.
2. Merge **V2** → `npm test` green (then the orchestrator ADDS guardrail-clamp tests against V1's real API and re-runs).
3. Merge **V3** → `node --check public/*.js`, confirm sw bump.
4. **Quality review** (parallel: correctness/integration, vision-alignment incl. no-scores + the new evidence/trust surfaces, security incl. the evidence endpoint + outbound links + env-denylist). Fix findings.
5. **Boot smoke test** + `npm test` + `npm run build` all green.
6. **Housekeeping**: `CLAUDE.md` (new endpoints/tools, guardrails, `npm test`, env note), `docs/OPERATIONS.md` if relevant, confirm sw bump, this tracker.
7. `trust-build` → `main`.

## Quality gates every stream must pass
- `npx tsc --noEmit` clean (V1) / `npm test` green (V2) / `node --check` (V3).
- ESM `.js` import extensions; mirror new repo capability in BOTH `api.ts` and `mcp.ts` (V1).
- Constitution honored: no numeric scores surfaced, suggestion-not-a-gate (clamps make an *applied* value safe, never block a deliberate user edit), pull-never-push, informational-not-medical.
- Graceful degradation everywhere (verify off / no agent / research empty → calm no-op, never a crash).
- Commit in the worktree with clear messages; don't touch files outside ownership; don't edit `CLAUDE.md`/`docs/*`.

## Progress tracker
- [ ] V1 trust-core — spawned / merged
- [ ] V2 verify-harness — spawned / merged
- [ ] V3 trust-ux — spawned / merged
- [ ] Orchestrator guardrail-clamp tests
- [ ] Quality review + fixes
- [ ] Housekeeping + docs
- [ ] trust-build → main
