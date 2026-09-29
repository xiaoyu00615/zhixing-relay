import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PendingItem, PersistedState, RelayStateName } from "./types.js";

const EMPTY: PersistedState = {
  version: 1,
  paused: false,
  state: "IDLE",
  currentTask: null,
  pending: [],
  seenFingerprints: [],
  expectedInjectedUserFingerprints: [],
};

export class RelayStore {
  private state: PersistedState = structuredClone(EMPTY);

  constructor(private readonly url: URL) {}

  async load(): Promise<PersistedState> {
    const path = fileURLToPath(this.url);

    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;

      this.state = {
        ...structuredClone(EMPTY),
        ...parsed,
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        seenFingerprints: Array.isArray(parsed.seenFingerprints)
          ? parsed.seenFingerprints
          : [],
        expectedInjectedUserFingerprints: Array.isArray(
          parsed.expectedInjectedUserFingerprints,
        )
          ? parsed.expectedInjectedUserFingerprints
          : [],
      };
    } catch {
      this.state = structuredClone(EMPTY);
      await this.save();
    }

    return this.snapshot();
  }

  snapshot(): PersistedState {
    return structuredClone(this.state);
  }

  async mutate(mutator: (state: PersistedState) => void): Promise<void> {
    mutator(this.state);

    this.state.seenFingerprints = this.state.seenFingerprints.slice(-1000);
    this.state.expectedInjectedUserFingerprints =
      this.state.expectedInjectedUserFingerprints.slice(-50);
    this.state.pending = this.state.pending.slice(-100);

    await this.save();
  }

  hasSeen(fingerprint: string): boolean {
    return this.state.seenFingerprints.includes(fingerprint);
  }

  isExpectedInjectedUser(fingerprint: string): boolean {
    return this.state.expectedInjectedUserFingerprints.includes(fingerprint);
  }

  async markSeen(fingerprint: string): Promise<void> {
    if (this.hasSeen(fingerprint)) return;
    await this.mutate((state) => {
      state.seenFingerprints.push(fingerprint);
    });
  }

  async expectInjectedUser(fingerprint: string): Promise<void> {
    await this.mutate((state) => {
      if (!state.expectedInjectedUserFingerprints.includes(fingerprint)) {
        state.expectedInjectedUserFingerprints.push(fingerprint);
      }
    });
  }

  async consumeExpectedInjectedUser(fingerprint: string): Promise<boolean> {
    if (!this.isExpectedInjectedUser(fingerprint)) return false;

    await this.mutate((state) => {
      state.expectedInjectedUserFingerprints =
        state.expectedInjectedUserFingerprints.filter((x) => x !== fingerprint);
    });

    return true;
  }

  async enqueue(item: PendingItem): Promise<void> {
    await this.mutate((state) => {
      state.pending.push(item);
    });
  }

  async shiftPending(): Promise<PendingItem | null> {
    let item: PendingItem | null = null;

    await this.mutate((state) => {
      item = state.pending.shift() || null;
    });

    return item;
  }

  async setState(stateName: RelayStateName): Promise<void> {
    await this.mutate((state) => {
      state.state = stateName;
    });
  }

  private async save(): Promise<void> {
    const path = fileURLToPath(this.url);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.state, null, 2), "utf8");
  }
}
