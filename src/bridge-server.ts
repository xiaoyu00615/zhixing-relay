import { WebSocketServer, WebSocket } from "ws";
import type { AppConfig } from "./config.js";
import type { ExtensionInbound, RelayToExtension } from "./types.js";

type MessageHandler = (message: ExtensionInbound) => Promise<void> | void;

export class BridgeServer {
  private server: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private authenticated = new WeakSet<WebSocket>();
  private handler: MessageHandler | null = null;

  constructor(private readonly config: AppConfig["relay"]) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.config.host,
        port: this.config.port,
      });

      wss.once("listening", () => {
        this.server = wss;
        resolve();
      });

      wss.once("error", reject);

      wss.on("connection", (ws) => {
        console.log("[bridge] websocket connected");
        this.clients.add(ws);

        ws.on("close", (code, reason) => {
  console.log(
    "[bridge] closed",
    code,
    reason.toString()
  );

  this.clients.delete(ws);
});

        ws.on("message", async (data) => {
          let parsed: unknown;

          try {
            parsed = JSON.parse(data.toString());
          } catch {
            ws.close(1003, "Invalid JSON");
            return;
          }

          const message = parsed as ExtensionInbound;

          if (!this.authenticated.has(ws)) {
            if (message?.type !== "bridge_hello") {
              ws.close(1008, "bridge_hello required");
              return;
            }

            if (
              this.config.sharedSecret &&
              message.sharedSecret !== this.config.sharedSecret
            ) {
              ws.close(1008, "Invalid relay shared secret");
              return;
            }

            this.authenticated.add(ws);
          }

          try {
            await this.handler?.(message);
          } catch (error) {
            console.error("[bridge] message handler failed:", error);
          }
        });
      });
    });
  }

  hasClient(): boolean {
    for (const client of this.clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        this.authenticated.has(client)
      ) {
        return true;
      }
    }
    return false;
  }

  async send(message: RelayToExtension): Promise<void> {
    const payload = JSON.stringify(message);
    let sent = 0;

    for (const client of this.clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        this.authenticated.has(client)
      ) {
        client.send(payload);
        sent += 1;
      }
    }

    if (sent === 0) {
      throw new Error("No authenticated ChatGPT Chrome extension is connected");
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.close(1001, "Relay shutting down");
      } catch {
        // ignore
      }
    }

    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => resolve());
    });
  }
}
