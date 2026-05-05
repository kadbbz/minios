#!/usr/bin/env node

import path from "node:path";
import { AgentManager, createPlatformPaths } from "./core/agent-manager.js";
import { readJsonFile } from "./core/fs-utils.js";
import { SkillManager } from "./core/skill-manager.js";
import { LocalGatewayRuntime } from "./runtime/local-gateway.js";
import { LocalAgentWorker } from "./runtime/local-worker.js";
import { bootstrapRuntimeEnv } from "./runtime/env-config.js";
import { loadPlatformConfig, validatePlatformConfig } from "./runtime/platform-config.js";
import { runPlatformDoctor } from "./runtime/platform-doctor.js";

async function main(argv: string[]): Promise<number> {
  try {
    await bootstrapRuntimeEnv();
    const parsed = parseArgs(argv);
    const rootDirFlag = parsed.flags.root;
    const rootDir =
      typeof rootDirFlag === "string"
        ? path.resolve(rootDirFlag)
        : path.resolve(process.env.MINIOS_ROOT_DIR ?? process.cwd());
    const paths = createPlatformPaths(rootDir);
    const agentManager = new AgentManager(paths);
    const skillManager = new SkillManager(paths);
    const worker = new LocalAgentWorker(paths);
    const gateway = new LocalGatewayRuntime(paths);

    if (parsed.command[0] === "agents") {
      return await handleAgents(agentManager, worker, parsed.command.slice(1), parsed.flags);
    }
    if (parsed.command[0] === "skills") {
      return await handleSkills(skillManager, parsed.command.slice(1), parsed.flags, parsed.positionals);
    }
    if (parsed.command[0] === "platform" && parsed.command[1] === "doctor") {
      printJson({ ok: true, result: await runPlatformDoctor() });
      return 0;
    }
    if (parsed.command[0] === "platform" && parsed.command[1] === "config" && parsed.command[2] === "validate") {
      const configPathFlag = parsed.flags.path;
      const configPath =
        typeof configPathFlag === "string"
          ? path.resolve(configPathFlag)
          : path.resolve(
              process.env.MINIOS_LLM_CONFIG_PATH ??
                path.join(process.env.MINIOS_DATA_DIR ?? process.cwd(), "config", "llm.json"),
            );
      const config = await loadPlatformConfig(configPath);
      const result = validatePlatformConfig(config);
      printJson({ ok: result.ok, configPath, result });
      return result.ok ? 0 : 1;
    }
    if (parsed.command[0] === "runtime" && parsed.command[1] === "publish") {
      const topic = readStringFlag(parsed.flags, "topic");
      const payloadPath = parsed.positionals[0];
      if (!payloadPath) {
        throw new Error("missing payload path");
      }
      const payload = await readJsonFile<Record<string, unknown>>(path.resolve(payloadPath));
      printJson({ ok: true, result: await gateway.publish(topic, payload) });
      return 0;
    }
    if (parsed.command[0] === "runtime" && parsed.command[1] === "control") {
      const topic = readStringFlag(parsed.flags, "topic");
      const payloadPath = parsed.positionals[0];
      if (!payloadPath) {
        throw new Error("missing payload path");
      }
      const payload = await readJsonFile<Record<string, unknown>>(path.resolve(payloadPath));
      printJson({ ok: true, result: await gateway.control(topic, payload) });
      return 0;
    }
    if (parsed.command[0] === "policy" && parsed.command[1] === "check") {
      const policyPath = parsed.positionals[0];
      if (!policyPath) {
        throw new Error("missing policy path");
      }
      const payload = await readJsonFile<Record<string, unknown>>(path.resolve(policyPath));
      printJson({ ok: true, policy: payload });
      return 0;
    }
    if (parsed.command[0] === "usage") {
      const startDate = readStringFlag(parsed.flags, "start");
      const endDate = readStringFlag(parsed.flags, "end");
      printJson(await worker.usage(startDate, endDate));
      return 0;
    }

    throw new Error("unsupported command");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printJson({ ok: false, error: message });
    return 1;
  }
}

