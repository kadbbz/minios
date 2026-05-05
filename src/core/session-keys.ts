export interface SessionLocator {
  agentId: string;
  sessionId: string;
  threadId: string;
}

function baseKey(locator: SessionLocator): string {
  return `agent:${locator.agentId}:session:${locator.sessionId}:thread:${locator.threadId}`;
}

export function sessionMetaKey(locator: SessionLocator): string {
  return `${baseKey(locator)}:meta`;
}

export function sessionEventsKey(locator: SessionLocator): string {
  return `${baseKey(locator)}:events`;
}

export function sessionSnapshotKey(locator: SessionLocator): string {
  return `${baseKey(locator)}:snapshot`;
}

export function sessionLockKey(locator: SessionLocator): string {
  return `${baseKey(locator)}:lock`;
}

export function sessionDedupeKey(locator: SessionLocator, messageId: string): string {
  return `${baseKey(locator)}:dedupe:${messageId}`;
}

