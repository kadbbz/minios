import path from "node:path";
import { appendFile, readdir, readFile } from "node:fs/promises";
import {
  ensureDir,
  listDirectories,
  pathExists,
  readJsonFileIfExists,
  readTextFileIfExists,
  writeJsonFile,
  writeTextFile,
} from "../core/fs-utils.js";
import type { PlatformPaths } from "../core/agent-manager.js";
import type { LlmUsageRecord, PersistedSessionEvent } from "./protocol.js";
import type { SessionLocator } from "../core/session-keys.js";

export interface UsageQueryResult {
  agentId: string;
  sessionId: string;
  usageByLlm: Array<{
    name: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
}

export interface SessionMetaRecord extends SessionLocator {
  status: "idle" | "running";
  messageCount: number;
  lastMessageAt: string | null;
  lastWorkerId: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionLogFilters {
  sessionId?: string;
  threadId?: string;
  traceId?: string;
  tail?: number;
}

export class FileSessionStore {
  constructor(
    private readonly paths: PlatformPaths,
    private readonly workerId: string,
  ) {}

  async getOrCreateMeta(locator: SessionLocator): Promise<SessionMetaRecord> {
    const metaPath = this.metaPath(locator);
    const existing = await readJsonFileIfExists<SessionMetaRecord | null>(metaPath, null);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const created: SessionMetaRecord = {
      ...locator,
      status: "idle",
      messageCount: 0,
      lastMessageAt: null,
      lastWorkerId: this.workerId,
      summary: "",
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonFile(metaPath, created);
    return created;
  }

  async updateMeta(locator: SessionLocator, updater: (meta: SessionMetaRecord) => SessionMetaRecord): Promise<SessionMetaRecord> {
    const next = updater(await this.getOrCreateMeta(locator));
    await writeJsonFile(this.metaPath(locator), next);
    return next;
  }

  async appendEvents(locator: SessionLocator, events: PersistedSessionEvent[]): Promise<void> {
    const existing = await this.readEvents(locator);
    existing.push(...events);
    await writeJsonFile(this.eventsPath(locator), existing);
  }

  async readEvents(locator: SessionLocator): Promise<PersistedSessionEvent[]> {
    return readJsonFileIfExists<PersistedSessionEvent[]>(this.eventsPath(locator), []);
  }

  async recordInboundMessage(locator: SessionLocator, messageId: string): Promise<boolean> {
    const dedupe = await readJsonFileIfExists<Record<string, string>>(this.dedupePath(locator), {});
    if (dedupe[messageId]) {
      return false;
    }
    dedupe[messageId] = new Date().toISOString();
    await writeJsonFile(this.dedupePath(locator), dedupe);
    return true;
  }

  async readEventsForMessage(locator: SessionLocator, sourceMessageId: string): Promise<PersistedSessionEvent[]> {
    const events = await this.readEvents(locator);
    return events.filter((event) => event.sourceMessageId === sourceMessageId);
  }

  async appendTranscript(
    locator: SessionLocator,
    content: string,
  ): Promise<void> {
    const transcriptPath = this.transcriptPath(locator);
    const previous = await readTextFileIfExists(transcriptPath, "");
    await writeTextFile(transcriptPath, `${previous}${content}`);
  }

  async appendMemoryNote(locator: SessionLocator, note: string): Promise<string> {
    const sessionMemoryDir = this.sessionMemoryDir(locator);
    await ensureDir(sessionMemoryDir);
    const fileName = `note-${Date.now()}.md`;
    const filePath = path.join(sessionMemoryDir, fileName);
    await writeTextFile(filePath, `${note.trim()}\n`);
    return filePath;
  }

  async readSessionMemoryNotes(locator: SessionLocator): Promise<string[]> {
    const sessionMemoryDir = this.sessionMemoryDir(locator);
    if (!(await pathExists(sessionMemoryDir))) {
      return [];
    }
    const entries = await readdir(sessionMemoryDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    return Promise.all(files.map(async (fileName) => readTextFileIfExists(path.join(sessionMemoryDir, fileName), "")));
  }

  async appendUsageRecord(record: LlmUsageRecord): Promise<void> {
    const targetPath = this.usagePath(record.agentId, record.dateKey);
    await ensureDir(path.dirname(targetPath));
    await appendFile(targetPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async queryUsageBySession(startDate: string, endDate: string): Promise<UsageQueryResult[]> {
    validateDateKey(startDate, "startDate");
    validateDateKey(endDate, "endDate");
    if (startDate > endDate) {
      throw new Error("startDate must be <= endDate");
    }

    const agentIds = await listDirectories(this.paths.agentsDir);
    const aggregate = new Map<
      string,
      {
        agentId: string;
        sessionId: string;
        usageByLlm: Map<
          string,
          {
            name: string;
            requests: number;
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
          }
        >;
      }
    >();

    for (const agentId of agentIds) {
      const usageDir = this.agentUsageDir(agentId);
      if (!(await pathExists(usageDir))) {
        continue;
      }
      const entries = await readdir(usageDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }
        const dateKey = entry.name.slice(0, -".jsonl".length);
        if (dateKey < startDate || dateKey > endDate) {
          continue;
        }
        const content = await readFile(path.join(usageDir, entry.name), "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            continue;
          }
          const record = JSON.parse(trimmed) as LlmUsageRecord;
          const aggregateKey = `${record.agentId}:${record.sessionId}`;
          let sessionUsage = aggregate.get(aggregateKey);
          if (!sessionUsage) {
            sessionUsage = {
              agentId: record.agentId,
              sessionId: record.sessionId,
              usageByLlm: new Map(),
            };
            aggregate.set(aggregateKey, sessionUsage);
          }

          let modelUsage = sessionUsage.usageByLlm.get(record.modelName);
          if (!modelUsage) {
            modelUsage = {
              name: record.modelName,
              requests: 0,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
            };
            sessionUsage.usageByLlm.set(record.modelName, modelUsage);
          }
          modelUsage.requests += record.requestCount;
          modelUsage.promptTokens += record.promptTokens;
          modelUsage.completionTokens += record.completionTokens;
          modelUsage.totalTokens += record.totalTokens;
        }
      }
    }

    return Array.from(aggregate.values())
      .map((sessionUsage) => ({
        agentId: sessionUsage.agentId,
        sessionId: sessionUsage.sessionId,
        usageByLlm: Array.from(sessionUsage.usageByLlm.values()).sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => {
        const byAgent = left.agentId.localeCompare(right.agentId);
        return byAgent !== 0 ? byAgent : left.sessionId.localeCompare(right.sessionId);
      });
  }

  async listSessionMetas(agentId: string): Promise<SessionMetaRecord[]> {
    const baseDir = this.agentSessionsStateDir(agentId);
    if (!(await pathExists(baseDir))) {
      return [];
    }
    const sessionDirs = await readdir(baseDir, { withFileTypes: true });
    const allMetas: SessionMetaRecord[] = [];

    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) {
        continue;
      }
      const threadRoot = path.join(baseDir, sessionDir.name);
      const threadDirs = await readdir(threadRoot, { withFileTypes: true });
      for (const threadDir of threadDirs) {
        if (!threadDir.isDirectory()) {
          continue;
        }
        const metaPath = path.join(threadRoot, threadDir.name, "meta.json");
        const meta = await readJsonFileIfExists<SessionMetaRecord | null>(metaPath, null);
        if (meta) {
          allMetas.push(meta);
        }
      }
    }

    return allMetas.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async listEvents(agentId: string, filters: SessionLogFilters): Promise<PersistedSessionEvent[]> {
    const sessionMetas = await this.listSessionMetas(agentId);
    const matchedMetas = sessionMetas.filter((meta) => {
      if (filters.sessionId && meta.sessionId !== filters.sessionId) {
        return false;
      }
      if (filters.threadId && meta.threadId !== filters.threadId) {
        return false;
      }
      return true;
    });

    const eventArrays = await Promise.all(
      matchedMetas.map(async (meta) =>
        this.readEvents({
          agentId: meta.agentId,
          sessionId: meta.sessionId,
          threadId: meta.threadId,
        }),
      ),
    );

    const flattened = eventArrays
      .flat()
      .filter((event) => (filters.traceId ? event.traceId === filters.traceId : true))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    if (!filters.tail || filters.tail <= 0) {
      return flattened;
    }
    return flattened.slice(-filters.tail);
  }

  private sessionStateDir(locator: SessionLocator): string {
    return path.join(this.agentSessionsStateDir(locator.agentId), locator.sessionId, locator.threadId);
  }

  private agentSessionsStateDir(agentId: string): string {
    return path.join(this.paths.agentsDir, agentId, "state", "sessions");
  }

  private metaPath(locator: SessionLocator): string {
    return path.join(this.sessionStateDir(locator), "meta.json");
  }

  private eventsPath(locator: SessionLocator): string {
    return path.join(this.sessionStateDir(locator), "events.json");
  }

  private dedupePath(locator: SessionLocator): string {
    return path.join(this.sessionStateDir(locator), "dedupe.json");
  }

  private transcriptPath(locator: SessionLocator): string {
    return path.join(
      this.paths.agentsDir,
      locator.agentId,
      "workspace",
      "sessions",
      locator.sessionId,
      "transcript",
      `${locator.threadId}.md`,
    );
  }

  private sessionMemoryDir(locator: SessionLocator): string {
    return path.join(
      this.paths.agentsDir,
      locator.agentId,
      "workspace",
      "sessions",
      locator.sessionId,
      "memory",
    );
  }

  private agentUsageDir(agentId: string): string {
    return path.join(this.paths.agentsDir, agentId, "state", "usage");
  }

  private usagePath(agentId: string, dateKey: string): string {
    return path.join(this.agentUsageDir(agentId), `${dateKey}.jsonl`);
  }
}

function validateDateKey(value: string, label: string): void {
  if (!/^\d{8}$/.test(value)) {
    throw new Error(`${label} must be in yyyyMMdd format`);
  }
}
