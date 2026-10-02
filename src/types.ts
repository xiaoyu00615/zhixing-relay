import type { TaskExecutionState } from "./delivery/stage.js";

export type RelayStateName =
  | "IDLE"
  | "WAIT_WORKBUDDY"
  | "WAIT_GPT"
  | "PAUSED"
  | "STOPPED";

export type PendingItem =
  | {
      kind: "gpt_task";
      id: string;
      text: string;
      fingerprint: string;
      createdAt: string;
      taskFingerprint?: string | undefined;
      dispatchId?: string | undefined;
      attempt?: number | undefined;
      /** Present when this queue entry is a failing turn's second attempt. */
      taskId?: string;
      retryCount?: number;
      reason?: string;
    }
  | {
      kind: "workbuddy_result";
      id: string;
      taskId: string;
      text: string;
      workbuddyMessageId: string;
      createdAt: string;
    };

export type CurrentTask = {
  taskId: string;
  sourceFingerprint: string;
  /**
   * Stable fingerprint of the published TASK block. Two turns carrying the
   * same fingerprint are the same task, whatever their task id says.
   */
  taskFingerprint?: string | undefined;
  /** Identity of this particular send, which the task survives. */
  dispatchId?: string | undefined;
  /** Which attempt at this task this turn is. */
  attempt?: number | undefined;
  sourceText: string;
  workbuddyOutboundMessageId?: string;
  startedAt: string;
  status: "sending" | "waiting_workbuddy" | "result_pending" | "sent_to_gpt";
  /**
   * When the RESULT was handed to ChatGPT. This is the start of the WAIT_GPT
   * lease: it is what lets a restarted relay tell "waiting for an
   * acknowledgement" from "nothing was ever sent".
   */
  sentToGptAt?: string;
  /**
   * Which model routed this turn, recorded so a restarted relay can rebuild
   * the task's pin from durable state. The router's own pin stays in memory -
   * this is only the fact needed to recreate it, not the pin itself.
   */
  modelId?: string;
  modelLabel?: string;
  /**
   * How far THIS dispatch has been acknowledged to have reached.
   *
   * Separate from the global state on purpose: "the relay is busy" and "the
   * task was confirmed sent" are different facts, and only one of them can be
   * recovered from after a restart. Persisted with the task so a relay that
   * comes back knows whether to re-deliver a result or re-run a task.
   */
  execution?: TaskExecutionState | undefined;
};

export type PersistedState = {
  version: 1;
  paused: boolean;
  state: RelayStateName;
  currentTask: CurrentTask | null;
  pending: PendingItem[];
  seenFingerprints: string[];
  expectedInjectedUserFingerprints: string[];
};

export type WorkBuddyMessage = {
  message_id: string;
  role: "user" | "assistant" | string;
  content: unknown[];
  msg_type: string;
  created_at?: string;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
};

export type ExtensionInbound =
  | {
      type: "bridge_hello";
      source?: string;
      sharedSecret?: string;
      capabilities?: string[];
      ts?: number;
    }
  | {
      type: "chatgpt_page_ready";
      pageUrl?: string;
      title?: string;
      tabId?: number;
      ts?: number;
    }
  | {
      type: "chatgpt_user_message";
      text: string;
      fingerprint: string;
      pageUrl?: string;
      title?: string;
      tabId?: number;
      ts?: number;
    }
  | {
      type: "chatgpt_assistant_message";
      text: string;
      fingerprint: string;
      pageUrl?: string;
      title?: string;
      tabId?: number;
      ts?: number;
    }
  | {
      /**
       * Facts read off the ChatGPT page - message identity, fingerprint, raw
       * text and order. Deciding what they mean stays in the relay.
       */
      type: "recent_assistant_messages";
      requestId: string;
      limit?: number | undefined;
      messages?: { id: string; fingerprint: string; text: string }[];
    }
  | {
      type: "chatgpt_send_result";
      requestId?: string | null;
      ok: boolean;
      sent?: boolean;
      staged?: boolean;
      error?: string;
      ts?: number;
    };

export type RelayToExtension =
  | {
      type: "send_to_chatgpt";
      requestId: string;
      text: string;
      autoSend: boolean;
    }
  | {
      /** Read-only: the relay asks the page what it currently shows. */
      type: "fetch_recent_assistant_messages";
      requestId: string;
      limit?: number | undefined;
    }
  | {
      type: "pause_bridge";
    }
  | {
      type: "resume_bridge";
    };
