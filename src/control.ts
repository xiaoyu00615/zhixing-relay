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
  /**
   * Closes one task the relay has forgotten, without ever sending it again.
   *
   * Distinct from the line above on purpose: resolving a hold is a statement
   * about the task *being run* - the requeue path puts it back on the queue -
   * while a historical close is a statement about a task the live state has
   * already lost, and it must never requeue anything.
   *
   * Required, and spelled with the relay's own canonical name, because
   * `src/index.ts` hands the whole `ZhixingRelay` to this transport: an
   * optional field is exactly what let a rename on the relay turn into a
   * runtime 501 instead of a build error. A relay with no ledger is not a
   * relay missing this capability - it answers through it, with `ok:false`
   * and a message saying there is nothing to close, so "no reconciliation
   * service" is a business answer and never a transport-level 501.
   */
  closeReconciledTaskWithoutResend: (input: {
    taskId: string;
    reason: string;
  }) => Promise<{ ok: boolean; message: string; blocked: boolean; findings: string[] }>;
  /**
   * Terminates one task that provably never ran.
   *
   * A third disposition, and the one that was missing: `resolve` lifts a hold,
   * a historical close says "never send it again" about a task that may have
   * run, and this one says "it never ran, stop it" about a task the relay is
   * still holding unsent. It removes the queue entry that owns the task, so the
   * three are not interchangeable and a cancellation cannot be reached through
   * the older, more permissive routes.
   *
   * Required, and spelled with the relay's own canonical name, for the same
   * reason `closeReconciledTaskWithoutResend` is: `src/index.ts` hands the whole
   * `ZhixingRelay` to this transport, so an optional field is what lets a
   * rename become a runtime 501 instead of a build error.
   */
  cancelUnsentTask: (input: {
    taskId: string;
    reason: string;
  }) => Promise<{
    ok: boolean;
    message: string;
    cancelled: boolean;
    ownerRemoved: boolean;
    removedIds: string[];
    terminalEventSeq: number | null;
    blocked: boolean;
    findings: string[];
  }>;
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

    /*
     * The historical close, kept apart from the hold resolution above: it is
     * the way an operator tells the relay "WorkBuddy already ran this one,
     * stop freezing on it". The task id is mandatory, because a close that
     * names nothing would close whatever happens to be in the way.
     */
    case "/control/reconciliation/close":
      return async (_req, res) => {
        const url = new URL(_req.url ?? "/", `http://${CONTROL_HOST}`);
        const taskId = (url.searchParams.get("taskId") ?? "").trim();
        const disposition = url.searchParams.get("disposition");
        const reason = url.searchParams.get("reason") ?? "control channel";

        if (taskId.length === 0) {
          sendJson(res, 409, {
            ok: false,
            error: "a historical close needs the task it closes (taskId is required)",
          });
          return;
        }

        if (disposition !== "close_without_resend") {
          sendJson(res, 400, {
            ok: false,
            error: `disposition must be close_without_resend, got ${JSON.stringify(disposition)}`,
          });
          return;
        }

        const result = await control.closeReconciledTaskWithoutResend({ taskId, reason });
        sendJson(res, result.ok ? 200 : 409, result);
      };

    /*
     * The cancellation, deliberately its own route rather than another value
     * of `disposition` on the close above.
     *
     * A close says "never send it again" and works on a task that may already
     * have run; a cancellation says "it never ran" and removes the queue entry
     * that owns the task. Folding the second into the first would let a single
     * parameter decide both what is asserted about the world and whether a
     * runtime owner is deleted - so the two stay apart, and this one refuses
     * anything it cannot name exactly.
     */
    case "/control/reconciliation/cancel":
      return async (_req, res) => {
        const url = new URL(_req.url ?? "/", `http://${CONTROL_HOST}`);
        const taskId = (url.searchParams.get("taskId") ?? "").trim();
        const reason = (url.searchParams.get("reason") ?? "").trim();

        if (taskId.length === 0) {
          sendJson(res, 409, {
            ok: false,
            error: "a cancellation needs the task it cancels (taskId is required)",
          });
          return;
        }

        /*
         * A cancellation is a durable claim that a task never ran, so it is not
         * issued on a default reason. An unnamed reason would leave a terminal
         * row in the ledger that says only that somebody stopped something,
         * which is exactly the kind of row nobody can act on later.
         */
        if (reason.length === 0) {
          sendJson(res, 409, {
            ok: false,
            error: "a cancellation needs a reason (reason is required)",
          });
          return;
        }

        const result = await control.cancelUnsentTask({ taskId, reason });
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
