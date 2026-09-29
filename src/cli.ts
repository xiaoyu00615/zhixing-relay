import readline from "node:readline";
import type { ZhixingRelay } from "./relay.js";

export function startCli(relay: ZhixingRelay): readline.Interface {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log("");
  console.log("Commands:");
  console.log("  p | pause              Pause automatic forwarding");
  console.log("  r | resume             Resume and flush one pending item");
  console.log("  s | stop               Stop current relay round");
  console.log("  status                 Show state");
  console.log("  wb <text>              Manually send text to WorkBuddy");
  console.log("  gpt <text>             Stage text in ChatGPT (no auto-send)");
  console.log("  x | exit               Emergency stop and exit");
  console.log("  help                   Show commands");
  console.log("");

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) return;

    try {
      if (input === "p" || input === "pause") {
        await relay.pause();
        return;
      }

      if (input === "r" || input === "resume") {
        await relay.resume();
        return;
      }

      if (input === "s" || input === "stop") {
        await relay.stopCurrentRound();
        return;
      }

      if (input === "status") {
        console.log(JSON.stringify(relay.status(), null, 2));
        return;
      }

      if (input.startsWith("wb ")) {
        await relay.sendManualToWorkBuddy(input.slice(3).trim());
        return;
      }

      if (input.startsWith("gpt ")) {
        await relay.stageManualToChatGPT(input.slice(4).trim(), false);
        return;
      }

      if (input === "x" || input === "exit") {
        await relay.emergencyStop();
        rl.close();
        process.exitCode = 0;
        return;
      }

      if (input === "help") {
        console.log("p/pause, r/resume, s/stop, status, wb <text>, gpt <text>, x/exit");
        return;
      }

      console.log("Unknown command. Type: help");
    } catch (error) {
      console.error(
        "[cli]",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  return rl;
}
