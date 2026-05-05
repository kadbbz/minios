import path from "node:path";
import { readFile } from "node:fs/promises";
import { AgentManager, type AgentInfo, type PlatformPaths } from "../core/agent-manager.js";
import { ensureDir, writeTextFile } from "../core/fs-utils.js";
import type { SessionLocator } from "../core/session-keys.js";
import { FileSessionStore, type UsageQueryResult } from "./file-session-store.js";
import { FileTransferService } from "./file-transfer.js";
import { LlmClient } from "./llm-client.js";
import {
  type AttachmentRef,
  type LlmUsageRecord,
  createEventId,
  createOutboundMessageId,
  createTurnId,
  normalizeControlMessage,
  normalizeInboundMessage,
  type BusinessChannel,
  type ControlMessage,
  type ControlResponse,
  type InboundMessage,
  type OutboundMessage,
  type PersistedSessionEvent,
} from "./protocol.js";

export interface WorkerResult {
  deduped: boolean;
  events: OutboundMessage[];
}

export class LocalAgentWorker {
  private readonly agentManager: AgentManager;
  private readonly sessionStore: FileSessionStore;
  private readonly fileTransfer: FileTransferService;
  private readonly llmClient: LlmClient;
  private readonly activeSessions = new Set<string>();
  private readonly agentCache = new Map<string, { loadedAt: string }>();

  constructor(
    private readonly paths: PlatformPaths,
    private readonly workerId = "worker-local",
  ) {
    this.agentManager = new AgentManager(paths);
    this.sessionStore = new FileSessionStore(paths, workerId);
    this.fileTransfer = new FileTransferService();
    this.llmClient = new LlmClient();
  }

  async processBusinessMessage(agentId: string, channel: BusinessChannel, rawPayload: unknown): Promise<WorkerResult> {
    const payload = normalizeInboundMessage(rawPayload, channel);
    const locator: SessionLocator = {
      agentId,
      sessionId: payload.sessionId,
      threadId: payload.threadId,
    };
    const sessionKey = `${agentId}:${payload.sessionId}:${payload.threadId}`;

    if (this.activeSessions.has(sessionKey)) {
      return {
        deduped: false,
        events: [this.createOutboundMessage(payload, "block", "session is busy, please retry later")],
      };
    }

    this.activeSessions.add(sessionKey);

    try {
      return await this.runSession(agentId, locator, payload);
    } finally {
      this.activeSessions.delete(sessionKey);
    }
  }

  async processControlMessage(agentId: string, rawPayload: unknown): Promise<ControlResponse> {
    const payload = normalizeControlMessage(rawPayload);
    return this.handleControl(agentId, payload);
  }

  async doctor(agentId: string): Promise<Record<string, unknown>> {
    const agent = await this.agentManager.getAgentInfo(agentId);
    const sessions = await this.sessionStore.listSessionMetas(agentId);
    const sessionIds = new Set(sessions.map((session) => session.sessionId));

    return {
      agentId,
      workerId: this.workerId,
      manifestVersion: agent.version,
      enabled: agent.enabled,
      workspaceDir: agent.workspaceDir,
      qmdDir: agent.qmdDir,
      stateDir: agent.stateDir,
      skillsDir: agent.skillsDir,
      sessionThreadCount: sessions.length,
      sessionCount: sessionIds.size,
      cacheLoaded: this.agentCache.has(agentId),
      timestamp: new Date().toISOString(),
    };
  }

  async restart(agentId: string): Promise<Record<string, unknown>> {
    const sessions = await this.sessionStore.listSessionMetas(agentId);
    this.agentCache.delete(agentId);
    return {
      agentId,
      workerId: this.workerId,
      clearedRuntimeCache: true,
      cachedSessionThreads: sessions.length,
      restartedAt: new Date().toISOString(),
    };
  }

  async logs(
    agentId: string,
    filters: {
      sessionId?: string;
      threadId?: string;
      traceId?: string;
      tail?: number;
    },
  ): Promise<Record<string, unknown>> {
    const events = await this.sessionStore.listEvents(agentId, filters);
    return {
      agentId,
      workerId: this.workerId,
      count: events.length,
      events,
    };
  }

  async usage(startDate: string, endDate: string): Promise<UsageQueryResult[]> {
    return this.sessionStore.queryUsageBySession(startDate, endDate);
  }

