# Adaptive chat routing

This is a routing policy, not a clinical decision-maker. It selects the smallest adequate lane while preserving the user's control and Cairn's calm, suggestion-not-a-gate contract.

## Goals and lanes

The routing objective is useful quality per latency and token budget:

- **capture** handles immediate, bounded records: explicit food, activity, weight, supplement logs, food corrections, and food-photo capture. Other historical edits stay in the conversational path. It should feel instant.
- **coach** handles ordinary, bounded advice using the existing context: today's session, recovery-aware adjustments, and simple food/training questions.
- **deep** handles work needing richer reasoning, current information, a broad plan change, or a health safety boundary. It may take longer and must state that it is thinking more carefully only when that is noticeable.

Safety is monotonic: capture can promote to coach or deep, coach can promote to deep, and no lower-cost preference may demote a safety, current-information, structural-goal, or multi-constraint request. A mixed request takes the highest required lane; logging can still happen as an immediate idempotent capture before the deep response.

## Policy and precedence

1. A clinical/lab/injury/medication risk, an emergency-like symptom, a request for current restaurant/menu/web information, a structural goal/plan change, or several material constraints selects **deep**.
2. An explicit `deep` override selects **deep**. An explicit `fast` override is honored only when it does not violate the first rule.
3. A direct bounded log or food-photo capture selects **capture**. Immediate photo capture is idempotent: retries/reloads reuse a stable client capture key and never create a duplicate record or re-run a model just to recover a receipt. Cairn retains the retry text and key in session-scoped browser storage for up to 15 minutes, and arms a cleanup timer while that session remains active; expiry is also checked whenever it is read. It deliberately does not retain photo bytes in browser storage, so a reload before acknowledgement asks the person to reattach the photo before retrying rather than sending a partial message.
4. Remaining ordinary questions select **coach**. Non-food photos are not assumed to be food: injury/lab photos promote to deep; gear/general-context photos are coach unless another rule applies.

Provider pins are resolved after lane selection: a user-selected provider/model for the current turn wins; then a valid lane-specific provider pin; then the enabled auto order. Disabled or unavailable pins fall through without changing lane. Optional model/reasoning profiles may set low-latency capture, normal coach, and deliberate deep defaults, but are preferences rather than permission to weaken the policy.

Legacy “usual coach mode” remains an explicit compatibility preference for ordinary requests; it cannot override a safety promotion. A user can always ask for fast or deep. “Fast” means fewer deliberation tokens, never skipping the safety gate or turning off routing escalation.

## Context rollout

The first rollout sends the full bounded coaching context to coach/deep requests. This establishes an honest quality baseline and avoids silently losing health, recovery, or life context. Capture sends only the bounded capture payload needed for idempotent logging.

Later context reduction is an experiment, not an assumption: measure route-specific quality, correction rate, safety misses, response time, and token use against the full-context baseline before reducing fields. Keep the full context for deep, clinical, goal, and multi-constraint work until evidence shows a safe alternative.

## Privacy and control

Routing telemetry classifies only operational metadata:

- **public operational:** lane, provider/model profile, timings, token counts, fallback/cancel outcome, and reason categories.
- **sensitive wellness:** health, lab, injury, medication, recovery, nutrition, training, and goal category flags; retain locally and aggregate where practical.
- **highly sensitive content:** photos, message text, lab values, medications, and identifiers; do not put raw content in routing metrics or the offline corpus.

The benchmark corpus is synthetic and anonymized. Provider calls follow the configured local/provider privacy boundary; routing itself must not add a new network call.

## Failure, Stop, and fallback semantics

Escalation is one-way for a request. If a selected provider fails, try an enabled provider/profile for the **same or higher** lane; never silently fall back from deep to capture or ordinary coach. A missing provider produces a calm, persisted failure with the attempted providers and leaves already-committed idempotent captures intact. Stop cancels pending provider work promptly, emits the existing canceled terminal state, and never applies speculative coaching actions after cancellation. It never rolls back a previously acknowledged, idempotent direct capture.

## Operator metrics and acceptance targets

Track route counts and reason categories, p50/p95 routing and end-to-end latency, input/output tokens, provider/profile/fallback rate, explicit override rate, Stops/cancels, duplicate-capture suppressions, correction rate by lane, and safety-promotion/miss reviews. Keep raw content out of these metrics.

Launch targets:

- 100% pass on the deterministic offline corpus, including all mandatory reason categories.
- Zero known unsafe demotions in corpus or review (clinical, medication, injury, current-info, structural, and multi-constraint cases always reach deep).
- Capture remains idempotent under retry; no duplicate receipt/record in a focused integration test.
- No provider/CLI/network/DB use from the offline benchmark harness.
- Establish a production baseline for quality, p50/p95 latency, tokens, fallback, Stop, and correction metrics before enabling context reduction.

## Launch and rollback

Launch behind a routing setting with legacy mode retained. Start with shadow classification/metrics, compare to the legacy path, then enable capture and coach routing before deep routing. Roll back by disabling adaptive routing or selecting legacy mode; preserve user override and existing per-task/provider pins. Rollback must not alter prior logs, conversation records, or provider configuration.

## Offline benchmark versus real-model quality

`npm run bench:chat-routing` imports the built pure classifier and evaluates synthetic inputs only. It proves deterministic routing correctness and required explanations; it does **not** invoke a CLI, network, database, model, image recognizer, or evaluate coaching quality.

Connected real-model quality evaluation is separate and opt-in: it measures answer helpfulness, safety review, context fidelity, latency, and token spend using approved test accounts and data controls. Passing the offline benchmark is a release gate for policy mechanics, not evidence that a provider gives high-quality coaching.
