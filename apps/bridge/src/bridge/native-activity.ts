export interface NativeActivitySnapshot {
  conversationKey: string;
  teamId: string;
  userId: string;
  channelId: string;
  threadTs: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  revision: number;
  phase: "executing" | "waiting" | "uncertain" | "idle";
  pendingInputCount: number;
  finalPendingDelivery: boolean;
  needsReconciliation?: boolean;
}
