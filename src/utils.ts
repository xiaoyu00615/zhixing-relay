import { randomUUID } from "node:crypto";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

// Keep compatible with the Chrome extension's fingerprint algorithm.
export function browserFingerprint(role: string, text: string): string {
  const input = `${role}:${text}`;
  let hash = 2166136261 >>> 0;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return `${role}:${hash.toString(16)}:${text.length}`;
}

export function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}
