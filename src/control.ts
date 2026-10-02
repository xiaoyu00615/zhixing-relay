/**
 * The runtime control channel.
 *
 * Under pm2 there is no console to type `r` into, so the same commands the
 * CLI offers have to be reachable over HTTP. This module is only a thin
 * transport: every route calls the very method the CLI calls
 * (`relay.resume()`, `relay.pause()`, ...), so there is exactly one
 * implementation of each command and the two surfaces cannot drift.
 *
 * The listener is bound to the loopback interface and refuses to bind
 * anywhere else, and every request has to carry the relay secret.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";

/**
 * The slice of the relay this transport is allowed to touch.
 *
 * `ZhixingRelay` satisfies it structurally, which is the point: the HTTP
 * surface and the CLI surface both call these methods and nothing else.
 */
export type RuntimeControl = {
  status: () => Record<string, unknown>;
  pause: (reason?: string) => Promise<void>;
  resume: () => Promise<void>;
  requestRestart: (reason: string) => Promise<{ ok: boolean; message: string }>;
  emitHeartbeat: () => string;
  /**
   * Records why a reconciliation hold is being lifted and releases it.
   *
   * Route handlers never decide anything: this calls the same method a
   * reconciliation could be resolved with from the console.
   */
  resolveReconciliation?: (reason: string) => Promise<{ ok: boolean; message: string }>;
};

export const CONTROL_HOST = "127.0.0.1";
/** The header every control request has to carry. */
export const SECRET_HEADER = "x-relay-secret";

