/**
 * Runtime health signals for a relay that is meant to stay up for days.
 *
 * Everything in here is a pure function over explicit numbers, so the
 * watchdog rules can be tested without a running process or a clock.
 */

/** What one heartbeat reports about the relay and its surroundings. */
export type HeartbeatView = {
  state: string;
  paused: boolean;
  currentTask: string | null;
  bridge: boolean;
  workbuddy: boolean;
  pending: number;
};

/** Compact "1h 2m 3s" style duration, used for uptime and ages. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** ms ago, or null when there is nothing to measure yet. */
export function formatAge(ms: number | null): string | null {
  if (ms === null) return null;
  return formatDuration(ms);
}

/** How long since the last beat, or null if the relay never beat. */
export function heartbeatAgeMs(
  lastHeartbeatAt: number | null,
  now: number,
): number | null {
  if (lastHeartbeatAt === null) return null;
  return Math.max(0, now - lastHeartbeatAt);
}

/**
 * True when the heartbeat is overdue.
 *
 * A relay that has not beat once yet is only late once it has been alive for
 * longer than the stale window - otherwise a fresh start would scream about
 * a heartbeat it has not had time to send.
 */
export function isHeartbeatStale(input: {
  lastHeartbeatAt: number | null;
  startedAt: number;
  now: number;
  maxAgeMs: number;
}): boolean {
  const age =
    input.lastHeartbeatAt === null
      ? input.now - input.startedAt
      : input.now - input.lastHeartbeatAt;

  return age >= input.maxAgeMs;
}

/**
 * Whether the watchdog should speak up on this tick. One warning per
 * episode: the moment the heartbeat goes overdue it says so, and it stays
 * quiet until the relay has beaten at least once more.
 */
export function shouldWarnHeartbeat(input: {
  stale: boolean;
  wasWarned: boolean;
}): boolean {
  return input.stale && !input.wasWarned;
}

/** The `[relay-heartbeat]` block printed on every beat. */
export function formatHeartbeat(
  now: number,
  view: HeartbeatView & { startedAt: number; lastHeartbeatAt: number | null },
): string {
  const age = heartbeatAgeMs(view.lastHeartbeatAt, now);

  return [
    "[relay-heartbeat]",
    `time=${new Date(now).toISOString()}`,
    `age=${formatAge(age) ?? "n/a"}`,
    `uptime=${formatDuration(now - view.startedAt)}`,
    `state=${view.state}`,
    `paused=${view.paused ? "true" : "false"}`,
    `currentTask=${view.currentTask ?? "null"}`,
    `bridge=${view.bridge ? "true" : "false"}`,
    `workbuddy=${view.workbuddy ? "true" : "false"}`,
    `pending=${view.pending}`,
  ].join("\n");
}