  private async runSession(agentId: string, locator: SessionLocator, payload: InboundMessage): Promise<WorkerResult> {
    const agent = await this.agentManager.getAgentInfo(agentId);
    this.agentCache.set(agentId, { loadedAt: new Date().toISOString() });

    const accepted = await this.sessionStore.recordInboundMessage(locator, payload.messageId);
    if (!accepted) {
      const previousEvents = await this.sessionStore.readEventsForMessage(locator, payload.messageId);
      return {
        deduped: true,
        events: previousEvents.flatMap((event) => this.eventToOutbound(locator, payload, event)),
      };
    }

    const startedAt = new Date().toISOString();
    await this.sessionStore.updateMeta(locator, (meta) => ({
      ...meta,
      status: "running",
      updatedAt: startedAt,
      lastWorkerId: this.workerId,
    }));

    const storedEvents: PersistedSessionEvent[] = [
      {
        id: createEventId(),
        type: "user_message",
        createdAt: startedAt,
        messageId: payload.messageId,
        traceId: payload.traceId,
        text: payload.text,
      },
    ];

    const outbound: OutboundMessage[] = [];
    const thinking = this.createOutboundMessage(
      payload,
      "thinking",
      payload.channel === "file" ? "正在处理文件消息" : "正在处理文本消息",
    );
    outbound.push(thinking);
    storedEvents.push(this.outboundToEvent(thinking, payload.messageId, "assistant_thinking"));

    if (payload.attachments.length > 0) {
      const tool = this.createOutboundMessage(
        payload,
        "tool",
        payload.channel === "file"
          ? `检测到 ${payload.attachments.length} 个文件对象引用，当前走独立文件入站链路`
          : `检测到 ${payload.attachments.length} 个附件引用，当前为文本消息附带文件`,
      );
      outbound.push(tool);
      storedEvents.push(this.outboundToEvent(tool, payload.messageId, "tool_call"));
    }

    let downloadedAttachments: Array<{ ref: AttachmentRef; localPath: string }> = [];
    if (payload.channel === "file") {
      downloadedAttachments = await this.fileTransfer.downloadInboundAttachments(
        agent,
        locator,
        payload.messageId,
        payload.attachments,
      );
      const downloadTool = this.createOutboundMessage(
        payload,
        "tool",
        `已下载 ${downloadedAttachments.length} 个文件到 inbox: ${downloadedAttachments.map((item) => item.ref.name).join(", ")}`,
      );
      outbound.push(downloadTool);
      storedEvents.push(this.outboundToEvent(downloadTool, payload.messageId, "tool_call"));
    }

    const remembered = extractMemoryNote(payload.text);
    if (remembered) {
      const memoryPath = await this.sessionStore.appendMemoryNote(locator, remembered);
      storedEvents.push({
        id: createEventId(),
        type: "system_note",
        createdAt: new Date().toISOString(),
        traceId: payload.traceId,
        messageId: payload.messageId,
        text: `memory note saved: ${path.basename(memoryPath)}`,
        payload: { memoryPath },
      });
    }

    const memoryNotes = await this.sessionStore.readSessionMemoryNotes(locator);
    const previousThreadTurns = (await this.sessionStore.readEvents(locator)).filter(
      (event) => event.type === "assistant_message_final",
    ).length;
    const finalInput: {
      text: string;
      previousThreadTurns: number;
      attachmentCount: number;
      memoryCount: number;
      remembered?: string;
      downloadedFileCount?: number;
      uploadedFileCount?: number;
    } = {
      text: payload.text,
      previousThreadTurns,
      attachmentCount: payload.attachments.length,
      memoryCount: memoryNotes.length,
    };
    if (remembered) {
      finalInput.remembered = remembered;
    }
    if (downloadedAttachments.length > 0) {
      finalInput.downloadedFileCount = downloadedAttachments.length;
    }
    const finalTurnId = createTurnId();
    let finalAttachments: AttachmentRef[] = [];
    let finalTokens:
      | {
          input: number;
          output: number;
        }
      | undefined;
    if (payload.channel === "file") {
      if (shouldRunTemplateFill(payload)) {
        const uploaded = await this.runTemplateFillWorkflow(agent, locator, payload, finalTurnId, downloadedAttachments);
        finalAttachments = uploaded.attachments.map((item) => item.ref);
        finalTokens = uploaded.tokens;
      } else {
        const uploaded = await this.fileTransfer.uploadReplyArtifacts(agent, locator, finalTurnId, downloadedAttachments);
        finalAttachments = uploaded.map((item) => item.ref);
      }
      finalInput.uploadedFileCount = finalAttachments.length;
    }
    const finalText = buildFinalText(finalInput);
    const finalOptions: {
      attachments?: AttachmentRef[];
      turnId?: string;
      tokens?: {
        input: number;
        output: number;
      };
    } = {
      attachments: finalAttachments,
      turnId: finalTurnId,
    };
    if (finalTokens) {
      finalOptions.tokens = finalTokens;
    }
    const finalMessage = this.createOutboundMessage(payload, "final", finalText, finalOptions);
    outbound.push(finalMessage);
    storedEvents.push(this.outboundToEvent(finalMessage, payload.messageId, "assistant_message_final"));

    await this.sessionStore.appendEvents(locator, storedEvents);
    await this.sessionStore.appendTranscript(
      locator,
      [
        `## ${new Date().toISOString()}`,
        ``,
        `- user: ${payload.text}`,
        `- assistant: ${finalText}`,
        ``,
      ].join("\n"),
    );

    const completedAt = new Date().toISOString();
    await this.sessionStore.updateMeta(locator, (meta) => ({
      ...meta,
      status: "idle",
      messageCount: meta.messageCount + 1,
      lastMessageAt: completedAt,
      updatedAt: completedAt,
      lastWorkerId: this.workerId,
      summary: finalText,
    }));

    return {
      deduped: false,
      events: outbound,
    };
  }

