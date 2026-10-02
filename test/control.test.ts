/**
 * The runtime control channel.
 *
 * Under pm2 the console is gone, so `r` / `p` / `status` have to stay
 * reachable over HTTP - and they have to reach *the same* relay methods, not
 * a parallel implementation that can drift. These tests start a real
 * ZhixingRelay, put the real control server in front of it and talk to it
 * with fetch, which is exactly what an operator would do.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { BridgeServer } from "../src/bridge-server.js";
import {
  CONTROL_HOST,
  SECRET_HEADER,
  secretMatches,
  startControlServer,
  type ControlServer,
} from "../src/control.js";
import type { AuditLog } from "../src/audit.js";
import { ZhixingRelay } from "../src/relay.js";
import { RelayStore } from "../src/store.js";
import type { WorkBuddyClient } from "../src/workbuddy.js";

const SECRET = "relay-secret-from-env";

let sandboxRoot = "";
let store: RelayStore;
let inner: ZhixingRelay;
let server: ControlServer;
/**
 * Records which relay method each route ended up calling, so a test can
 * prove the HTTP surface and the CLI surface share one implementation.
 */
const calls: string[] = [];

/** The control object handed to the HTTP layer: real relay, SpyMethods only. */
let control: {
  status: () => ReturnType<ZhixingRelay["status"]>;
  pause: (reason?: string) => Promise<void>;
  resume: () => Promise<void>;
  requestRestart: (reason: string) => Promise<{ ok: boolean; message: string }>;
  emitHeartbeat: () => string;
};

function fakeAudit(): AuditLog {
  return { write: async () => {} } as unknown as AuditLog;
}

function fakeBridge(): BridgeServer {
  return {
    hasClient: () => true,
    onMessage: () => {},
    send: async () => {},
    close: async () => {},
    start: async () => {},
  } as unknown as BridgeServer;
}

function fakeWorkbuddy(): WorkBuddyClient {
  return {
    init: async () => {},
    online: async () => true,
  } as unknown as WorkBuddyClient;
}

async function post(
  path: string,
  headers: Record<string, string> = { [SECRET_HEADER]: SECRET },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers,
  });

  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "zxr-control-"));
});

afterAll(async () => {
  await server.close();
  await rm(sandboxRoot, { recursive: true, force: true });
});

let caseSeq = 0;

beforeEach(async () => {
  calls.length = 0;
  // Fresh per test: a relay that carries the previous test's pause into the
  // next one would make "restart" fail for the wrong reason.
  caseSeq += 1;

  const dir = join(sandboxRoot, `case-${process.pid}-${caseSeq}`);
  store = new RelayStore(pathToFileURL(join(dir, "state.json")));
  await store.load();

  const made = new ZhixingRelay(
    { relay: {} } as unknown as AppConfig,
    fakeBridge(),
    store,
    fakeAudit(),
    fakeWorkbuddy(),
    null,
  );
  await made.init();
  inner = made;

  /*
   * Wraps the relay exactly the way the CLI calls it: one recorded frame per
   * method and nothing else, so an assertion can see the HTTP route reached
   * the relay instead of reaching an endpoint of its own.
   */
  control = {
    status: () => inner.status(),
    pause: (reason?: string) => {
      calls.push(`pause:${reason ?? ""}`);
      return inner.pause(reason);
    },
    resume: () => {
      calls.push("resume");
      return inner.resume();
    },
    requestRestart: (reason: string) => {
      calls.push(`restart:${reason}`);
      return inner.requestRestart(reason);
    },
    emitHeartbeat: () => {
      calls.push("heartbeat");
      return inner.emitHeartbeat();
    },
  };

  server = await startControlServer({
    control,
    secret: SECRET,
    port: 0,
  });
});

