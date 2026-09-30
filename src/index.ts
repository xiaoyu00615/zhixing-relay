import { AuditLog } from "./audit.js";
import { BridgeServer } from "./bridge-server.js";
import { startCli } from "./cli.js";
import { loadConfig } from "./config.js";
import { ModelRouter } from "./model-router/router.js";
import { ZhixingRelay } from "./relay.js";
import { RelayStore } from "./store.js";
import { WorkBuddyClient } from "./workbuddy.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const audit = new AuditLog(config.paths.audit);
  const store = new RelayStore(config.paths.state);
  const bridge = new BridgeServer(config.relay);
  const workbuddy = new WorkBuddyClient(
    config.workbuddy,
    config.paths.tokens,
  );

  const router = ModelRouter.create(config.paths.models, config.modelRouter);
  await router.init();

  const relay = new ZhixingRelay(
    config,
    bridge,
    store,
    audit,
    workbuddy,
    router,
  );

  await relay.init();
  await bridge.start();

  console.log("");
  console.log("ZHIXING RELAY v0.1.0");
  console.log(`Bridge: ws://${config.relay.host}:${config.relay.port}`);
  console.log(`GPT forward mode: ${config.relay.gptForwardMode}`);
  console.log(
    `Auto send WorkBuddy result to ChatGPT: ${config.relay.autoSendToChatGPT}`,
  );

  try {
    const online = await relay.workbuddyOnline();
    console.log(`WorkBuddy: ${online ? "ONLINE" : "OFFLINE"}`);
  } catch (error) {
    console.log(
      `WorkBuddy: NOT READY (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }

  console.log("Chrome extension: waiting for connection...");
  startCli(relay);

  const shutdown = async (signal: string) => {
    console.log(`\n[relay] ${signal} received, shutting down...`);
    try {
      await relay.emergencyStop();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  console.error(
    "[fatal]",
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exitCode = 1;
});
