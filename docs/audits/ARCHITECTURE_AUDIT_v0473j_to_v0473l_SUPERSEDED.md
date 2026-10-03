# HISTORICAL ARCHITECTURE AUDIT — SUPERSEDED

This document records the architecture audit performed against the
v0.4.7.3j → v0.4.7.3l development state.

Its original PRODUCTION DEPLOY GATE conclusion predates a later-discovered
crash window between INPUT_CONFIRMED and the irreversible WorkBuddy send click.

That crash window was subsequently fixed in:

commit:
410ef4bbcf0ae7812a604bb66ff6009db8ee9bea

tag:
v0.4.7.3m-send-attempt-crash-fence

Therefore this document remains valuable as a historical architecture audit,
but MUST NOT be treated as the current production acceptance record.

Current production acceptance record:

docs/releases/PRODUCTION_E2E_VERIFICATION_v0473m.md

---

<!-- ===== ORIGINAL AUDIT BODY BEGINS (UNCHANGED) ===== -->

# RELIABLE TASK LIFECYCLE — ARCHITECTURE AUDIT REPORT
Baseline: `4ab92a0` · tag `v0.4.7.3j-gpt-intake-attestation`
Mode: READ-ONLY. No source/test/ledger/state was modified. Production smoke003 was read only.

---

## 0. TL;DR

The relay is **architecturally close to a single closed state machine**, and v0.4.7.3j fixed the
most dangerous class of bug (paused/busy intake bypassing acceptance → permanent `gpt_not_found`).
The **steady-state** path is sound: identity attestation, ownership, send-proof and completion are
each enforced in one place.

However the audit finds **two P0 crash-consistency holes** (both narrow, both require a crash in a
specific micro-window and a live bridge), **one P1 operator-disposition gap** (a never-sent,
never-accepted task cannot be cleanly cancelled — `close_without_resend` is the wrong tool and does
not durably forbid re-dispatch), and several **P2 responsibility-drift / duplicated-policy** issues
(including a literal double `TASK_REQUEUED` write).

Recommendation: **do not enter production smoke yet** until at least the P0 crash-window
atomicity and the P1 disposition gap are addressed (can be a single .3k + .3l, or folded).

---

## 1. Current lifecycle (as-built)

```
OBSERVED            onChatGPTAssistantMessage (relay.ts:924)  ── readRelayIntent → task block
  │
  ▼  dispatch.startTask (observedOnGptPage:true)
PHASE A  acceptObservedTask (dispatch-pipeline.ts:1117)
  TASK_PUBLISHED      reconciliation.recordTaskPublished (index.ts:41)
  TASK_ACCEPTED       reconciliation.recordTaskAccepted   (index.ts:135)  ← trusted identity granted HERE
  │
  ▼  PHASE B  scheduling gate (paused / busy / routed)
  ├─ paused/busy, fromQueue=false → queueAcceptedTask (dispatch-pipeline.ts:1162)
  │     TASK_ENQUEUED   (index.ts:151)
  │     owner = pending queue (kind:"gpt_task")
  │
  ├─ idle → runTurn (dispatch-pipeline.ts:515)
  │     currentTask set (status sending)            store.mutate (dispatch-pipeline.ts:600)
  │     DISPATCH_STARTED   reconciliation.recordDispatch (dispatch-pipeline.ts:336)
  │     INPUT_CONFIRMED    (composer holds payload; click NOT yet)   ledger
  │     [click]
  │     SEND_CONFIRMED     (new user-authored turn observed)         ledger   ← "send" proven
  │     RUNNING_CONFIRMED  waitForRunning                             ledger   ← "running" proven
  │     RESULT_RECEIVED     waitForAssistantReply                    ledger
  │     onWorkBuddyResult (relay.ts:1235)
  │       RESULT_PERSISTED   result-pipeline.persist  (enqueue workbuddy_result + status result_pending)
  │       RESULT_DELIVERED   result-pipeline.deliver  (bridge.send_to_chatgpt; removePending)
  │       RESULT_ACKED       chatgpt_send_result ok   (relay.ts:814)  OR lease-expiry path
  │       TASK_COMPLETED     completeCurrentRound/finishRound (relay.ts:1443/1389)
  │       owner released → idle
  │
  └─ failure paths:
        InputNotConfirmedError → requeue (owner=queue, TASK_REQUEUED)
        UnconfirmedDispatchError / DISPATCH_STALLED → currentTask STAYS, RECONCILIATION_REQUIRED
                                (owner = reconciliation-frozen)
        sendIsProven(on crash/uncertain) → freeze, NEVER re-send

Operator dispositions:
  resolveReconciliation   (relay.ts:1847)  lifts hold + requeues frozen live task
  closeReconciledTaskWithoutResend (relay.ts:1980)  writes RECONCILIATION_RESOLVED(disposition:
        close_without_resend); may release a live RECONCILIATION_REQUIRED currentTask
```

