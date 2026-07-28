# Elite Coaching Quality Plan

**Status (2026-07-28):** Waves 0–4 are implemented locally. Independent review accepted the
integrated change set and the complete deterministic verification gate passed across 423 test files.
The authoritative pre-Start preview, compare-and-set acceptance, session-bound movement
observations, in-card bounded choices, deterministic strength/endurance outcome read, and sparse
movement-response retrieval are present in the current review-ready tree. The Raspberry Pi is still
running an older build, so live behavior remains evidence of the prior failure mode until a
separately authorized deploy and post-deploy audit.

This plan applies Cairn's constitution to the coaching loop: keep a stable program, make bounded
day-level adjustments from current evidence, record what actually happened, and change future
training only from repeated comparable outcomes or an explicit athlete decision. It does not
diagnose, prescribe clinical rehabilitation, expose a score, or turn a suggested rest day into a
gate.

## 1. Quality ledger

| Priority | Improvement | Why it matters | Current disposition |
|---|---|---|---|
| P0 | Authoritative preview and acceptance | The athlete must start the exact session they reviewed, even across stale tabs or changing recovery inputs. | Implemented locally; Pi validation pending |
| P0 | Session-bound movement observations | Pain-free or pain-present feedback must attach to the exact date, session, symptom episode, and canonical movement without being lost offline. | Implemented locally; Pi validation pending |
| P0 | In-card bounded choices | The useful coaching moment is beside the exercise: ease the athlete-chosen dose, use a known-tolerable same-pattern option, stop, or skip today without mutating the weekly plan. | Implemented locally; Pi validation pending |
| P1 | Movement-specific evidence retrieval | Unrelated recent workouts must not hide the two newest comparable outcomes for a movement and prescription intent. | Implemented locally |
| P1 | Explainable endurance outcomes | Accepted cardio prescriptions should reconcile against actual duration, distance, intensity, and completion before any progression is considered. | Factual reconciliation implemented locally; automatic progression intentionally absent |
| P1 | Hybrid week sequencing | A hard lower-body day and a long or quality endurance session should be coordinated prospectively, not only corrected after the conflict. | Next program |
| P1 | Same-day chronology | A hard effort before lifting, after lifting, and a time-unknown import are not equivalent causal evidence. | Requires trustworthy timestamps |
| P2 | Durable tolerable-substitution contract | User- or clinician-authored avoid/known-tolerable movement constraints should remain explicit, dated, and reversible. | Requires product decision; no medical inference |

## 2. Multi-wave execution

### Wave 0 — establish current truth

- Trace weekly rationale, daily decision, accepted composition, session logging, outcome
  reconciliation, progression, outbox, and Pi runtime as separate layers.
- Classify every finding as confirmed in local code, confirmed on the older live build, or requiring
  deployment to validate.
- Rank work by athlete trust first, then coaching value, then implementation cost.

**Exit:** every implementation item has a deterministic acceptance test and a named autonomy or
safety boundary.

### Wave 1 — durable movement observation

- Add one shared session-bound command for `pain_present` and `pain_free`.
- Validate the exact session/date pair and canonical movement exposure.
- Require an explicit relevant active symptom for pain-free evidence; never infer resolution or
  clearance.
- Create a new pain-present symptom plus its movement observation atomically when the athlete names
  a new area.
- Make pain-present win contradictory same-exposure ordering.
- Put the REST and MCP surfaces over the same command and include the REST mutation in durable
  idempotent replay.

**Exit:** lost responses, retries, stale session IDs, unrelated symptoms, and contradictory tap
order are covered by tests.

### Wave 2 — coaching in the exercise card

- Add a quiet **Movement check** disclosure to a strength exercise card.
- With a relevant active symptom, offer **Pain-free today** and **Pain present** for that exact
  movement and symptom episode.
- Without one, offer **Something hurts** and require the athlete to name the area.
- After pain is present, offer only bounded current-session choices:
  - **Ease this:** the athlete chooses the lower load, shorter duration, or smaller dose; Cairn does
    not invent a safe percentage.
  - **Use another movement:** show same-pattern ideas, clearly framed as options the athlete already
    knows are tolerable, never as medical clearance.
  - **Stop here:** preserve completed work and mark the outcome context-shaped.
  - **Skip today:** use the existing durable session skip before any set is logged.
- Share the workout FIFO and attention barrier with prepare, sets, skip, and finish so an offline
  symptom write cannot be overtaken by later work.
- Never call the future-program swap action from this surface.

**Exit:** the same behavior works on Today and the focused Session surface, survives offline replay,
and produces a symptom-aware non-comparable outcome without changing the weekly plan.

### Wave 3 — consume outcomes correctly

- Retrieve the newest matching movement and prescription-intent outcomes before applying the
  bounded evidence window.
- Preserve the existing two-comparable-exposure rule and every recovery, symptom, partial-session,
  athlete-override, travel, illness, and endurance confounder.
- Reconcile a late symptom observation into the affected outcome so progression cannot race ahead
  of the athlete's feedback.

**Exit:** two clean sparse exposures remain discoverable behind unrelated workouts, while newer
matching contrary evidence wins.

### Wave 4 — adversarial acceptance

- Regenerate API/MCP inventories and built client output.
- Run scoped typecheck and behavior tests while each wave is in flight.
- Run one independent read-only review of the integrated change set.
- Run the complete deterministic test suite only after integration is stable.
- Leave the tree unstaged and review-ready unless the user separately asks to commit, deploy, or
  publish.

**Exit:** no blocking review findings, generated artifacts are current, the full suite passes, and
live proof is described separately from local proof.

## 3. Deferred programs

### Endurance progression learning

Accepted cardio prescription versus actual effort is now durable and explainable. The implemented
slice records facts and confounders only. A later program may decide whether repeated comparable
evidence is sufficient to propose mileage, intensity, or interval changes; structural changes must
continue through the existing proposal, decision ledger, compare-and-set, and Undo boundary.

### Hybrid look-ahead

Coordinate planned long or quality endurance work with lower-body strength before the week collides.
Easy endurance should not unnecessarily displace strength, and the athlete can still choose the
adjacent sessions with the trade-off stated plainly.

### Dated movement constraints

Add an explicit athlete/clinician-authored record for movements or positions to avoid, known
tolerable alternatives, source, observed date, and recheck date. Stale evidence must become visibly
stale; it must never silently clear itself or grow into anatomy-specific medical advice.

## 4. Live acceptance checklist

After deployment is explicitly requested:

1. Confirm the Pi build identity matches the reviewed local revision.
2. Preview a normal session, change a relevant input, and prove stale Start returns fresh no-write
   truth.
3. Use **Train anyway** and verify the UI distinguishes the conservative policy read from the
   athlete's choice and its retained caps.
4. Record pain present beside one movement, lose the response, replay it, and prove one symptom
   episode and one movement observation exist.
5. Finish a partial symptom-shaped session and confirm an outcome row is written and no progression
   promise appears.
6. Complete two clean comparable exposures separated by unrelated sessions and confirm the movement
   response remains legible.
7. Test an offline prepare followed by movement observation, set logging, skip, and finish; confirm
   FIFO ordering and the attention barrier across a reload and a second tab.
