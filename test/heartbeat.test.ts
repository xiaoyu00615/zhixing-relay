import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatDuration,
  formatHeartbeat,
  heartbeatAgeMs,
  isHeartbeatStale,
  shouldWarnHeartbeat,
} from "../src/heartbeat.js";

const STARTED = Date.parse("2026-10-01T10:00:00.000Z");

describe("heartbeat formatting", () => {
  it("spells short durations in seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(12_500)).toBe("12s");
  });

  it("carries minutes and hours once they add up", () => {
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_725_000)).toBe("1h 2m 5s");
  });

  it("returns null for an age that was never measured", () => {
    expect(formatAge(null)).toBeNull();
    expect(formatAge(5_000)).toBe("5s");
  });

  it("measures the age since the last beat", () => {
    expect(heartbeatAgeMs(STARTED, STARTED + 3_000)).toBe(3_000);
    expect(heartbeatAgeMs(null, STARTED + 3_000)).toBeNull();
    // A clock that stepped backwards must not report a negative age.
    expect(heartbeatAgeMs(STARTED + 5_000, STARTED + 1_000)).toBe(0);
  });

  it("prints one field per line, including the task and the queue", () => {
    const block = formatHeartbeat(STARTED, {
      startedAt: STARTED - 90_000,
      lastHeartbeatAt: STARTED,
      state: "WAIT_GPT",
      paused: false,
      currentTask: "t-1",
      bridge: true,
      workbuddy: true,
      pending: 2,
    });

    expect(block.split("\n")).toEqual([
      "[relay-heartbeat]",
      "time=2026-10-01T10:00:00.000Z",
      `age=0s`,
      "uptime=1m 30s",
      "state=WAIT_GPT",
      "paused=false",
      "currentTask=t-1",
      "bridge=true",
      "workbuddy=true",
      "pending=2",
    ]);
  });

  it("prints null instead of a task id when no round is open", () => {
    const block = formatHeartbeat(STARTED, {
      startedAt: STARTED,
      lastHeartbeatAt: null,
      state: "IDLE",
      paused: false,
      currentTask: null,
      bridge: false,
      workbuddy: false,
      pending: 0,
    });

    expect(block).toContain("currentTask=null");
    expect(block).toContain("age=n/a");
    expect(block).toContain("uptime=0s");
  });
});

describe("heartbeat staleness", () => {
  it("is not stale in the first second of life", () => {
    expect(
      isHeartbeatStale({
        lastHeartbeatAt: null,
        startedAt: STARTED,
        now: STARTED + 1_000,
        maxAgeMs: 60_000,
      }),
    ).toBe(false);
  });

  it("goes stale once the process outlived the window without a beat", () => {
    expect(
      isHeartbeatStale({
        lastHeartbeatAt: null,
        startedAt: STARTED,
        now: STARTED + 60_000,
        maxAgeMs: 60_000,
      }),
    ).toBe(true);
  });

  it("goes stale when the last known beat is older than the window", () => {
    expect(
      isHeartbeatStale({
        lastHeartbeatAt: STARTED,
        startedAt: STARTED - 300_000,
        now: STARTED + 61_000,
        maxAgeMs: 60_000,
      }),
    ).toBe(true);

    expect(
      isHeartbeatStale({
        lastHeartbeatAt: STARTED,
        startedAt: STARTED - 300_000,
        now: STARTED + 59_000,
        maxAgeMs: 60_000,
      }),
    ).toBe(false);
  });

  it("age is measured from the last beat, not from the start, once it beat", () => {
    // 15 minutes of uptime, but a beat that landed 10s ago: healthy.
    expect(
      isHeartbeatStale({
        lastHeartbeatAt: STARTED - 10_000,
        startedAt: STARTED - 900_000,
        now: STARTED,
        maxAgeMs: 60_000,
      }),
    ).toBe(false);
  });
});

describe("heartbeat watchdog", () => {
  it("warns on the first overdue tick", () => {
    expect(
      shouldWarnHeartbeat({ stale: true, wasWarned: false }),
    ).toBe(true);
  });

  it("stays quiet for the rest of one overdue stretch", () => {
    expect(shouldWarnHeartbeat({ stale: true, wasWarned: true })).toBe(false);
  });

  it("stays quiet while the heartbeat is healthy", () => {
    expect(shouldWarnHeartbeat({ stale: false, wasWarned: true })).toBe(false);
    expect(shouldWarnHeartbeat({ stale: false, wasWarned: false })).toBe(false);
  });
});
