# Runtime rules for the agent that edits this repository

Read this before touching `src/`. It exists because the relay is the link between
ChatGPT and WorkBuddy: an agent that breaks its own link looks like a
communication bug, not an agent bug.

## 1. Never kill or restart the relay on your own

The running relay owns the WebSocket on `127.0.0.1:8787`, and the Chrome
extension in the pinned ChatGPT tab is connected to *that* socket. Every
operation that restarts the process leaves the extension talking to a socket
that no longer exists, which produces exactly one observable symptom:

```text
GPT  ->  dead bridge  ->  new relay      (nothing comes back)
```

So:

- **Do not** run `taskkill`, `kill`, or anything that ends the relay process
  because you changed a source file.
- **Do** finish the code change, commit it, and then report that the relay must
  be restarted. The human decides when the link is allowed to drop.
- Killing the relay is only ever acceptable in one situation: the process is
  wedged and nothing else works, and you say so explicitly in your report.

## 2. Restarting is a graceful, explicit operation

```text
relay CLI: restart
```

The `restart` command:

1. refuses while a round is in flight (`currentTask` exists) and tells you to
   stop that round first (`s`);
2. refuses while the relay is paused;
3. otherwise stops the heartbeat, closes the bridge and writes a
   `relay_restart_requested` audit entry with the uptime.

Only then does the process exit, so the port is free for `pnpm start`.
Never use `taskkill /F` for this: the extension is not told anything and a
round can be lost mid-flight.

## 3. How to tell whether the relay is really alive

- The log prints `[relay-heartbeat]` every `HEARTBEAT_MS` (default 30s) with
  the state, the open task, the bridge, WorkBuddy and the pending count.
- If a beat is missing for longer than `HEARTBEAT_STALE_MS` (default 60s), the
  relay writes `heartbeat_stale` to the audit log and logs an error.
  A keystroke in the console usually means the window froze (Windows Quick
  Edit mode) rather than the relay dying.
- `status` in the CLI prints uptime, `lastHeartbeatAt` / `lastHeartbeatAgeMs`,
  `heartbeatStale`, `bridgeAgeMs`, `lastTaskAt` / `lastTaskAgeMs`.

## 4. Long-running terminal

A relay that is only ever started from a plain `cmd.exe` window dies with that
window. Prefer Windows Terminal or a supervisor (`pm2`) for anything that has
to survive a lock screen, and turn off **Quick Edit** in the console
properties. None of this is Relay's business - Relay only reports that it is
still beating.
