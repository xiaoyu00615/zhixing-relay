import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isoNow } from "./utils.js";

export class AuditLog {
  constructor(private readonly url: URL) {}

  async write(event: string, data: Record<string, unknown> = {}): Promise<void> {
    const path = fileURLToPath(this.url);
    await mkdir(dirname(path), { recursive: true });

    const line = JSON.stringify({
      at: isoNow(),
      event,
      ...data,
    });

    await appendFile(path, `${line}\n`, "utf8");
  }
}
