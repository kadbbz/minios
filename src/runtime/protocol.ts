import { randomUUID } from "node:crypto";

export type MessageKind = "thinking" | "tool" | "block" | "final";
export type ControlCommand = "restart" | "doctor" | "logs";
export type BusinessChannel = "text" | "file";

export interface AttachmentRef {
  bucket: string;
  key: string;
  name: string;
  mediaType?: string;
  size?: number;
  sha256?: string;
}

export interface InboundMessage {
  messageId: string;
  sessionId: string;
  threadId: string;
  text: string;
  channel: BusinessChannel;
  attachments: AttachmentRef[];
  traceId: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  messageId: string;
  sessionId: string;
  threadId: string;
  text: string;
  kind: MessageKind;
  traceId: string;
  turnId: string;
  attachments: AttachmentRef[];
  tokens?: {
    input: number;
    output: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ControlMessage {
  command: ControlCommand;
  requestId: string;
  traceId: string;
  args: Record<string, unknown>;
}

export interface ControlResponse {
  requestId: string;
  success: boolean;
  traceId: string;
  data: Record<string, unknown>;
}

export interface PersistedSessionEvent {
  id: string;
  type:
    | "user_message"
    | "assistant_thinking"
    | "tool_call"
    | "assistant_message_final"
    | "tool_block"
    | "system_note";
  createdAt: string;
  messageId?: string;
  turnId?: string;
  traceId?: string;
  sourceMessageId?: string;
  text?: string;
  kind?: MessageKind;
  attachments?: AttachmentRef[];
  tokens?: {
    input: number;
    output: number;
  };
  payload?: Record<string, unknown>;
}

export interface LlmUsageRecord {
  recordedAt: string;
  dateKey: string;
  agentId: string;
  sessionId: string;
  threadId: string;
  traceId?: string;
  messageId?: string;
  turnId?: string;
  providerId: string;
  modelId: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

export interface PublishEnvelope<TPayload> {
  topic: string;
  payload: TPayload;
}

export function createTraceId(): string {
  return `trace-${randomUUID()}`;
}

export function createOutboundMessageId(): string {
  return `msg-out-${randomUUID()}`;
}

export function createTurnId(): string {
  return `turn-${randomUUID()}`;
}

export function createEventId(): string {
  return `evt-${randomUUID()}`;
}

export function normalizeInboundMessage(payload: unknown, channel: BusinessChannel): InboundMessage {
  assertRecord(payload, "inbound payload");

  const attachmentsValue = payload.attachments;
  const attachments = Array.isArray(attachmentsValue)
    ? attachmentsValue.map((attachment, index) => normalizeAttachment(attachment, index))
    : [];

  const normalized: InboundMessage = {
    messageId: readRequiredString(payload.messageId, "messageId"),
    sessionId: readResourceId(payload.sessionId, "sessionId"),
    threadId: readResourceId(payload.threadId, "threadId"),
    text: readMessageText(payload.text, channel),
    channel,
    attachments,
    traceId: readOptionalString(payload.traceId) ?? createTraceId(),
  };
  if (channel === "file" && attachments.length === 0) {
    throw new Error("file inbound payload must contain attachments");
  }
  const metadata = readOptionalRecord(payload.metadata);
  if (metadata) {
    normalized.metadata = metadata;
  }
  return normalized;
}

export function normalizeControlMessage(payload: unknown): ControlMessage {
  assertRecord(payload, "control payload");
  const command = readRequiredString(payload.command, "command");
  if (command !== "restart" && command !== "doctor" && command !== "logs") {
    throw new Error(`unsupported control command: ${command}`);
  }

  return {
    command,
    requestId: readRequiredString(payload.requestId, "requestId"),
    traceId: readOptionalString(payload.traceId) ?? createTraceId(),
    args: readOptionalRecord(payload.args) ?? {},
  };
}

function normalizeAttachment(value: unknown, index: number): AttachmentRef {
  assertRecord(value, `attachments[${index}]`);
  const attachment: AttachmentRef = {
    bucket: readRequiredString(value.bucket, `attachments[${index}].bucket`),
    key: readRequiredString(value.key, `attachments[${index}].key`),
    name: readRequiredString(value.name, `attachments[${index}].name`),
  };
  const mediaType = readOptionalString(value.mediaType);
  const size = readOptionalNumber(value.size);
  const sha256 = readOptionalString(value.sha256);
  if (mediaType) {
    attachment.mediaType = mediaType;
  }
  if (size !== undefined) {
    attachment.size = size;
  }
  if (sha256) {
    attachment.sha256 = sha256;
  }
  return attachment;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function readMessageText(value: unknown, channel: BusinessChannel): string {
  if (channel === "file") {
    if (value === undefined) {
      return "";
    }
    if (typeof value !== "string") {
      throw new Error("text must be a string when provided");
    }
    return value;
  }
  return readRequiredString(value, "text");
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("optional string field must be a non-empty string when provided");
  }
  return value;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("optional number field must be a finite number when provided");
  }
  return value;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("optional object field must be an object when provided");
  }
  return value as Record<string, unknown>;
}

function readResourceId(value: unknown, label: string): string {
  const stringValue = readRequiredString(value, label);
  if (!/^[A-Za-z0-9._-]+$/.test(stringValue)) {
    throw new Error(`${label} must match ^[A-Za-z0-9._-]+$`);
  }
  return stringValue;
}
