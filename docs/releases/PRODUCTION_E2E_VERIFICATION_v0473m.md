# Zhixing Relay v0.4.7.3m Production E2E Verification

This document is the current production acceptance record for the zhixing-relay
relay. It supersedes the historical architecture audit in
`docs/audits/ARCHITECTURE_AUDIT_v0473j_to_v0473l_SUPERSEDED.md`, whose deploy-gate
conclusion predates the crash window fixed below.

---

## Baseline

commit:
410ef4bbcf0ae7812a604bb66ff6009db8ee9bea

tag:
v0.4.7.3m-send-attempt-crash-fence

branch:
main

该 tag 精确指向已部署并完成生产 E2E 验证的代码基线。

---

## What v0.4.7.3m fixed

v0.4.7.3m introduced a durable SEND_ATTEMPTED fence between
INPUT_CONFIRMED and the irreversible WorkBuddy send click.

核心顺序：

```
DISPATCH_STARTED
→ INPUT_CONFIRMED
→ SEND_ATTEMPTED
→ click
→ SEND_CONFIRMED
→ RUNNING_CONFIRMED
```

`SEND_ATTEMPTED` 不是 send proof。它是写在点击之前的 durable uncertainty
fence：一旦崩溃发生在 click 之后、`SEND_CONFIRMED` 之前，账本里留下的是一行
「此处曾尝试发送」，而不是一个看起来从未尝试过的任务。因此
crash-after-click / before-confirm 不会被误读为可安全重发，不会触发 blind
resend（重复执行 WorkBuddy 任务）。

---

## Historical smoke disposition

smoke001: completed in WorkBuddy, historical confirmation false negative,
closed_without_resend.

smoke002: completed in WorkBuddy, historical confirmation false negative,
closed_without_resend.

smoke003: confirmed never dispatched, terminated with TASK_CANCELLED /
cancel_unsent, never resend.

以上三个任务均已终结，不需要再次处理。

---

## Final production smoke

taskId:
relay-production-smoke-v0473m-005

model:
hy3

WorkBuddy message id:
u543bda24:369

result:
ZHIXING_SMOKE_V0473M_005_OK

完整观察到的 durable lifecycle：

```
TASK_PUBLISHED
TASK_ACCEPTED
TASK_ENQUEUED
DISPATCH_STARTED
INPUT_CONFIRMED
SEND_ATTEMPTED
SEND_CONFIRMED
RUNNING_CONFIRMED
RESULT_RECEIVED
RESULT_PERSISTED
RESULT_DELIVERED
RESULT_ACKED
TASK_COMPLETED
```

特别注明：

The RESULT was visibly and automatically delivered back into the same
ChatGPT conversation.

因此真实生产闭环：

```
ChatGPT
→ Relay
→ WorkBuddy
→ Relay
→ ChatGPT
```

was observed end-to-end. 

结论：

**PRODUCTION E2E: PASS**

---

## Final runtime state

state=PAUSED
paused=true
currentTask=null
pending=[]
bridge=true
workbuddy=true
reconciliationHold=false
executionStage=null
currentDispatchId=null
currentAttempt=null

production intentionally left PAUSED after acceptance.

---

## Non-blocking follow-up observations

两类 P2，均不阻塞验收，不构成本次生产验收的失败项：

1. `TASK_ACCEPTED` currently appears twice for a paused task that is later
   resumed. Only one `DISPATCH_STARTED` occurred and no duplicate execution was
   observed. Treat as P2 lifecycle/audit noise unless later evidence shows
   semantic impact.

2. `RESULT_ACKED` diagnostic detail may show `sent=false` / `staged=false` even
   though smoke005 was visibly delivered into ChatGPT. Treat this as P2 ACK
   diagnostic/semantic cleanup, not evidence of lost delivery, because the final
   production smoke provided direct UI delivery evidence.

---

## Acceptance decision

v0.4.7.3m is the accepted stable production baseline for future development.

No smoke task from smoke001 through smoke005 should be resent.

The tag must not be moved.

Future development starts after this baseline.