  private async runTemplateFillWorkflow(
    agent: AgentInfo,
    locator: SessionLocator,
    payload: InboundMessage,
    turnId: string,
    downloadedAttachments: Array<{ ref: AttachmentRef; localPath: string }>,
  ): Promise<{
    attachments: Array<{ ref: AttachmentRef; localPath: string }>;
    tokens: {
      input: number;
      output: number;
    };
  }> {
    const templateSource = downloadedAttachments[0];
    if (!templateSource) {
      throw new Error("template fill workflow requires at least one downloaded attachment");
    }

    const templateMarkdown = await readFile(templateSource.localPath, "utf8");
    const llmResult = await this.llmClient.fillTemplate({
      templateMarkdown,
      taskText: payload.text,
    });
    const usageRecord: LlmUsageRecord = {
      recordedAt: new Date().toISOString(),
      dateKey: formatDateKey(new Date()),
      agentId: locator.agentId,
      sessionId: locator.sessionId,
      threadId: locator.threadId,
      traceId: payload.traceId,
      messageId: payload.messageId,
      turnId,
      providerId: llmResult.selectedModel.slice(0, llmResult.selectedModel.indexOf("/")),
      modelId: llmResult.selectedModel.slice(llmResult.selectedModel.indexOf("/") + 1),
      modelName: llmResult.selectedModelName,
      promptTokens: llmResult.usage.promptTokens,
      completionTokens: llmResult.usage.completionTokens,
      totalTokens: llmResult.usage.totalTokens,
      requestCount: 1,
    };
    await this.sessionStore.appendUsageRecord(usageRecord);

    const outputDir = path.join(
      agent.workspaceDir,
      "sessions",
      locator.sessionId,
      "outbox",
      locator.threadId,
      turnId,
    );
    await ensureDir(outputDir);

    const outputPath = path.join(outputDir, "filled-model-config.md");
    const outputContent = [
      llmResult.text.trim(),
      "",
      "---",
      `generated-by: ${llmResult.selectedModel}`,
      `tried-models: ${llmResult.triedModels.join(", ")}`,
      "",
    ].join("\n");
    await writeTextFile(outputPath, `${outputContent}\n`);

    const attachments = await this.fileTransfer.uploadExistingArtifacts(locator, turnId, [
      {
        localPath: outputPath,
        name: path.basename(outputPath),
        mediaType: "text/markdown",
      },
    ]);
    return {
      attachments,
      tokens: {
        input: llmResult.usage.promptTokens,
        output: llmResult.usage.completionTokens,
      },
    };
  }