**Stage boundaries are correctly separated** (answers Q4):
`click ≠ INPUT_CONFIRMED ≠ SEND_CONFIRMED ≠ RUNNING_CONFIRMED ≠ RESULT_RECEIVED ≠
RESULT_PERSISTED ≠ RESULT_DELIVERED ≠ RESULT_ACKED ≠ COMPLETED`. Each is a distinct ledger event
written by exactly one writer (`relay.noteStage`, relay.ts:1735). `COMPLETED` may be reached
**without** `RESULT_ACKED` (lease-expiry → `finishRound`, relay.ts:1507) — that is a deliberate,
proven path, not a shortcut. The only "skip" is `RUNNING_CONFIRMED` when `waitForRunning` returns
`result_ready` immediately (runTurn, dispatch-pipeline.ts:759) — this still writes `RESULT_RECEIVED`,
so no evidence is lost.

---

## 2. Owner invariant

A task must be owned by exactly one of:
- **A** pending queue (`gpt_task` or `workbuddy_result`)
- **B** `currentTask` (incl. reconciliation-frozen alert stages)
- **C** persisted `workbuddy_result` awaiting delivery/ACK (this is A, kind `workbuddy_result`)
- **D** reconciliation-frozen `currentTask` (alert stage `RECONCILIATION_REQUIRED`/`BLOCKED`/`FAILED`)
- **E** terminal ledger state (`TASK_COMPLETED` / `RECONCILIATION_RESOLVED`)

**Steady-state proofs**
- Live intake + paused/busy → exactly one queue entry (`queueAcceptedTask` de-dupes by `text`,
  dispatch-pipeline.ts:1177). No queue+currentTask double-owner: the intake path never sets
  `currentTask` when it enqueues.
- `flushOnePending` shifts the item off the queue *before* `startTask`; on `pre_send_rejected` it
  calls `retainPendingTask` (restorePending, same id) — so the item is never lost and never
  duplicated (relay.ts:2349, 2391).
- `requeueTask` clears `currentTask` and enqueues — single owner transfer (relay.ts:1558).
- `UnconfirmedDispatchError` / `DISPATCH_STALLED` leave `currentTask` in place (frozen) — owner D.
- `completeCurrentRound`/`finishRound` null `currentTask` then write `TASK_COMPLETED` — owner E.

**Holes (all under crash — see §8):** accepted-but-unowned, queued-but-unrecorded, and
completed-but-ledger-missing-`TASK_COMPLETED` each produce a *spurious* `orphaned_task` freeze
(safe direction) or a *genuinely* lost queue entry. No steady-state double-owner found.

---

## 3. Source / resend invariant

**Trusted identity is granted at `TASK_ACCEPTED`** (§1 Q1). The triple is
`{taskId, taskFingerprint, messageFingerprint(sourceFingerprint)}`. It is written at the instant of
live observation (`observedOnGptPage`), and thereafter the ledger row is durable proof even after
ChatGPT unmounts the bubble. This is exactly what v0.4.7.3j repaired (the old paused/busy early-return
wrote no `TASK_ACCEPTED` → permanent `gpt_not_found`).

**First send authority** (§1 Q3):
- live GPT observation (`observedOnGptPage`, or `gptEvidenceFor` re-read of the page), **or**
- durable `TASK_ACCEPTED` exact triple via `durableSourceProof` (source-proof.ts:74), requiring
  `taskId ∧ taskFingerprint ∧ sourceFingerprint` all match.
- **`TASK_PUBLISHED` can NEVER be proof.** `durableSourceProof` filters only `TASK_ACCEPTED`
  (source-proof.ts:78). `decideDispatch` consults `gptEvidence`/`proof`, never `TASK_PUBLISHED`
  (decision.ts:129-149). ✓

**Resend (retry) authority** — `decideDispatch` returns `resend_allowed` only when
`DISPATCH_STARTED`/`INPUT_CONFIRMED` present, `attempt < maxAttempts`, and live-or-attested
evidence (decision.ts:155-177). The reconcile-side `mayResend` boolean
(reconcile.ts:460 `!blocking && closure===null && has("TASK_REQUEUED") && !hasProvenSend`) is the
single published answer and is wired to never contradict the gate (reconcile.ts:471). ✓

Per-retry-kind answers (§1 Q3 continued):

