import type { PlatformPaths } from "../core/agent-manager.js";
import { parseAgentTopic } from "../core/topic-router.js";
import { LocalAgentWorker } from "./local-worker.js";
import type { ControlResponse, OutboundMessage } from "./protocol.js";

export interface PublishResult {
  agentId: string;
  events: OutboundMessage[];
  deduped: boolean;
}

export class LocalGatewayRuntime {
  private readonly worker: LocalAgentWorker;

  constructor(paths: PlatformPaths, workerId?: string) {
    this.worker = new LocalAgentWorker(paths, workerId);
  }

  async publish(topic: string, payload: unknown): Promise<PublishResult> {
    const routed = parseAgentTopic(topic);
    const isLegacyBusiness = routed.channel === "business" && routed.direction === "in";
    const isTextInbound = routed.channel === "text" && routed.direction === "inbound";
    const isFileInbound = routed.channel === "file" && routed.direction === "inbound";
    if (!isLegacyBusiness && !isTextInbound && !isFileInbound) {
      throw new Error(
        `business publish requires agents/text/inbound/{agentId} or agents/file/inbound/{agentId}: ${topic}`,
      );
    }

    const channel = routed.channel === "file" ? "file" : "text";
    const result = await this.worker.processBusinessMessage(routed.agentId, channel, payload);
    return {
      agentId: routed.agentId,
      events: result.events,
      deduped: result.deduped,
    };
  }

  async control(topic: string, payload: unknown): Promise<ControlResponse> {
    const routed = parseAgentTopic(topic);
    const isLegacyControl = routed.channel === "control" && routed.direction === "in";
    const isNewControl = routed.channel === "control" && routed.direction === "inbound";
    if (!isLegacyControl && !isNewControl) {
      throw new Error(`control publish requires agents/control/inbound/{agentId}: ${topic}`);
    }
    return this.worker.processControlMessage(routed.agentId, payload);
  }
}
