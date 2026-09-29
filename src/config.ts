import "dotenv/config";

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const forwardMode = process.env.GPT_FORWARD_MODE === "all" ? "all" : "tagged";

  return {
    relay: {
      host: process.env.RELAY_HOST || "127.0.0.1",
      port: envInt("RELAY_PORT", 8787),
      sharedSecret: process.env.RELAY_SHARED_SECRET || "",
      pauseOnManualUserMessage: envBool("PAUSE_ON_MANUAL_USER_MESSAGE", true),
      autoSendToChatGPT: envBool("AUTO_SEND_TO_CHATGPT", true),
      gptForwardMode: forwardMode as "tagged" | "all",
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
    paths: {
      state: new URL("../data/state.json", import.meta.url),
      tokens: new URL("../data/tokens.json", import.meta.url),
      audit: new URL("../data/audit.jsonl", import.meta.url),
    },
  };
}
