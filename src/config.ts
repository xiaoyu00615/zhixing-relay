import "dotenv/config";
import { parseFallbackMap } from "./model-router/config.js";

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function envList(name: string): string[] {
  const value = process.env[name];
  if (value == null || value.trim() === "") return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const forwardMode = process.env.GPT_FORWARD_MODE === "all" ? "all" : "tagged";

  return {
    relay: {
      host: process.env.RELAY_HOST || "127.0.0.1",
      port: envInt("RELAY_PORT", 8787),
      sharedSecret: process.env.RELAY_SHARED_SECRET || "",
      /**
       * The runtime control channel. Loopback only, guarded by the same
       * secret the bridge uses; it exists because a relay supervised by pm2
       * has no console left to type `r` into after a startup pause.
       * `RELAY_CONTROL_PORT=0` lets the OS pick a free port.
       */
      controlPort: envInt("RELAY_CONTROL_PORT", 8788),
      pauseOnManualUserMessage: envBool("PAUSE_ON_MANUAL_USER_MESSAGE", true),
      autoSendToChatGPT: envBool("AUTO_SEND_TO_CHATGPT", true),
      gptForwardMode: forwardMode as "tagged" | "all",
      /**
       * How long a round that has already forwarded its RESULT to ChatGPT may
       * keep the task record before Relay gives up on an acknowledgement and
       * frees the task for the next one. The RESULT is never sent again: this
       * only releases the bookkeeping.
       */
      resultLeaseMs: envInt("RESULT_LEASE_MS", 120_000),
      /**
       * How often one task may be handed back to the pending queue after a
       * WorkBuddy failure or cancellation. Bounded so a task WorkBuddy always
       * refuses cannot cycle for ever.
       */
      maxTaskRetries: envInt("RELAY_MAX_TASK_RETRIES", 3),
      /**
       * The heartbeat that makes a wedged terminal visible: a relay whose
       * log stops here has stopped really running, even if the console
       * window still looks alive.
       */
      heartbeatMs: envInt("HEARTBEAT_MS", 30_000),
      /** How long without a heartbeat before the watchdog complains. */
      heartbeatStaleMs: envInt("HEARTBEAT_STALE_MS", 60_000),
    },
    workbuddy: {
      baseUrl: process.env.WORKBUDDY_BASE_URL || "https://www.workbuddy.cn",
      mode: process.env.WORKBUDDY_MODE || "api",
      cdpUrl:
        process.env.WORKBUDDY_CDP_URL ||
        "",
      accessToken: process.env.WORKBUDDY_ACCESS_TOKEN || "",
      refreshToken: process.env.WORKBUDDY_REFRESH_TOKEN || "",
      clientId: process.env.WORKBUDDY_CLIENT_ID || "",
      clientSecret: process.env.WORKBUDDY_CLIENT_SECRET || "",
      pollIntervalMs: envInt("WORKBUDDY_POLL_INTERVAL_MS", 1500),
      quietMs: envInt("WORKBUDDY_QUIET_MS", 3500),
      maxWaitMs: envInt("WORKBUDDY_MAX_WAIT_MS", 7_200_000),
    },
    modelRouter: {
      /**
       * Optional comma-separated model ids. Order overrides the catalog order.
       * Unknown ids are ignored by resolveModels().
       */
      priority: envList("MODEL_PRIORITY"),
      disabled: envList("MODEL_DISABLED"),
      /**
       * Optional "requested:next,next|..." chains used when a task's
       * requested model cannot run.
       */
      fallbacks: parseFallbackMap(process.env.MODEL_FALLBACKS),
      /**
       * How many times ONE task may be re-dispatched after WorkBuddy reports
       * a model quota exhaustion. Bounded on purpose: a retry that always
       * lands on the same exhausted model must not become a loop.
       */
      quotaRetries: envInt("MODEL_QUOTA_RETRIES", 2),
      /**
       * How long to block a model whose reset time the notice did not give.
       * Always an absolute instant once stored; this is only the fallback.
       */
      quotaBlockMs: envInt("MODEL_QUOTA_BLOCK_MS", 3_600_000),
    },
    paths: {
      state: new URL("../data/state.json", import.meta.url),
      tokens: new URL("../data/tokens.json", import.meta.url),
      audit: new URL("../data/audit.jsonl", import.meta.url),
      models: new URL("../data/models.json", import.meta.url),
    },
  };
}
