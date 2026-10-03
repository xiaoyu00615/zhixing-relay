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

  /**
   * Returns the durable `workbuddy_result` outbox entry for a task, if one
   * already exists. Keyed on `(taskId, workbuddyMessageId)` - the result
   * identity - so a recovery (or a re-delivery) can see the answer is already
   * safe without re-fetching it from WorkBuddy.
   */
  async findPendingResult(
    taskId: string,
    workbuddyMessageId: string,
  ): Promise<PendingItem | null> {
    const match = this.state.pending.find(
      (item) =>
        item.kind === "workbuddy_result" &&
        item.taskId === taskId &&
        item.workbuddyMessageId === workbuddyMessageId,
    );
    return match ?? null;
  }

  /**
   * Drops every `workbuddy_result` outbox entry for a task.
   *
   * Called when the round that produced the answer closes: the answer has been
   * delivered and acknowledged, or released after its lease, so the durable
   * copy is no longer needed and must not linger to be re-delivered later.
   */
  async removePendingResultForTask(taskId: string): Promise<void> {
    await this.mutate((state) => {
      state.pending = state.pending.filter(
        (item) => !(item.kind === "workbuddy_result" && item.taskId === taskId),
      );
    });
  }

  /**
   * Drops the queued entries that own one task, by id.
   *
   * Used by the operator cancellation, which has to remove the *exact* owner of
   * a task it decided about. Ids are named rather than matched on `taskId`,
   * because a queue entry does not always carry one: a task accepted straight
   * from the GPT page is stored as the envelope text alone, and its identity has
   * to be recovered from that text before the entry can be recognised. Deciding
   * which entries those are belongs to the relay, which owns the protocol; this
   * only carries out the removal it was handed, so the two halves cannot
   * disagree about what was removed.
   */
  async removePendingByIds(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const dropping = new Set(ids);
    let removed: string[] = [];

    await this.mutate((state) => {
      removed = state.pending.filter((item) => dropping.has(item.id)).map((item) => item.id);
      state.pending = state.pending.filter((item) => !dropping.has(item.id));
    });

    return removed;
  }

  /**
   * Drops one queued item, by id.
   *
   * The only caller is a RESULT that ChatGPT acknowledged: the durable copy of
   * the answer has done its job and re-delivering it would send the same text
   * to the thread twice. A queue entry is written before the delivery and
   * removed after the acknowledgement, never before.
   */
  async removePending(id: string): Promise<void> {
    await this.mutate((state) => {
      state.pending = state.pending.filter((item) => item.id !== id);
    });
  }

  /**
   * Puts a popped queue item back, exactly as it was.
   *
   * The other half of `shiftPending`. A caller takes an item out to decide
   * about it, and a decision that sends nothing must not cost the task: the
   * entry goes back with its own id, text, fingerprints and retry count, or
   * the task would quietly change identity while nobody was looking.
   *
   * Idempotent by id, because the caller may be recovering from a refusal it
   * is not sure landed.
   */
  async restorePending(item: PendingItem): Promise<void> {
    await this.mutate((state) => {
      if (state.pending.some((existing) => existing.id === item.id)) return;
      state.pending.unshift(item);
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