  private async handleControl(agentId: string, payload: ControlMessage): Promise<ControlResponse> {
    let data: Record<string, unknown>;
    if (payload.command === "doctor") {
      data = await this.doctor(agentId);
    } else if (payload.command === "restart") {
      data = await this.restart(agentId);
    } else {
      const filters: {
        sessionId?: string;
        threadId?: string;
        traceId?: string;
        tail?: number;
      } = {};
      const sessionId = readOptionalStringArg(payload.args.sessionId);
      const threadId = readOptionalStringArg(payload.args.threadId);
      const traceId = readOptionalStringArg(payload.args.traceId);
      const tail = readOptionalNumberArg(payload.args.tail);
      if (sessionId) {
        filters.sessionId = sessionId;
      }
      if (threadId) {
        filters.threadId = threadId;
      }
      if (traceId) {
        filters.traceId = traceId;
      }
      if (tail !== undefined) {
        filters.tail = tail;
      }
      data = await this.logs(agentId, filters);
    }

    return {
      requestId: payload.requestId,
      success: true,
      traceId: payload.traceId,
      data,
    };
  }

  private createOutboundMessage(
    payload: InboundMessage,
    kind: OutboundMessage["kind"],
    text: string,
    options?: {
      attachments?: AttachmentRef[];
      turnId?: string;
      tokens?: {
        input: number;
        output: number;
      };
    },
  ): OutboundMessage {
    const outbound: OutboundMessage = {
      messageId: createOutboundMessageId(),
      sessionId: payload.sessionId,
      threadId: payload.threadId,
      text,
      kind,
      traceId: payload.traceId,
      turnId: options?.turnId ?? createTurnId(),
      attachments: options?.attachments ?? [],
    };
    if (options?.tokens) {
      outbound.tokens = options.tokens;
    }
    return outbound;
  }

  private outboundToEvent(
    outbound: OutboundMessage,
    sourceMessageId: string,
    type: PersistedSessionEvent["type"],
  ): PersistedSessionEvent {
    const event: PersistedSessionEvent = {
      id: createEventId(),
      type,
      createdAt: new Date().toISOString(),
      messageId: outbound.messageId,
      turnId: outbound.turnId,
      traceId: outbound.traceId,
      sourceMessageId,
      text: outbound.text,
      kind: outbound.kind,
      attachments: outbound.attachments,
    };
    if (outbound.tokens) {
      event.tokens = outbound.tokens;
    }
    return event;
  }

  private eventToOutbound(
    locator: SessionLocator,
    payload: InboundMessage,
    event: PersistedSessionEvent,
  ): OutboundMessage[] {
    if (!event.kind || !event.text || !event.messageId) {
      return [];
    }
    const outbound: OutboundMessage = {
      messageId: event.messageId,
      sessionId: locator.sessionId,
      threadId: locator.threadId,
      text: event.text,
      kind: event.kind,
      traceId: event.traceId ?? payload.traceId,
      turnId: event.turnId ?? createTurnId(),
      attachments: event.attachments ?? [],
    };
    if (event.tokens) {
      outbound.tokens = event.tokens;
    }
    return [outbound];
  }
}

function shouldRunTemplateFill(payload: InboundMessage): boolean {
  return payload.metadata?.workflow === "llm-template-fill";
}

function buildFinalText(input: {
  text: string;
  previousThreadTurns: number;
  attachmentCount: number;
  memoryCount: number;
  remembered?: string;
  downloadedFileCount?: number;
  uploadedFileCount?: number;
}): string {
  const parts = [
    `已收到: ${input.text.length > 0 ? input.text : "<empty>"}`,
    `当前 thread 历史完成轮次: ${input.previousThreadTurns}`,
    `当前 session 共享记忆条数: ${input.memoryCount}`,
  ];
  if (input.attachmentCount > 0) {
    parts.push(`附件引用数: ${input.attachmentCount}`);
  }
  if (input.downloadedFileCount !== undefined) {
    parts.push(`已下载文件数: ${input.downloadedFileCount}`);
  }
  if (input.uploadedFileCount !== undefined) {
    parts.push(`已上传结果文件数: ${input.uploadedFileCount}`);
  }
  if (input.remembered) {
    parts.push(`已写入会话记忆: ${input.remembered}`);
  }
  return parts.join(" | ");
}

function extractMemoryNote(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("/remember ")) {
    return trimmed.slice("/remember ".length).trim();
  }
  if (trimmed.startsWith("记住:")) {
    return trimmed.slice("记住:".length).trim();
  }
  return undefined;
}

function readOptionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalNumberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDateKey(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}
