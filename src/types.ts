/** Plugin configuration */
export interface ClawMindPluginConfig {
  /** Compression threshold, compression is triggered only when context exceeds this length */
  compressionThreshold?: number;
  /** Number of most recent messages to keep verbatim in model context */
  keepRecentMessages?: number;
  /** Maximum character length for each summarized entry written to Markdown */
  entryCharLimit?: number;
  /** Optional output directory for generated Markdown summary files */
  summaryDir?: string;
  /** Whether debug mode is enabled */
  debug?: boolean;
}

// ==================== Below are officially defined OpenClaw types ====================

export interface AgentMessageContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Official Agent message type */
export interface AgentMessage {
  /** Message unique ID */
  id?: string;
  /** Message role */
  role: "user" | "assistant" | "system" | "tool" | "toolResult";
  /** Message content */
  content: string | AgentMessageContentBlock[];
  /** Timestamp */
  timestamp?: number;
  /** Name (used for tool calls) */
  name?: string;
  /** Tool call ID */
  tool_call_id?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Whether already compressed */
  compressed?: boolean;
}

/** Context assembly result */
export type AssembleResult = {
  /** Assembled message list, ordered as model context */
  messages: AgentMessage[];
  /** Estimated total token count */
  estimatedTokens: number;
  /** Optional: Additional system prompt provided by context engine, prepended to runtime system prompt */
  systemPromptAddition?: string;
};

/** Context compression result */
export type CompactResult = {
  /** Whether compression succeeded */
  ok: boolean;
  /** Whether actual compression was performed */
  compacted: boolean;
  /** Reason for not compressing (optional) */
  reason?: string;
  /** Compression result details (optional) */
  result?: {
    /** Compression summary */
    summary?: string;
    /** First kept message ID */
    firstKeptEntryId?: string;
    /** Token count before compression */
    tokensBefore: number;
    /** Token count after compression (optional) */
    tokensAfter?: number;
    /** Other detailed information */
    details?: unknown;
  };
};

/** Single message ingestion result */
export type IngestResult = {
  /** Whether message was successfully ingested (false if duplicate or no-op) */
  ingested: boolean;
};

/** Batch message ingestion result */
export type IngestBatchResult = {
  /** Number of successfully ingested messages */
  ingestedCount: number;
};

/** Engine initialization result */
export type BootstrapResult = {
  /** Whether initialization completed successfully */
  bootstrapped: boolean;
  /** Number of historical messages imported (if any) */
  importedMessages?: number;
  /** Reason for skipping initialization (optional) */
  reason?: string;
};

/** Context engine metadata */
export type ContextEngineInfo = {
  /** Engine unique ID */
  id: string;
  /** Engine name */
  name: string;
  /** Engine version */
  version?: string;
  /** Whether engine manages compression lifecycle autonomously */
  ownsCompaction?: boolean;
};

/** Subagent spawn preparation result */
export type SubagentSpawnPreparation = {
  /** Rollback method when subagent creation fails */
  rollback: () => void | Promise<void>;
};

/** Subagent end reason */
export type SubagentEndReason = "deleted" | "completed" | "swept" | "released";
/** Context engine runtime context */
export type ContextEngineRuntimeContext = Record<string, unknown>;

/**
 * Context engine interface definition, core contract for OpenClaw plugins
 */
export interface ContextEngine {
  /** Engine identifier and metadata */
  readonly info: ContextEngineInfo;

  /**
   * Initialize engine state for session, optionally import historical context
   * @param params.sessionId Session ID
   * @param params.sessionFile Session file path
   */
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;

  /**
   * Ingest single message into engine store
   * @param params.sessionId Session ID
   * @param params.message Message to ingest
   * @param params.isHeartbeat Whether it's a heartbeat message (heartbeat messages usually don't need processing)
   */
  ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;

  /**
   * Ingest batch of complete turn messages
   * @param params.sessionId Session ID
   * @param params.messages Array of messages to ingest
   * @param params.isHeartbeat Whether it's a heartbeat message
   */
  ingestBatch?(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;

  /**
   * Post-turn lifecycle work executed after run attempt completes
   * Engine can use this to persist context, trigger background compaction tasks, etc.
   * @param params.sessionId Session ID
   * @param params.sessionFile Session file path
   * @param params.messages All message list
   * @param params.prePromptMessageCount Message count before prompt was sent
   * @param params.autoCompactionSummary Auto-compaction summary from runtime
   * @param params.isHeartbeat Whether it's a heartbeat turn
   * @param params.tokenBudget Model context token budget for proactive compression
   * @param params.runtimeContext Runtime context for engines needing caller state
   */
  afterTurn?(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void>;

  /**
   * Assemble model context under token budget
   * Returns ordered message set ready for model
   * @param params.sessionId Session ID
   * @param params.messages Current turn messages
   * @param params.tokenBudget Token budget
   */
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;

  /**
   * Compress context to reduce token usage
   * Can create summaries, prune old turns, etc.
   * @param params.sessionId Session ID
   * @param params.sessionFile Session file path
   * @param params.tokenBudget Token budget
   * @param params.force Whether to force compression even below default trigger threshold
   * @param params.currentTokenCount Caller-provided current context token estimate
   * @param params.compactionTarget Compression target, defaults to budget
   * @param params.customInstructions Custom compression instructions
   * @param params.runtimeContext Runtime context
   */
  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult>;

  /**
   * Prepare context-engine-managed subagent state before child run starts
   * Implementation can return a rollback handle invoked when spawn fails
   * @param params.parentSessionKey Parent session key
   * @param params.childSessionKey Child session key
   * @param params.ttlMs Subagent time-to-live in milliseconds
   */
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;

  /**
   * Notify context engine that subagent lifecycle has ended
   * @param params.childSessionKey Child session key
   * @param params.reason End reason
   */
  onSubagentEnded?(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void>;

  /**
   * Release all resources held by engine
   */
  dispose?(): Promise<void>;
}
