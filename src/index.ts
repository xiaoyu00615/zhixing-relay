import { AuditLog } from "./audit.js";
import { BridgeServer } from "./bridge-server.js";
import { startCli } from "./cli.js";
import { SECRET_HEADER, startControlServer } from "./control.js";
import { loadConfig } from "./config.js";
import { ModelRouter } from "./model-router/router.js";
import { ZhixingRelay } from "./relay.js";
import { RelayStore } from "./store.js";
import { WorkBuddyClient } from "./workbuddy.js";
import { relayCommit, relayVersion } from "./version.js";

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

  /*
   * Every fact an operator needs to place this process in the log, printed
   * before anything else can go wrong, so a pm2 log always says which build
   * produced which line.
   */
  const bootState = store.snapshot();

  console.log("");
  console.log("[BOOT]");
  console.log(`version=${relayVersion()}`);
  console.log(`pid=${process.pid}`);
  console.log(`cwd=${process.cwd()}`);
  console.log(`commit=${relayCommit()}`);
  console.log(
    `state=${bootState.state} paused=${bootState.paused ? "true" : "false"} pending=${bootState.pending.length}`,
  );
  console.log(`bridge=ws://${config.relay.host}:${config.relay.port}`);

  console.log("");
  console.log("ZHIXING RELAY");
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

  for (const line of relay.startupDiagnostics()) {
    console.log(line);
  }

  /*
   * The console is not where this relay lives once pm2 owns it, so the CLI
   * commands are also reachable over loopback HTTP.
   */
  if (!config.relay.sharedSecret) {
    console.warn(
      "[relay] control channel DISABLED: RELAY_SHARED_SECRET is empty. " +
        "Set it in .env to be able to resume the relay after a startup pause.",
    );
  } else {
    try {
      const control = await startControlServer({
        control: relay,
        secret: config.relay.sharedSecret,
        port: config.relay.controlPort,
      });

      console.log(
        `Control: POST http://${control.host}:${control.port}/control/{status,pause,resume,restart,heartbeat} (${SECRET_HEADER} required)`,
      );
    } catch (error) {
      console.error(
        "[relay] control channel NOT started:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /*
   * Prove the process is alive even when the console window stops painting:
   * a beat every HEARTBEAT_MS, and a complaint when a beat goes missing.
   */
  relay.startHeartbeat();

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
