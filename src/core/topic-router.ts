export interface RoutedTopic {
  agentId: string;
  channel: "text" | "file" | "control" | "business";
  direction: "in" | "out" | "inbound" | "outbound";
}

export function parseAgentTopic(topic: string): RoutedTopic {
  const parts = topic.split("/");
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(`unsupported topic format: ${topic}`);
  }

  if (parts[0] !== "agents") {
    throw new Error(`topic must start with agents/: ${topic}`);
  }

  if (parts.length === 3) {
    const agentId = parts[1];
    if (!agentId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) {
      throw new Error(`invalid agent id in topic: ${topic}`);
    }
    const direction = parts[2];
    if (direction !== "in" && direction !== "out") {
      throw new Error(`unsupported business direction: ${topic}`);
    }
    return {
      agentId,
      channel: "business",
      direction,
    };
  }

  if (parts[1] === "control") {
    const direction = parts[2];
    const agentId = parts[3];
    if (!agentId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) {
      throw new Error(`invalid agent id in topic: ${topic}`);
    }
    if (direction !== "inbound" && direction !== "outbound") {
      throw new Error(`unsupported control direction: ${topic}`);
    }
    return {
      agentId,
      channel: "control",
      direction,
    };
  }

  const channel = parts[1];
  const direction = parts[2];
  const agentId = parts[3];
  if (!agentId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) {
    throw new Error(`invalid agent id in topic: ${topic}`);
  }
  if (channel !== "text" && channel !== "file") {
    throw new Error(`unsupported business topic: ${topic}`);
  }
  if (direction !== "inbound" && direction !== "outbound") {
    throw new Error(`unsupported business direction: ${topic}`);
  }

  return {
    agentId,
    channel,
    direction,
  };
}
