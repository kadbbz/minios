import path from "node:path";
import {
  copyDirectory,
  ensureDir,
  listDirectories,
  pathExists,
  removePath,
  validateResourceId,
} from "./fs-utils.js";
import type { PlatformPaths } from "./agent-manager.js";

export interface SkillInstallTarget {
  scope: "global" | "agent";
  agentId?: string;
}

export interface SkillRecord {
  id: string;
  scope: "global" | "agent";
  agentId?: string;
  path: string;
}

export class SkillManager {
  constructor(private readonly paths: PlatformPaths) {}

  async listGlobalSkills(): Promise<SkillRecord[]> {
    const rootDir = this.paths.globalSkillsDir;
    const ids = await listDirectories(rootDir);
    return ids.map((id) => ({ id, scope: "global", path: path.join(rootDir, id) }));
  }

  async listAgentSkills(agentId: string): Promise<SkillRecord[]> {
    validateResourceId(agentId, "agent id");
    const rootDir = path.join(this.paths.agentsDir, agentId, "skills");
    const ids = await listDirectories(rootDir);
    return ids.map((id) => ({ id, scope: "agent", agentId, path: path.join(rootDir, id) }));
  }

  async installSkill(sourcePath: string, target: SkillInstallTarget): Promise<SkillRecord> {
    if (!(await pathExists(sourcePath))) {
      throw new Error(`skill source not found: ${sourcePath}`);
    }

    const skillId = path.basename(sourcePath);
    validateResourceId(skillId, "skill id");
    const skillMdPath = path.join(sourcePath, "SKILL.md");
    if (!(await pathExists(skillMdPath))) {
      throw new Error(`skill missing SKILL.md: ${sourcePath}`);
    }

    const targetDir = this.resolveTargetDir(skillId, target);
    if (await pathExists(targetDir)) {
      throw new Error(`skill already installed: ${skillId}`);
    }

    await ensureDir(path.dirname(targetDir));
    await copyDirectory(sourcePath, targetDir);

    const record: SkillRecord = {
      id: skillId,
      scope: target.scope,
      path: targetDir,
    };
    if (target.agentId !== undefined) {
      record.agentId = target.agentId;
    }
    return record;
  }

  async uninstallSkill(skillId: string, target: SkillInstallTarget): Promise<void> {
    validateResourceId(skillId, "skill id");
    const targetDir = this.resolveTargetDir(skillId, target);
    if (!(await pathExists(targetDir))) {
      throw new Error(`skill not installed: ${skillId}`);
    }
    await removePath(targetDir);
  }

  private resolveTargetDir(skillId: string, target: SkillInstallTarget): string {
    if (target.scope === "global") {
      return path.join(this.paths.globalSkillsDir, skillId);
    }
    if (!target.agentId) {
      throw new Error("agentId is required for agent skill target");
    }
    validateResourceId(target.agentId, "agent id");
    return path.join(this.paths.agentsDir, target.agentId, "skills", skillId);
  }
}