export type ControlServer = {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

export type ControlOptions = {
  control: RuntimeControl;
  /**
   * Shared secret. An empty string disables the channel entirely rather than
   * letting it answer unauthenticated, so a missing `RELAY_SHARED_SECRET`
   * fails closed instead of open.
   */
  secret: string;
  /** 0 lets the OS pick a free port; tests use it to avoid collisions. */
  port?: number;
};

/**
 * Length-safe comparison: timingSafeEqual throws on buffers of different
 * lengths, and the length of the secret is not a secret.
 */
export function secretMatches(header: string | null | undefined, secret: string): boolean {
  if (secret === "") return false;
  if (typeof header !== "string" || header === "") return false;

  const supplied = Buffer.from(header);
  const expected = Buffer.from(secret);

  if (supplied.length !== expected.length) return false;

  return timingSafeEqual(supplied, expected);
}

/**
 * The status payload.
 *
 * Built field by field rather than spread from the relay: the persisted
 * bookkeeping (`seenFingerprints`, injected-text fingerprints, ...) is an
 * implementation detail and must not appear on a loopback API.
 */
function statusPayload(raw: Record<string, unknown>) {
  return {
    state: typeof raw.state === "string" ? raw.state : "IDLE",
    paused: raw.paused === true,
    currentTask:
      raw.currentTask === null || raw.currentTask === undefined
        ? null
        : raw.currentTask,
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    bridge: raw.bridgeConnected === true,
    workbuddy: raw.workbuddy === true,
    uptime: typeof raw.uptime === "string" ? raw.uptime : null,
    uptimeMs: typeof raw.uptimeMs === "number" ? raw.uptimeMs : null,
    heartbeat: {
      beatMs: typeof raw.heartbeatMs === "number" ? raw.heartbeatMs : null,
      staleAfterMs:
        typeof raw.heartbeatStaleMs === "number" ? raw.heartbeatStaleMs : null,
      lastAt: typeof raw.lastHeartbeatAt === "string" ? raw.lastHeartbeatAt : null,
      ageMs: typeof raw.lastHeartbeatAgeMs === "number" ? raw.lastHeartbeatAgeMs : null,
      stale: raw.heartbeatStale === true,
    },
    /**
     * True while a reconciliation holds the scheduler: nothing is dispatched
     * and nothing is queued until it is resolved by hand.
     */
    reconciliationHold: raw.reconciliationHold === true,
    /**
     * Where the current dispatch stands. Reported next to the global `state`
     * because the two answer different questions - the relay being busy is not
     * the same fact as WorkBuddy confirming the task was taken.
     */
    executionStage: typeof raw.executionStage === "string" ? raw.executionStage : null,
    executionStageStartedAt:
      typeof raw.executionStageStartedAt === "string" ? raw.executionStageStartedAt : null,
    executionLastProgressAt:
      typeof raw.executionLastProgressAt === "string" ? raw.executionLastProgressAt : null,
    currentDispatchId: typeof raw.currentDispatchId === "string" ? raw.currentDispatchId : null,
    currentAttempt: typeof raw.currentAttempt === "number" ? raw.currentAttempt : null,
    ledgerEventCount:
      typeof raw.ledgerEventCount === "number" ? raw.ledgerEventCount : null,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readSecret(req: IncomingMessage): string | null {
  const value = req.headers[SECRET_HEADER];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

/** Returns the handler body for a route, or null for an unknown route. */
function routeFor(
  control: RuntimeControl,
  rawPath: string,
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null {
  const path = rawPath.split("?")[0] ?? "";

  switch (path) {
    case "/control/status":
      return async (_req, res) => {
        sendJson(res, 200, { ok: true, ...statusPayload(control.status()) });
      };

    case "/control/heartbeat":
      return async (_req, res) => {
        const block = control.emitHeartbeat();
        sendJson(res, 200, { ok: true, heartbeat: block });
      };

    case "/control/resume":
      return async (_req, res) => {
        await control.resume();
        sendJson(res, 200, { ok: true, ...statusPayload(control.status()) });
      };

    case "/control/pause":
      return async (_req, res) => {
        await control.pause("control_channel");
        sendJson(res, 200, { ok: true, ...statusPayload(control.status()) });
      };

    case "/control/reconciliation/resolve":
      return async (_req, res) => {
        const url = new URL(_req.url ?? "/", `http://${CONTROL_HOST}`);
        const reason = url.searchParams.get("reason") ?? "control channel";

        if (typeof control.resolveReconciliation !== "function") {
          sendJson(res, 501, {
            ok: false,
            error: "reconciliation is not available on this relay",
          });
          return;
        }

        const result = await control.resolveReconciliation(reason);
        sendJson(res, result.ok ? 200 : 409, result);
      };

    case "/control/restart":
      return async (_req, res) => {
        const result = await control.requestRestart("control channel restart");
        sendJson(res, result.ok ? 200 : 409, result);
      };

    default:
      return null;
  }
}

/**
 * Starts the control channel.
 *
 * The host is fixed to loopback and an explicit non-loopback host is
 * rejected, so a stray configuration cannot widen the surface.
 */
export async function startControlServer(
  options: ControlOptions,
): Promise<ControlServer> {
  const server: Server = createServer((req, res) => {
    // Drain whatever the client sent: the routes never read a body.
    req.resume();

    void (async () => {
      const isPost = (req.method ?? "GET").toUpperCase() === "POST";

      if (!secretMatches(readSecret(req), options.secret)) {
        sendJson(res, options.secret === "" ? 503 : 401, {
          ok: false,
          error:
            options.secret === ""
              ? "control channel disabled: RELAY_SHARED_SECRET is empty"
              : "unauthorized",
        });
        return;
      }

      if (!isPost) {
        sendJson(res, 405, { ok: false, error: "POST required" });
        return;
      }

      const handler = routeFor(options.control, req.url ?? "/");
      if (!handler) {
        sendJson(res, 404, { ok: false, error: "unknown control route" });
        return;
      }

      try {
        await handler(req, res);
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only. An operator asking for anything else is a mistake.
    server.listen(options.port ?? 8788, CONTROL_HOST, resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    host: CONTROL_HOST,
    port,
    url: `http://${CONTROL_HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
