# Architecture

## Responsibilities

### Chrome Extension
- Lives inside Chrome.
- Pins exactly one ChatGPT tab.
- Observes the newest user/assistant message in that tab.
- Sends events to localhost WebSocket.
- Receives `send_to_chatgpt`.
- Writes into ChatGPT composer and optionally submits.

### Node.js Relay
- Owns orchestration.
- Keeps task state and dedupe state.
- Decides whether a GPT reply is an executable TASK.
- Calls WorkBuddy Local Assistant API.
- Polls incremental message history.
- Returns WorkBuddy result to ChatGPT.
- Implements pause/resume/stop.
- Writes audit log.

### WorkBuddy adapter
Current endpoints used:

```text
GET  /openapi/v2/localassistant
POST /openapi/v2/localassistant/message
GET  /openapi/v2/localassistant/message?message_id=...
POST /openapi/v2/token       (optional refresh)
```

## State flow

```text
IDLE
  │
  ├─ tagged GPT task
  ▼
WAIT_WORKBUDDY
  │
  ├─ WorkBuddy assistant reply becomes quiet
  ▼
WAIT_GPT
  │
  ├─ next tagged GPT task
  ▼
WAIT_WORKBUDDY
```

Any time:

```text
manual ChatGPT user message
        ↓
      PAUSED
```

Terminal:

```text
r
↓
resume
```

## Message safety

The browser extension fingerprints messages.

The Relay stores:
- seen GPT fingerprints
- expected injected user fingerprints

Therefore a WorkBuddy result injected by the Relay does not get mistaken for a manual user interruption.

## Busy behavior

If GPT produces another tagged TASK while a task is active, it is queued.

The Relay never intentionally runs two WorkBuddy turns concurrently in V0.1.