| retry kind | resend allowed? | basis | duplicate risk |
|---|---|---|---|
| model failure (NoUsableModelError) | no (chain ends) | holdForModelRecovery queues, no re-send | none |
| composer mismatch (InputNotConfirmed) | no (nothing clicked) | requeue, owner=queue | none |
| model quota | yes (same taskId, new model) | quota loop in runTurn, bounded | none (same taskId) |
| cancellation | no | UnconfirmedDispatchError → freeze | none (freeze) |
| timeout | no | UnconfirmedDispatchError → freeze | none |
| send uncertainty | no | SEND_CONFIRM_FAILED → freeze | none (freeze) |
| restart recovery | only if no proven send | decideDispatch resend_allowed | safe (see §8) |
| stale pending | only if not proven + evidence | decideDispatch | safe unless crash window (§8) |

---

## 4. SEND / RUNNING / RESULT boundaries — findings

All boundaries are correctly encoded (see §1). No `fast-result` path skips durable evidence:
- `result_ready` still writes `RESULT_RECEIVED` (dispatch-pipeline.ts:759-781).
- `confirmSend` votes **only** on a *new user-authored turn* (turn-ack.ts:194-252) — assistant
  chrome/cards are kept as evidence, never as a send verdict. This is the .3d/.3e fix and is solid.
- `classifyTurnFailure` no longer pattern-matches answer text (turn-state.ts) — structural DOM only.
- Stale/wrong-task ACK: `completeCurrentRound` rejects `taskId !== currentTask.taskId`
  (relay.ts:1457); `isStaleDispatch` (stage.ts:194) drops echo from an old dispatch;
  `ResultDeliveryLedger` (recovery.ts:171) de-dupes in-process. ✓

**No steady-state duplicate-RESULT / wrong-task-ACK / ACK-after-restart bug found.**

---

## 5. PAUSE / BUSY / RESTART matrix

`init()` (relay.ts:220): **any** `currentTask` on load → force `PAUSED`, require manual resume.
This is the master safety: a restart never auto-sends.

| window | canonical owner after restart | resend? | lose? | dup delivery? |
|---|---|---|---|---|
| PAUSED intake | queue (A) | no (re-decided on resume) | no | no |
| BUSY intake | queue (A) | no | no | no |
| pause during dispatch | frozen currentTask (D) after stop/restart | no (PAUSED) | no | no |
| restart before acceptance | ledger `TASK_ACCEPTED`, no live owner → **orphan freeze** | no (frozen) | lost owner | no |
| restart after acceptance, pre-enqueue | queue entry DB-lost → **genuine lost** | re-decide if resolved+page | yes (queue) | no |
| restart after enqueue | queue (A) | re-decide on resume | no | no |
| restart after INPUT (no SEND) | resume → flush_queue → re-decide | safe (sendIsProven false) | no | no |
| restart after SEND/RESULT_RECEIVED | resume_wait (listen, no re-send) | **no** | no | no |
| restart after RESULT_PERSISTED | redeliver_result | no (re-deliver answer) | no | **P0 window (§8)** |
| restart after RESULT_DELIVERED | redeliver_result | — | — | **P0 window (§8)** |
| restart after RESULT_ACKED/COMPLETED | currentTask null → idle | n/a | no | no |

---

## 6. Operator dispositions — GAP (P1)

**Question:** is there a legal disposition for *"a task that was clearly never sent, but whose
provenance is incomplete for legacy/historical reasons, and the operator decides to CANCEL it — not
claim it completed"*? **Answer: NO.** This is exactly smoke003's shape.

Current dispositions:
- `resolveReconciliation` (relay.ts:1847): lifts hold **and requeues** the frozen live task. Semantics
  = "it may still run." Wrong for "cancel."
- `closeReconciledTaskWithoutResend` (relay.ts:1980): writes `RECONCILIATION_RESOLVED`
  (`disposition: close_without_resend`, **fingerprint `*`**, index.ts:258) and — only if the named
  task is the *live* `currentTask` at stage `RECONCILIATION_REQUIRED` — drops that record
  (relay.ts:2031-2068). Semantics = "WorkBuddy already ran it; stop freezing; never resend."

Why it does **not** fit smoke003:
1. smoke003 is in the **pending queue**, not `currentTask`. The live-release branch is skipped, so
   the `PendingItem` survives in `state.json` — the task remains "owned" by the queue while the ledger
   says "closed." **Inconsistent owner state** (P1).
2. The closure row is written under `taskFingerprint:"*"` and is **not consulted by `decideDispatch`**
   (decision.ts checks only `already_completed/already_running/send_confirmed`). So if the GPT page
   ever re-shows the same envelope, the relay will **dispatch it again** — directly contradicting the
   operator's "do not send." **The close is not durable against re-observation** (P0/P1).