async function handleAgents(
  agentManager: AgentManager,
  worker: LocalAgentWorker,
  command: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const action = command[0];
  if (action === "list") {
    printJson({ ok: true, agents: await agentManager.listAgents() });
    return 0;
  }
  if (action === "add") {
    const id = readStringFlag(flags, "id");
    const templateId = readStringFlag(flags, "template");
    const name = typeof flags.name === "string" ? flags.name : undefined;
    const options = name === undefined ? { id, templateId } : { id, templateId, name };
    printJson({ ok: true, agent: await agentManager.addAgent(options) });
    return 0;
  }
  if (action === "delete") {
    const id = readStringFlag(flags, "id");
    await agentManager.deleteAgent(id);
    printJson({ ok: true, deleted: id });
    return 0;
  }
  if (action === "info") {
    const id = readStringFlag(flags, "id");
    printJson({ ok: true, agent: await agentManager.getAgentInfo(id) });
    return 0;
  }
  if (action === "restore") {
    const id = readStringFlag(flags, "id");
    printJson({ ok: true, agent: await agentManager.restoreAgent(id) });
    return 0;
  }
  if (action === "restart") {
    const id = readStringFlag(flags, "id");
    printJson({ ok: true, result: await worker.restart(id) });
    return 0;
  }
  if (action === "doctor") {
    const id = readStringFlag(flags, "id");
    printJson({ ok: true, result: await worker.doctor(id) });
    return 0;
  }
  if (action === "logs") {
    const id = readStringFlag(flags, "id");
    const tailValue = typeof flags.tail === "string" ? Number(flags.tail) : undefined;
    const filters: {
      sessionId?: string;
      threadId?: string;
      traceId?: string;
      tail?: number;
    } = {};
    if (typeof flags.session === "string") {
      filters.sessionId = flags.session;
    }
    if (typeof flags.thread === "string") {
      filters.threadId = flags.thread;
    }
    if (typeof flags.trace === "string") {
      filters.traceId = flags.trace;
    }
    if (tailValue !== undefined && !Number.isNaN(tailValue)) {
      filters.tail = tailValue;
    }
    printJson({
      ok: true,
      result: await worker.logs(id, filters),
    });
    return 0;
  }
  throw new Error(`unsupported agents action: ${action ?? "<missing>"}`);
}

async function handleSkills(
  skillManager: SkillManager,
  command: string[],
  flags: Record<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  const action = command[0];
  if (action === "list") {
    if (typeof flags.agent === "string") {
      printJson({ ok: true, skills: await skillManager.listAgentSkills(flags.agent) });
      return 0;
    }
    printJson({ ok: true, skills: await skillManager.listGlobalSkills() });
    return 0;
  }
  if (action === "install") {
    const sourcePath = positionals[0];
    if (!sourcePath) {
      throw new Error("missing skill source path");
    }
    const target = resolveSkillTarget(flags);
    printJson({
      ok: true,
      skill: await skillManager.installSkill(path.resolve(sourcePath), target),
    });
    return 0;
  }
  if (action === "uninstall") {
    const skillId = positionals[0];
    if (!skillId) {
      throw new Error("missing skill id");
    }
    const target = resolveSkillTarget(flags);
    await skillManager.uninstallSkill(skillId, target);
    printJson({ ok: true, uninstalled: skillId, target });
    return 0;
  }
  throw new Error(`unsupported skills action: ${action ?? "<missing>"}`);
}

function resolveSkillTarget(flags: Record<string, string | boolean>): { scope: "global" | "agent"; agentId?: string } {
  if (flags.g === true || flags.global === true) {
    return { scope: "global" };
  }
  if (typeof flags.a === "string") {
    return { scope: "agent", agentId: flags.a };
  }
  if (typeof flags.agent === "string") {
    return { scope: "agent", agentId: flags.agent };
  }
  throw new Error("skill target must be specified with -g or -a <agentId>");
}

function readStringFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required flag --${name}`);
  }
  return value;
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv: string[]): {
  command: string[];
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const booleanFlags = new Set(["g", "global"]);
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (booleanFlags.has(key) || !next || next.startsWith("-")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-")) {
      const key = token.slice(1);
      const next = argv[index + 1];
      if (booleanFlags.has(key) || !next || next.startsWith("-")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        index += 1;
      }
      continue;
    }
    const allowThirdCommandToken = command[0] === "platform" && command[1] === "config";
    if (
      (
        command.length < 2 ||
        (allowThirdCommandToken && command.length < 3)
      ) &&
      (
        token === "agents" ||
        token === "skills" ||
        token === "policy" ||
        token === "runtime" ||
        token === "platform" ||
        token === "usage" ||
        command.length > 0
      )
    ) {
      command.push(token);
      continue;
    }
    positionals.push(token);
  }

  return { command, flags, positionals };
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
