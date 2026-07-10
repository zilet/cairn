# Codex multi-agent orchestration

This is the reusable execution protocol for large Cairn builds. It translates the proven Fable/Opus/Sonnet pattern into Codex team roles: **Sol is the primary orchestrator, integrator, and final reviewer; Terra is the default implementation worker for bounded tracks.** Other available models may be used when their reasoning strength, latency, or price better fits a specific packet.

The names describe intended roles, not a guarantee that a particular model was actually selected. Model aliases and routing vary by Codex runtime, account, and deployment. At the start of a run, inspect the orchestration controls or agent metadata that the runtime exposes. Record what was verifiably selected. If the runtime does not expose model identity or cannot honor an explicit choice, say so and proceed with role-based assignments without claiming that Sol or Terra ran.

## Operating principle

Use parallelism to shorten independent work, not to multiply speculative work. One agent owns the outcome and the integrated tree. Workers receive small, testable packets with explicit file ownership and return evidence, not confidence statements.

The orchestrator must:

- hold the product objective and architectural invariants;
- decompose work at real dependency boundaries;
- serialize shared contracts before parallel consumers branch;
- prevent overlapping writes unless the overlap is intentional and merge-ordered;
- review every worker diff and independently verify it;
- integrate sequentially into the designated branch;
- continue until the goal's definition of done is met or a genuine external blocker remains.

Workers must:

- stay inside the assigned packet and file boundary;
- inspect relevant source before editing;
- preserve unrelated work;
- test in proportion to risk and report exact commands and results;
- stop and escalate when a contract, dependency, or ownership boundary is unclear;
- never merge, deploy, broaden scope, or declare the overall goal complete.

## Role and model policy

### Sol: orchestrator, integrator, reviewer

Use Sol for work where global context and judgment dominate token cost:

- architecture and dependency decomposition;
- contracts, safety boundaries, migration strategy, and cross-domain policy;
- authoring worker packets and assigning file ownership;
- reviewing full diffs and reconciling conflicting recommendations;
- integration, conflict resolution, release gates, and final definition-of-done audit;
- high-risk fixes involving health safety, authorization, autonomy, data integrity, concurrency, or irreversible state.

Sol should avoid spending its context on mechanical edits that Terra can complete from a frozen contract. It should remain available to answer worker questions, review completed tracks promptly, and adjust the plan when evidence changes.

### Terra: bounded implementation

Terra is the default for implementation tracks whose inputs and acceptance criteria are concrete:

- repository/domain modules against an agreed contract;
- routes and MCP wrappers over existing shared services;
- client components following established design patterns;
- tests, fixtures, schema wiring, documentation updates, and mechanical refactors;
- isolated bug fixes with a reproduced failure and known ownership boundary.

Give Terra the smallest coherent vertical slice that it can build and verify independently. Prefer one meaningful track over a bag of unrelated edits.

### Other models

When the runtime offers additional models, choose by task shape rather than prestige:

| Task shape | Preferred capability | Cost/speed posture |
| --- | --- | --- |
| Architecture, safety, concurrency, ambiguous root cause | strongest available reasoning model, normally Sol | spend more to avoid rework or unsafe integration |
| Bounded feature implementation with clear contracts | Terra | default balance of quality, speed, and spend |
| Repetitive test cases, generated-doc checks, inventories, simple copy edits | fastest reliable lower-cost model | use only with exact acceptance checks |
| UX review or independent adversarial review | a model other than the author when available | buy independence where it can reveal blind spots |
| Large source audit or comparison | fast model for evidence gathering, Sol for conclusions | separate retrieval cost from judgment cost |
| Clinical, security, authorization, migration, or autonomous-write review | Sol plus deterministic tests; optional independent strong reviewer | do not economize on the final safety judgment |

Do not spawn an agent merely because a slot is free. Parallel work has coordination and integration cost. A task should be delegated only when it is bounded, can proceed independently, and leaves useful local work for the orchestrator.

### Verifying model selection