3. It implies *completion* ("WorkBuddy ran it"), which is false for smoke003.

**Needed disposition** (do not implement now, per instructions): a durable **CANCEL / DISCARD** that
- drops the `PendingItem` from the queue (or marks it cancelled),
- writes a **task-identity-scoped** terminal row (e.g. `TASK_CANCELLED` with the concrete
  `taskFingerprint`, or `close_without_resend` scoped to the concrete fingerprint), and
- is read by `decideDispatch` as a hard block (`already_cancelled`/`already_closed`) so re-observation
  can never re-dispatch.

Distinction: `resolve`=requeue(may run); `close_without_resend`=ran, don't resend; **cancel**=never
sent, never will, remove owner → terminal ledger (E) only.

---

## 7. State-machine single source of truth — responsibility drift (P2)

Policy is **mostly centralized** (pipeline = mechanics, store = persistence, reconciliation = evidence/
resend authority, adapter = observation). Remaining drift:

1. **`TASK_REQUEUED` written twice** (relay.ts:1620-1636): two consecutive identical `recordEvidence`
   calls. Pollutes the ledger, inflates evidence, pure bug. → fix: delete one.
2. **"Proven send" defined in three places**: `reconcile.hasProvenSend` (7-event list,
   reconcile.ts:138), `recovery.sendIsProven` (stage-rank ≥ SEND_CONFIRMED, recovery.ts:69), and
   `decideDispatch`'s separate `SEND_CONFIRMED`/`RUNNING_CONFIRMED` checks (decision.ts:107-121). They
   agree today but are three implementations of one invariant. → one `isProvenSend` helper.
3. **Identity conflict checked twice**: `recordTaskPublished` (index.ts:76) and `decideDispatch`
   (decision.ts:82). Complementary but duplicated.
4. **Recovery decides redeliver from `store.status` alone** (recovery.ts:82-111), ignoring the ledger's
   `RESULT_DELIVERED`/`RESULT_ACKED`. This is the root of the §8 P0 duplicate-delivery window — the
   ledger already knows the answer was delivered, but recovery doesn't consult it.
5. **`gpt_not_found` vs `gptEvidence`**: `publishTask` rebuilds `gptEvidence` for queue flushes
   (relay.ts:1694) but the live-intake path passes `observedOnGptPage`. Consistent, but the two
   "where did this come from" inputs live in `decideDispatch` + `durableSourceProof` + `publishTask` —
   acceptable, but worth a one-line contract comment.

---

## 8. Crash consistency — double-write windows

Double-writes are `ledger → store` or `store → ledger`. Restart reconciliation can explain most
(because `init()` forces PAUSED and live state is authoritative for recovery). Exceptions:

| window (crash between) | unrecoverable? | severity |
|---|---|---|
| `noteStage`: store.execution written, ledger event not | live stage ahead of ledger; resume uses store → safe; ledger gap is diagnostics only | P2 |
| `persist`: `store.enqueue(result)` done, `status`/RESULT_PERSISTED not | restart sees `waiting_workbuddy`+outboundId → `resume_wait` → **re-waits → re-persists → DUPLICATE result in queue → DUPLICATE delivery** | **P0** |
| `deliver`: `bridge.send` done, `removePending` not | restart sees `sent_to_gpt`+result in queue → `redeliver_result` → **DUPLICATE delivery to ChatGPT** | **P0** |
| `completeCurrentRound`: `currentTask=null` done, `TASK_COMPLETED` not | live done, ledger sees `running`+orphaned → **spurious `reconciliationHold` freeze** (safe, needs manual resolve) | P1 |
| `acceptObservedTask`→enqueue: `TASK_ACCEPTED` done, queue not | accepted-but-unowned → orphan freeze (safe) | P1 |
| `queueAcceptedTask`: `TASK_ENQUEUED` done, `store.enqueue` not | queued-but-unrecorded → genuinely lost queue entry | P1 |
| `recordDispatch`→runTurn send: `DISPATCH_STARTED` done, `currentTask` set | window is *before* the actual send → re-dispatch safe | none |

**Root cause of both P0s:** the queue-entry removal (`removePending`) and the result re-delivery
decision (`planRecovery` redeliver) are **not atomic with the ledger proof** (`RESULT_DELIVERED`/
`RESULT_ACKED`). Fix: (a) in `deliver`, `removePending` *before* `bridge.send`, or mark the pending
item `delivering` and have recovery skip already-delivered; (b) `planRecovery` must consult the ledger
— if `RESULT_DELIVERED`/`RESULT_ACKED` exist for the dispatch, do **not** re-deliver; (c) in `persist`,
set `status=result_pending` and write `RESULT_PERSISTED` *before* enqueuing, so a queued result always
has `status≥result_pending` and recovery takes the `redeliver_result` (single) path, not the
`resume_wait`→re-persist path.

