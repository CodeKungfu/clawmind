import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

import type {
  AgentMessage,
  AssembleResult,
  BootstrapResult,
  ClawMindPluginConfig,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "./types.js";

const PLUGIN_ID = "clawmind" as const;
const DEFAULT_COMPRESSION_THRESHOLD = 4000;
const DEFAULT_KEEP_RECENT_MESSAGES = 12;
const DEFAULT_ENTRY_CHAR_LIMIT = 280;

type SessionState = {
  sessionFile: string;
  summaryFile: string;
  summaryMarkdown?: string;
};

class ClawMindContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: PLUGIN_ID,
    name: "ClawMind Local Markdown Context Engine",
    version: "1.0.0",
    ownsCompaction: true,
  };

  private readonly config: Required<ClawMindPluginConfig>;
  private readonly sessions = new Map<string, SessionState>();
  private readonly latestMessages = new Map<string, AgentMessage[]>();

  constructor(config: ClawMindPluginConfig = {}) {
    this.config = {
      compressionThreshold: config.compressionThreshold ?? DEFAULT_COMPRESSION_THRESHOLD,
      keepRecentMessages: config.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
      entryCharLimit: config.entryCharLimit ?? DEFAULT_ENTRY_CHAR_LIMIT,
      summaryDir: config.summaryDir ?? "",
      debug: config.debug ?? false,
    };
  }

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    const summaryFile = this.resolveSummaryFile(params.sessionId, params.sessionFile);
    const summaryMarkdown = await this.loadSummaryMarkdown(summaryFile);

    this.sessions.set(params.sessionId, {
      sessionFile: params.sessionFile,
      summaryFile,
      ...(summaryMarkdown ? { summaryMarkdown } : {}),
    });

    if (this.config.debug) {
      console.log(
        `[ClawMind] Bootstrapped session ${params.sessionId}, summary file: ${summaryFile}, loaded summary: ${summaryMarkdown ? "yes" : "no"}`
      );
    }

    return {
      bootstrapped: true,
      importedMessages: 0,
    };
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    if (params.isHeartbeat) {
      return { ingested: false };
    }

    if (this.config.debug) {
      console.log(
        `[ClawMind] Message ingested, role=${params.message.role}, chars=${this.contentChars(params.message.content)}`
      );
    }

    return { ingested: true };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }): Promise<void> {
    if (params.isHeartbeat) {
      return;
    }

    this.latestMessages.set(params.sessionId, params.messages);
    await this.ensureSessionState(params.sessionId, params.sessionFile);

    const totalChars = params.messages.reduce((sum, message) => sum + this.contentChars(message.content), 0);

    if (this.config.debug) {
      console.log(
        `[ClawMind] afterTurn: messages=${params.messages.length}, chars=${totalChars}, budget=${params.tokenBudget}`
      );
    }

    if (totalChars <= this.config.compressionThreshold) {
      return;
    }

    await this.compact({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      currentTokenCount: Math.ceil(totalChars / 4),
      ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
      ...(params.runtimeContext !== undefined ? { runtimeContext: params.runtimeContext } : {}),
    });
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const session = await this.ensureSessionState(params.sessionId);
    const totalChars = params.messages.reduce((sum, message) => sum + this.contentChars(message.content), 0);
    const shouldUseSummary =
      Boolean(session?.summaryMarkdown) &&
      (totalChars > this.config.compressionThreshold || params.messages.length > this.config.keepRecentMessages);

    const assembledMessages = shouldUseSummary
      ? [this.buildSummaryMessage(session.summaryMarkdown!), ...this.takeRecentMessages(params.messages)]
      : params.messages;

    const estimatedTokens = assembledMessages.reduce(
      (sum, message) => sum + Math.ceil(this.contentChars(message.content) / 4),
      0
    );

    if (this.config.debug) {
      console.log(
        `[ClawMind] assemble: sourceMessages=${params.messages.length}, outputMessages=${assembledMessages.length}, estimatedTokens=${estimatedTokens}`
      );
    }

    return {
      messages: assembledMessages,
      estimatedTokens,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    const session = await this.ensureSessionState(params.sessionId, params.sessionFile);
    const messages = this.latestMessages.get(params.sessionId) ?? [];
    const tokensBefore = params.currentTokenCount ?? this.estimateTokens(messages);

    if (messages.length === 0) {
      return { ok: true, compacted: false, reason: "No messages available for compaction." };
    }

    const totalChars = messages.reduce((sum, message) => sum + this.contentChars(message.content), 0);
    if (!params.force && totalChars <= this.config.compressionThreshold) {
      return {
        ok: true,
        compacted: false,
        reason: "Compression threshold not reached.",
      };
    }

    const historicalMessages = messages.slice(0, Math.max(0, messages.length - this.config.keepRecentMessages));
    if (historicalMessages.length === 0) {
      return {
        ok: true,
        compacted: false,
        reason: "Not enough messages to compact after preserving recent context.",
      };
    }

    const summaryMarkdown = this.buildSummaryMarkdown(params.sessionId, historicalMessages);
    await mkdir(dirname(session.summaryFile), { recursive: true });
    await writeFile(session.summaryFile, summaryMarkdown, "utf8");

    this.sessions.set(params.sessionId, {
      ...session,
      summaryMarkdown,
    });

    const recentMessages = this.takeRecentMessages(messages);
    const assembledMessages = [this.buildSummaryMessage(summaryMarkdown), ...recentMessages];
    const tokensAfter = this.estimateTokens(assembledMessages);

    if (this.config.debug) {
      console.log(
        `[ClawMind] Compacted session ${params.sessionId}: summarized=${historicalMessages.length}, keptRecent=${recentMessages.length}, summaryFile=${session.summaryFile}`
      );
    }

    return {
      ok: true,
      compacted: true,
      result: {
        summary: `Local Markdown summary written to ${session.summaryFile}`,
        tokensBefore,
        tokensAfter,
        details: {
          summaryFile: session.summaryFile,
          summarizedMessages: historicalMessages.length,
          keptRecentMessages: recentMessages.length,
        },
      },
    };
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    this.latestMessages.clear();

    if (this.config.debug) {
      console.log("[ClawMind] Resources released");
    }
  }

  private async ensureSessionState(sessionId: string, sessionFile?: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    if (!sessionFile) {
      const fallbackSummaryFile = this.resolveSummaryFile(sessionId, `${sessionId}.json`);
      const fallbackState: SessionState = {
        sessionFile: `${sessionId}.json`,
        summaryFile: fallbackSummaryFile,
      };
      this.sessions.set(sessionId, fallbackState);
      return fallbackState;
    }

    const summaryFile = this.resolveSummaryFile(sessionId, sessionFile);
    const summaryMarkdown = await this.loadSummaryMarkdown(summaryFile);
    const state: SessionState = {
      sessionFile,
      summaryFile,
      ...(summaryMarkdown ? { summaryMarkdown } : {}),
    };

    this.sessions.set(sessionId, state);
    return state;
  }

  private resolveSummaryFile(sessionId: string, sessionFile: string): string {
    const fileName = `${this.toSafeFileName(sessionId || basename(sessionFile, extname(sessionFile)))}.clawmind.md`;
    if (this.config.summaryDir) {
      return resolve(this.config.summaryDir, fileName);
    }

    return resolve(dirname(sessionFile), fileName);
  }

  private async loadSummaryMarkdown(summaryFile: string): Promise<string | undefined> {
    try {
      const content = await readFile(summaryFile, "utf8");
      return content.trim() ? content : undefined;
    } catch {
      return undefined;
    }
  }

  private takeRecentMessages(messages: AgentMessage[]): AgentMessage[] {
    return messages.slice(-this.config.keepRecentMessages);
  }

  private buildSummaryMessage(summaryMarkdown: string): AgentMessage {
    return {
      role: "system",
      name: "clawmind-summary",
      compressed: true,
      content: [
        {
          type: "text",
          text:
            "ClawMind local context summary. Treat this as compressed historical context and rely on the recent messages for the latest exact wording.\n\n" +
            summaryMarkdown,
        },
      ],
    };
  }

  private buildSummaryMarkdown(sessionId: string, messages: AgentMessage[]): string {
    const lines = [
      "# ClawMind Session Summary",
      "",
      `- Session ID: \`${sessionId}\``,
      `- Generated At: ${new Date().toISOString()}`,
      `- Messages Summarized: ${messages.length}`,
      "",
      "## Earlier Conversation",
      "",
    ];

    messages.forEach((message, index) => {
      const role = message.role.toUpperCase();
      const body = this.normalizeText(this.messageToText(message));
      const excerpt = this.truncate(body, this.config.entryCharLimit) || "(empty message)";

      lines.push(`${index + 1}. **${role}**`);
      lines.push("");
      lines.push(excerpt);
      lines.push("");
    });

    return lines.join("\n").trimEnd() + "\n";
  }

  private messageToText(message: AgentMessage): string {
    if (typeof message.content === "string") {
      return message.content;
    }

    if (!Array.isArray(message.content)) {
      return "";
    }

    return message.content
      .map((block) => {
        if (typeof block.text === "string" && block.text.trim()) {
          return block.text;
        }

        if (typeof block.type === "string") {
          return `[${block.type} block]`;
        }

        return "[structured block]";
      })
      .join("\n");
  }

  private contentChars(content: AgentMessage["content"]): number {
    if (typeof content === "string") {
      return content.length;
    }

    if (Array.isArray(content)) {
      return content.reduce((sum, block) => sum + (typeof block.text === "string" ? block.text.length : 0), 0);
    }

    return 0;
  }

  private estimateTokens(messages: AgentMessage[]): number {
    return messages.reduce((sum, message) => sum + Math.ceil(this.contentChars(message.content) / 4), 0);
  }

  private normalizeText(value: string): string {
    return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  private truncate(value: string, limit: number): string {
    if (value.length <= limit) {
      return value;
    }

    return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
  }

  private toSafeFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-");
  }
}

export function createPlugin(config: ClawMindPluginConfig = {}): ContextEngine {
  return new ClawMindContextEngine(config);
}

export default {
  id: PLUGIN_ID,
  name: "ClawMind Context Engine",
  description: "A local Markdown context engine that compacts OpenClaw session history without network calls.",

  register(api: {
    logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
    pluginConfig?: ClawMindPluginConfig;
    registerContextEngine?: (id: string, factory: () => ContextEngine) => void;
    [key: string]: unknown;
  }) {
    api.logger.info("[ClawMind] Plugin initialized, preparing context engine...");

    const config: ClawMindPluginConfig = api.pluginConfig ?? {};
    if (typeof api.registerContextEngine === "function") {
      api.registerContextEngine(PLUGIN_ID, () => new ClawMindContextEngine(config));
      api.logger.info("[ClawMind] Context engine factory registered via registerContextEngine(id, factory)");
      return;
    }

    api.logger.error("[ClawMind] Error: registerContextEngine not found on API.");
    api.logger.error("[ClawMind] Available API keys:", Object.keys(api));
  },
};