describe("secret handling", () => {
  it("refuses a request that carries no secret", async () => {
    const { status, body } = await post("/control/status", {});

    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false });
  });

  it("refuses a request that carries the wrong secret", async () => {
    const { status, body } = await post("/control/status", {
      [SECRET_HEADER]: "not-the-secret",
    });

    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("compares the supplied secret without leaking its length", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches("", SECRET)).toBe(false);
    expect(secretMatches(null, SECRET)).toBe(false);
    // An empty configured secret authenticates nobody.
    expect(secretMatches(SECRET, "")).toBe(false);
  });

  it("answers 503 instead of unauthenticated traffic when no secret is set", async () => {
    const open = await startControlServer({ control, secret: "", port: 0 });

    try {
      const response = await fetch(`${open.url}/control/status`, {
        method: "POST",
        headers: { [SECRET_HEADER]: SECRET },
      });

      expect(response.status).toBe(503);
    } finally {
      await open.close();
    }
  });
});

describe("control routes", () => {
  it("binds the loopback interface only", () => {
    expect(server.host).toBe(CONTROL_HOST);
    expect(CONTROL_HOST).toBe("127.0.0.1");
  });

  it("reports status as JSON without extra ceremony", async () => {
    const { status, body } = await post("/control/status");

    expect(status).toBe(200);
    // An explicit shape, not a dump of the persisted bookkeeping.
    expect(Object.keys(body).sort()).toEqual(
      [
        "bridge",
        "currentAttempt",
        "currentDispatchId",
        "currentTask",
        "executionLastProgressAt",
        "executionStage",
        "executionStageStartedAt",
        "heartbeat",
        "ledgerEventCount",
        "ok",
        "pending",
        "paused",
        "reconciliationHold",
        "state",
        "workbuddy",
        "uptime",
        "uptimeMs",
      ].sort(),
    );
  });

  it("groups the heartbeat facts under one key", async () => {
    // A relay that never beat has nothing to report yet, so beat first.
    await post("/control/heartbeat");

    const { body } = await post("/control/status");

    const heartbeat = body.heartbeat as Record<string, unknown>;

    expect(heartbeat).toMatchObject({ stale: false, beatMs: 30_000 });
    expect(heartbeat.lastAt).toBeTypeOf("string");
    expect(heartbeat.ageMs).toBeTypeOf("number");
  });

  it("resumes through the relay's own method", async () => {
    await inner.pause("test fixture");

    const { status, body } = await post("/control/resume");

    expect(status).toBe(200);
    expect(body.paused).toBe(false);
    expect(body.state).toBe("IDLE");
    expect(calls).toContain("resume");
  });

  it("pauses through the relay's own method", async () => {
    const { status, body } = await post("/control/pause");

    expect(status).toBe(200);
    expect(body.paused).toBe(true);
    expect(body.state).toBe("PAUSED");
    expect(calls).toContain("pause:control_channel");
  });

  it("refuses to restart while the relay is paused", async () => {
    await inner.pause("test fixture");

    const { status, body } = await post("/control/restart");

    expect(status).toBe(409);
    expect(body.ok).toBe(false);
    expect(calls).toContain("restart:control channel restart");
  });

  it("restarts once nothing is in flight", async () => {
    const { status, body } = await post("/control/restart");

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("prints one heartbeat and returns it", async () => {
    const { body } = await post("/control/heartbeat");

    expect(body.ok).toBe(true);
    expect(String(body.heartbeat)).toContain("[relay-heartbeat]");
    expect(calls).toContain("heartbeat");
  });

  it("404s an unknown route and 405s a non-POST", async () => {
    expect((await post("/control/nope")).status).toBe(404);

    const get = await fetch(`${server.url}/control/status`, {
      headers: { [SECRET_HEADER]: SECRET },
    });
    expect(get.status).toBe(405);
  });

  it("never reaches the relay when the secret is wrong", async () => {
    await post("/control/resume", { [SECRET_HEADER]: "wrong" });

    expect(calls).toEqual([]);
  });
});
