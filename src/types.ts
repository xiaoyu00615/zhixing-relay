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
  sourceText: string;
  workbuddyOutboundMessageId?: string;
  startedAt: string;
  status: "sending" | "waiting_workbuddy" | "result_pending" | "sent_to_gpt";
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
      type: "pause_bridge";
    }
  | {
      type: "resume_bridge";
    };
