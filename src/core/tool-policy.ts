import path from "node:path";

export interface NetworkRule {
  host?: string;
  cidr?: string;
  ports: number[];
}

export interface BashCommandRule {
  id: string;
  match: string[];
  allowArgs?: boolean;
  inject?: string[];
}

export interface PathPolicy {
  read: string[];
  write: string[];
}

export interface BashPolicy {
  defaultAction: "allow" | "block";
  commands: BashCommandRule[];
  paths: PathPolicy;
  network: NetworkRule[];
}

export interface ToolPolicyDocument {
  tools: {
    bash: BashPolicy;
  };
}

export interface ToolExecutionContext {
  agentId: string;
  sessionId: string;
  threadId: string;
}

export interface RequestedPathAccess {
  mode: "read" | "write";
  path: string;
}

export interface RequestedNetworkAccess {
  host: string;
  port: number;
}

export interface PolicyRewriteInput {
  argv: string[];
  context: ToolExecutionContext;
  pathAccesses?: RequestedPathAccess[];
  networkAccesses?: RequestedNetworkAccess[];
}

export interface PolicyRewriteResult {
  allowed: boolean;
  ruleId?: string;
  argv?: string[];
  reason?: string;
}

export class ToolPolicyEngine {
  constructor(private readonly policy: ToolPolicyDocument) {}

  rewriteBashCall(input: PolicyRewriteInput): PolicyRewriteResult {
    const bashPolicy = this.policy.tools.bash;
    const matchedRule = bashPolicy.commands.find((rule) => matchesPrefix(input.argv, rule.match));

    if (!matchedRule && bashPolicy.defaultAction === "block") {
      return {
        allowed: false,
        reason: "command is not in the whitelist",
      };
    }

    if (!matchedRule && bashPolicy.defaultAction === "allow") {
      return {
        allowed: true,
        argv: [...input.argv],
      };
    }

    if (!matchedRule) {
      return {
        allowed: false,
        reason: "no matching command rule",
      };
    }

    const pathCheck = validatePathAccesses(
      input.pathAccesses ?? [],
      bashPolicy.paths,
      input.context,
    );
    if (!pathCheck.allowed) {
      return pathCheck;
    }

    const networkCheck = validateNetworkAccesses(
      input.networkAccesses ?? [],
      bashPolicy.network,
    );
    if (!networkCheck.allowed) {
      return networkCheck;
    }

    const rewrittenArgv = [...input.argv];
    for (const token of matchedRule.inject ?? []) {
      rewrittenArgv.push(expandToken(token, input.context));
    }

    return {
      allowed: true,
      ruleId: matchedRule.id,
      argv: rewrittenArgv,
    };
  }
}

function matchesPrefix(argv: string[], prefix: string[]): boolean {
  if (argv.length < prefix.length) {
    return false;
  }
  return prefix.every((part, index) => argv[index] === part);
}

function expandToken(token: string, context: ToolExecutionContext): string {
  return token
    .replaceAll("${agentId}", context.agentId)
    .replaceAll("${sessionId}", context.sessionId)
    .replaceAll("${threadId}", context.threadId);
}

function validatePathAccesses(
  accesses: RequestedPathAccess[],
  policy: PathPolicy,
  context: ToolExecutionContext,
): PolicyRewriteResult {
  for (const access of accesses) {
    const allowedRoots = access.mode === "read" ? policy.read : policy.write;
    const resolvedPath = path.resolve(access.path);
    const allowed = allowedRoots.some((root) => isPathInside(resolvedPath, expandToken(root, context)));
    if (!allowed) {
      return {
        allowed: false,
        reason: `path access denied for ${access.mode}: ${access.path}`,
      };
    }
  }
  return { allowed: true };
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const resolvedRoot = path.resolve(rootPath);
  const relativePath = path.relative(resolvedRoot, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function validateNetworkAccesses(
  accesses: RequestedNetworkAccess[],
  rules: NetworkRule[],
): PolicyRewriteResult {
  for (const access of accesses) {
    const allowed = rules.some((rule) => matchesNetworkRule(access, rule));
    if (!allowed) {
      return {
        allowed: false,
        reason: `network access denied for ${access.host}:${access.port}`,
      };
    }
  }
  return { allowed: true };
}

function matchesNetworkRule(access: RequestedNetworkAccess, rule: NetworkRule): boolean {
  if (!rule.ports.includes(access.port)) {
    return false;
  }
  if (rule.host) {
    return access.host === rule.host;
  }
  if (rule.cidr) {
    return ipInCidr(access.host, rule.cidr);
  }
  return false;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [network, prefixSizeValue] = cidr.split("/");
  const prefixSize = Number(prefixSizeValue);
  if (!network || Number.isNaN(prefixSize) || prefixSize < 0 || prefixSize > 32) {
    return false;
  }

  const ipInt = ipv4ToInt(ip);
  const networkInt = ipv4ToInt(network);
  if (ipInt === null || networkInt === null) {
    return false;
  }

  const mask = prefixSize === 0 ? 0 : (~0 << (32 - prefixSize)) >>> 0;
  return (ipInt & mask) === (networkInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    result = ((result << 8) | value) >>> 0;
  }
  return result >>> 0;
}