Before assigning the first track:

1. Inspect the runtime's agent/model controls and available agent metadata.
2. Request Sol for the root/orchestrator and Terra for bounded workers when those controls exist.
3. Record verified model names or aliases in the run log or goal update.
4. If selection is implicit, unavailable, or hidden, record `model routing: runtime-managed/unverified`.
5. Never infer the underlying model from response style, speed, or the requested alias.

Model choice is an optimization, not an acceptance criterion. Correctness is established by source review, deterministic gates, and integrated behavior.

## Start with a persistent goal

For a build intended to run to completion, create a `/goal` before implementation. The goal should contain the outcome, not a list of hoped-for activities.

Suggested goal form:

```text
/goal Implement docs/ELITE-BRAIN-PLAN.md through its stated definition of done,
using gated multi-agent phases, preserving Cairn's constitution and safety floors,
and finishing with all required offline, connected-agent, browser, and deployment
validation that is available in the target environment.
```

The orchestrator then:

1. reads the controlling plan and repository instructions;
2. records the current branch, commit, dirty files, available runtimes, and target environment;
3. turns the plan into a live phase/track board;
4. starts only the tracks whose dependencies are satisfied;
5. updates the goal as evidence lands;
6. continues through integration and validation without waiting for repeated user prompts.

Do not mark the goal complete because a phase finished, the token budget is low, or workers returned. Complete means the controlling plan's definition of done is actually satisfied. Mark blocked only for a genuine unresolved external dependency or required product decision after safe alternatives have been exhausted; name the blocker and the exact resumption condition.

## Decomposition and dependency gates

Split work by dependency graph, not by an arbitrary number of agents.

Use this sequence:

1. **Discovery gate.** Verify current implementation, controlling docs, dirty-tree ownership, target runtime, and acceptance commands.
2. **Kernel gate.** Land shared schemas, types, safety floors, protocol contracts, and test harnesses serially. Review these before any consumer branches.
3. **Parallel implementation.** Branch bounded tracks from the same reviewed kernel commit.
4. **Track gate.** Each worker proves its packet locally and returns a structured handoff.
5. **Integration gate.** Sol reviews and merges tracks one at a time in declared order, re-running affected gates after each merge.
6. **Cross-track audit.** Inspect every consumer of changed contracts, shared caches, event buses, settings, migrations, and public types.
7. **Release gate.** Run the merged-tree suites, scenario evaluation, browser checks, and target-device validation required by the controlling plan.

A downstream track must not start from a draft interface that is still changing. If early parallel discovery is useful, make it read-only and require findings rather than edits.

For `docs/ELITE-BRAIN-PLAN.md`, follow its phase graph: Phase 0 is serialized; Phase 1 branches only after the kernel merges; Phase 2 branches only after its named Phase-1 dependencies merge; Phase 3 follows evaluator, autonomy, read-tool, and conference foundations.

## Worktree and branch protocol

Isolated git worktrees are the default when the execution environment supports them.

### Preferred isolated mode

- Sol chooses and records the authoritative base commit. In Cairn, verify whether local `main` is authoritative before assuming `origin/main` is current.
- Create one branch and worktree per track from that exact commit.
- Use descriptive names, for example `brain/phase1-ledger` and `.worktrees/brain-phase1-ledger`.
- A worker edits only its worktree and assigned files. It does not rebase, merge another track, bump shared release/cache versions, or deploy.
- The worker commits a reviewable track or returns a clean diff according to the run's integration policy.
- Sol reviews in the worker worktree, reruns its gates, then integrates into the designated branch sequentially.
- After integration, Sol runs conflict-aware tests on the combined tree; passing tests in isolated worktrees are necessary but not sufficient.

### Shared-checkout fallback

Some Codex collaboration runtimes give all agents the same filesystem and do not automatically isolate child agents. Verify this before spawning workers. If agents share one checkout:

- assign disjoint file ownership before edits begin;
- prohibit workers from formatting the repository, switching branches, committing, merging, or editing shared generated/version files;
- reserve common contracts and integration hotspots for Sol;
- have workers announce any discovered need to touch an unowned file and wait for reassignment;
- inspect `git diff` and `git status` between track completions to attribute changes safely.

Do not simulate isolation by assuming that a branch name means separate filesystems. If safe ownership cannot be guaranteed, serialize the overlapping work.

### Dirty-tree rule

Existing modifications belong to the user or another track unless ownership is explicitly established. Preserve them. Never clean, reset, checkout, stash, or overwrite unrelated changes to make integration easier. If an assigned file is already modified, Sol determines whether to rebase the packet, transfer ownership, or serialize the work.

## Task packet contract

Every worker receives a written packet. Use this template:

```markdown
## Track <id>: <name>

Role/model request: Terra (verify runtime selection; otherwise report unverified)
Base commit: <sha>
Branch/worktree: <branch and path, or shared-checkout mode>
Goal: <one observable outcome>
Depends on: <merged gates/contracts>

Read first:
- <repo instructions and controlling plan sections>
- <relevant source/tests>

Owned files:
- <exclusive paths or modules>

Do not touch:
- <shared contracts, generated files, cache/version files, other tracks>

Required work:
1. <bounded deliverable>
2. <bounded deliverable>

Acceptance:
- <behavioral invariant>
- <specific tests>
- <safety/backward-compatibility condition>

Verification:
- `<exact command>`
- `<exact command>`

Handoff:
- summary of behavior changed;
- files changed;
- commands and exact results;
- risks, assumptions, and follow-ups;
- commit SHA or diff state.

Escalate if:
- <contract ambiguity, overlap, unsafe migration, missing environment, etc.>
```

Packets must state both what to do and what not to do. Include the behavioral invariant, not only filenames. A worker should be able to decide whether it is done without inventing product policy.

## File ownership and shared hotspots

Sol owns files that coordinate multiple tracks unless ownership is deliberately transferred:

- shared contracts and barrel exports;
- `src/db.ts` and `src/migrate.ts` when multiple schema tracks exist;
- `src/coachOps.ts`, `src/runChosen.ts`, and global agent/runtime policy;
- common event buses, scheduler registration, settings schema, and feature flags;
- `public/sw.js` cache version;
- generated `docs/API.md` and `docs/MCP-TOOLS.md`;
- release notes, architecture history, and controlling-plan status.

When several tracks need the same shared file, choose one of three patterns:

1. move the shared change into the serialized kernel;
2. assign the file to one track and make other tracks depend on it;
3. keep the file integrator-owned and have workers return precise requested edits or expose extension points elsewhere.

Avoid "we will resolve it later" ownership. Merge conflict resolution can preserve syntax while silently breaking behavior.

## Testing protocol

Workers run the narrowest relevant checks during development and the packet's full track gate before handoff. Sol independently reruns them; do not accept a worker's summary as proof.

For Cairn, apply these defaults unless the controlling plan requires more:

- use Node 24;
- keep tests deterministic and offline unless a command is explicitly an opt-in connected-agent check;
- run focused `node:test` cases while iterating;
- run `npm test` for a completed implementation track;
- run `npm run brain:eval` for elite-brain contracts and longitudinal scenarios;
- run `npm run verify:full` on every integrated phase;
- run `npm run brain:eval:agent` before brain releases or major prompt/model changes when connected agents are available;
- run `npm run smoke:browser` when user-visible behavior changes;
- regenerate and verify API/MCP docs when protocol surfaces change;
- scope Biome to touched files; do not run a whole-repo formatter against a dirty tree.

Capture exit codes honestly. Avoid shell pipelines that report the last process's status instead of the test command's. When a test cannot run, report `not run`, why, and what evidence remains missing.

Tests should cover boundaries, not just happy paths:

- authorization and unavailable capabilities;
- migrations and fresh-database schema;
- cancellation, timeouts, retries, and fail-soft behavior;
- duplicate/coalesced events and out-of-order outcomes;
- safety clamps and autonomy-tier invariants;
- stale data, missing data, confounders, and inconclusive verdicts;
- rollback/undo and backward compatibility;
- public output that must not leak internal scores, secrets, or chain-of-thought.

## Review and integration

Sol reviews every track as if it came from an external contributor:

1. compare the diff with the packet and controlling plan;
2. inspect all changed code, tests, schema, prompts, and public contracts;
3. look for scope drift, duplicated domain logic, missing surface parity, and unsafe prompt-only policy;
4. run the track gate independently in its worktree;
5. request fixes from the same worker while context is warm;
6. integrate in dependency order, one track at a time;
7. rerun affected tests after each merge;
8. perform a whole-phase consumer audit and full gate on the combined tree.

The author should not be the only reviewer of high-risk logic. When capacity permits, use a separate strong agent for an adversarial read of autonomy, clinical, security, migration, concurrency, and agent-tool authorization changes. Sol still owns the conclusion.

Integration-only responsibilities include:

- resolving overlaps according to the frozen contract;
- a single service-worker cache bump for the integrated client-asset set;
- generated documentation refreshes;
- feature-flag defaults and rollout posture;
- architecture/history documentation for what actually shipped;
- target-device deployment and live validation when authorized.

## Communication and progress

Keep the user informed at phase boundaries and during long-running gates. Report evidence in three separate states:

- **implemented locally** — code exists in an isolated or shared working tree;
- **integrated and verified** — combined branch passes its required gates;
- **deployed and live-validated** — target runtime is updated and behavior was observed there.

Do not call local completion "shipped." Do not hide a failed track behind progress on other tracks. When work changes the plan, state the evidence, the changed assumption, and the updated dependency graph.

## Escalation rules

Workers escalate to Sol when:

- required behavior conflicts with the constitution or safety floors;
- a dependency contract is missing or inconsistent;
- an owned change requires an unowned/shared file;
- a migration or data transformation could be destructive;
- runtime capabilities, model selection, credentials, or target data are unavailable;
- tests reveal a cross-track regression;
- the requested behavior requires new user authority, external communication, or deployment scope.

Sol should resolve ordinary implementation ambiguity from source and the controlling plan. Ask the user only when the choice materially changes product intent, safety posture, external state, or authority. A missing optional model is not a blocker: reassign the role and record unverified/runtime-managed routing.

## Stop, cancel, and recovery behavior

- A worker stops at its packet boundary and waits; it does not begin a neighboring track.
- Sol may cancel or re-scope a worker when the kernel changes, ownership overlaps, or evidence invalidates the packet.
- Preserve useful diffs before interruption and record whether they are safe to integrate.
- After a restart or context compaction, reconstruct state from the persistent goal, git status, branch/worktree list, track handoffs, and test evidence. Do not restart completed work blindly.
- If one track blocks, continue only with tracks that are genuinely independent. Do not bypass a dependency gate to keep agents busy.
- Goal persistence does not broaden authority. It means continue safe, in-scope work until done; it does not authorize destructive git operations, external messages, production deployment, or clinical decisions that were not already in scope.

## Completion audit

Before completing the `/goal`, Sol verifies:

- every controlling-plan acceptance criterion maps to code and test or documented live evidence;
- all phase dependencies and feature-flag transitions are accounted for;
- the merged tree, not only worker trees, passes required gates;
- cross-surface REST/MCP/client behavior remains coherent;
- database and migration behavior works for fresh and upgraded installs;
- autonomous actions are bounded, reversible, explainable, and ledgered;
- connected-agent and target-device checks are either passed or explicitly identified as unavailable blockers;
- user/parallel changes are preserved;
- the final status distinguishes local, integrated, and deployed proof;
- the repository is left in the agreed branch/commit state.

Only then mark the goal complete and provide a concise handoff: outcome, key architectural choices, verification evidence, deployment state, and any deliberately deferred work.