---

## 9. Old smoke003 — correct disposition (read-only)

Ledger (read, not modified): `TASK_PUBLISHED` (seq41) → `TASK_BLOCKED` (seq42, `gpt_not_found`, legacy
pre-.3j early-return) → `TASK_ENQUEUED` (seq43, `dispatch_not_allowed`/`pre_send_rejection`). **No
`TASK_ACCEPTED`, no `DISPATCH_STARTED`, no `SEND_CONFIRMED`.** Plus a `PendingItem` (kind `gpt_task`)
still in `state.json`, relay currently PAUSED.

Facts: clearly never sent; provenance incomplete (no `TASK_ACCEPTED`); cannot auto-dispatch (page long
unmounted → `gpt_not_found` forever); must not be claimed completed; must not be auto-resent.

**Correct operator action under the FINAL architecture:** a **new CANCEL disposition** (§6) that drops
the queue entry and writes a task-scoped terminal `TASK_CANCELLED`/`close_without_resend` row that
`decideDispatch` treats as a hard block. Until that exists, the honest *interim* action is:
`/control/reconciliation/close?taskId=relay-production-smoke-v0473i-003&disposition=close_without_resend`
— but the auditor must record that this (a) leaves the `PendingItem` in `state.json` (inconsistent
owner), and (b) does **not** durably forbid re-dispatch if the GPT page ever re-shows the envelope.
So the interim close is acceptable only because the page is not expected to re-show a 12h-old bubble;
it is **not** a correct permanent disposition. Do **not** forge `TASK_ACCEPTED`; do **not** mark
completed; do **not** auto-resend.

---

## 10. Required fixes (before next production smoke)

**P0 (crash-consistency, duplicate delivery):**
1. Make result delivery atomic: `removePending` before/with `bridge.send`; recovery must consult ledger
   `RESULT_DELIVERED`/`RESULT_ACKED` and must NOT re-deliver an already-delivered dispatch (recovery.ts:82).
2. In `persist` (result-pipeline.ts:99) set `status=result_pending` + write `RESULT_PERSISTED` *before*
   enqueuing, so a queued result is never re-persisted via `resume_wait`.

**P1 (lifecycle / ownership / disposition):**
3. Add the **CANCEL** operator disposition (§6): drop queue entry + task-scoped terminal row + hard
   block in `decideDispatch`. This is the correct, final home for smoke003.
4. Write `TASK_COMPLETED` *before* nulling `currentTask` in `completeCurrentRound`/`finishRound`
   (relay.ts:1459/1395) to kill the spurious post-crash `orphaned_task` freeze.
5. `closeReconciledTaskWithoutResend` should also drop a matching `PendingItem` and scope the closure to
   the concrete `taskFingerprint` so it durably forbids re-dispatch.

**P2 (maintainability / drift):**
6. Remove the duplicate `TASK_REQUEUED` write (relay.ts:1620-1636).
7. Unify "proven send" into one helper used by reconcile/recovery/decideDispatch.
8. De-duplicate the identity-conflict check (publish vs decideDispatch).

---

## 11. HEALTHY — do NOT touch

- **v0.4.7.3j intake attestation** (Phase A before scheduling) — correct, keep.
- `durableSourceProof` excluding `TASK_PUBLISHED` — correct, keep.
- `confirmSend` user-turn-only voting (turn-ack.ts:194) — correct, keep.
- `init()` force-PAUSED on any `currentTask` — correct master safety, keep.
- `StartTaskOutcome` owner-handover contract + `retainPendingTask` — correct, keep.
- `ResultDeliveryLedger` in-process dedup — correct, keep.
- `advanceStage` monotonic + stale-dispatch guard — correct, keep.
- `reconcile` `mayResend` single boolean — correct, keep.

## 12. Production smoke recommendation

**Not yet.** Two P0 crash-windows (§8) can double-deliver a RESULT to ChatGPT, and the P1 disposition
gap (§6) means a stuck never-sent task has no clean cancel. Ship .3k (P0 atomicity) + .3l (P1 cancel
disposition + COMPLETED-before-release) first, then re-audit, then smoke. Steady-state correctness is
already strong enough that the *happy path* smoke would pass — the blockers are crash-resilience and
operator lifecycle completeness, not normal operation.
