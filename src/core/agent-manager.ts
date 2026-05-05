import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  copyDirectory,
  ensureDir,
  listDirectories,
  pathExists,
  readJsonFile,
  removePath,
  validateResourceId,
  writeJsonFile,
} from "./fs-utils.js";

export interface PlatformPaths {
  rootDir: string;
  platformDir: string;
  templatesDir: string;
  agentsDir: string;
  globalSkillsDir: string;
}

export interface AgentManifest {
  id: string;
  templateId: string;
  name: string;
  version: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  workspaceDir: string;
  qmdDir: string;
  stateDir: string;
  skillsDir: string;
}

export interface AgentInfo extends AgentManifest {
  exists: true;
}

export interface AddAgentOptions {
  id: string;
  templateId: string;
  name?: string;
}

export function createPlatformPaths(rootDir: string): PlatformPaths {
  const platformDir = path.join(rootDir, "data", "platform");
  return {
    rootDir,
    platformDir,
    templatesDir: path.join(platformDir, "templates"),
    agentsDir: path.join(rootDir, "data", "agents"),
    globalSkillsDir: path.join(platformDir, "skills", "global"),
  };
}

export class AgentManager {
  constructor(private readonly paths: PlatformPaths) {}

  async listAgents(): Promise<AgentManifest[]> {
    const ids = await listDirectories(this.paths.agentsDir);
    const manifests = await Promise.all(
      ids.map(async (id) => this.readAgentManifest(id)),
    );
    return manifests.sort((left, right) => left.id.localeCompare(right.id));
  }

  async addAgent(options: AddAgentOptions): Promise<AgentInfo> {
    validateResourceId(options.id, "agent id");
    validateResourceId(options.templateId, "template id");

    const templateDir = this.templateDir(options.templateId);
    if (!(await pathExists(templateDir))) {
      throw new Error(`template not found: ${options.templateId}`);
    }

    const agentDir = this.agentDir(options.id);
    if (await pathExists(agentDir)) {
      throw new Error(`agent already exists: ${options.id}`);
    }

    const workspaceDir = path.join(agentDir, "workspace");
    const qmdDir = path.join(agentDir, "qmd");
    const stateDir = path.join(agentDir, "state");
    const skillsDir = path.join(agentDir, "skills");

    await Promise.all([
      ensureDir(workspaceDir),
      ensureDir(path.join(workspaceDir, "memory")),
      ensureDir(path.join(workspaceDir, "sessions")),
      ensureDir(path.join(workspaceDir, "inbox")),
      ensureDir(path.join(workspaceDir, "outbox")),
      ensureDir(path.join(workspaceDir, "tmp")),
      ensureDir(qmdDir),
      ensureDir(stateDir),
      ensureDir(skillsDir),
    ]);

    await this.copyTemplateFiles(options.templateId, workspaceDir);
    await writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Memory\n\n- This file stores long-term agent memory.\n",
      "utf8",
    );

    const now = new Date().toISOString();
    const manifest: AgentManifest = {
      id: options.id,
      templateId: options.templateId,
      name: options.name ?? options.id,
      version: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      workspaceDir,
      qmdDir,
      stateDir,
      skillsDir,
    };
    await writeJsonFile(this.manifestPath(options.id), manifest);
    return { ...manifest, exists: true };
  }

  async deleteAgent(id: string): Promise<void> {
    validateResourceId(id, "agent id");
    const agentDir = this.agentDir(id);
    if (!(await pathExists(agentDir))) {
      throw new Error(`agent not found: ${id}`);
    }
    await removePath(agentDir);
  }

  async getAgentInfo(id: string): Promise<AgentInfo> {
    validateResourceId(id, "agent id");
    const manifest = await this.readAgentManifest(id);
    return { ...manifest, exists: true };
  }

  async restoreAgent(id: string): Promise<AgentInfo> {
    const manifest = await this.readAgentManifest(id);
    const workspaceDir = path.join(this.agentDir(id), "workspace");
    await this.copyTemplateFiles(manifest.templateId, workspaceDir);
    manifest.version += 1;
    manifest.updatedAt = new Date().toISOString();
    await writeJsonFile(this.manifestPath(id), manifest);
    return { ...manifest, exists: true };
  }

  async readTemplateManifest(templateId: string): Promise<Record<string, unknown> | null> {
    const templateManifestPath = path.join(this.templateDir(templateId), "manifest.json");
    if (!(await pathExists(templateManifestPath))) {
      return null;
    }
    return readJsonFile<Record<string, unknown>>(templateManifestPath);
  }

  private async copyTemplateFiles(templateId: string, workspaceDir: string): Promise<void> {
    const templateDir = this.templateDir(templateId);
    for (const name of ["AGENTS.md", "SOUL.md", "USER.md"]) {
      const sourcePath = path.join(templateDir, name);
      if (!(await pathExists(sourcePath))) {
        throw new Error(`template file missing: ${templateId}/${name}`);
      }
      const content = await readFile(sourcePath, "utf8");
      await writeFile(path.join(workspaceDir, name), content, "utf8");
    }
  }

  private async readAgentManifest(id: string): Promise<AgentManifest> {
    const manifestPath = this.manifestPath(id);
    if (!(await pathExists(manifestPath))) {
      throw new Error(`agent manifest not found: ${id}`);
    }
    return readJsonFile<AgentManifest>(manifestPath);
  }

  private templateDir(templateId: string): string {
    return path.join(this.paths.templatesDir, templateId);
  }

  private agentDir(id: string): string {
    return path.join(this.paths.agentsDir, id);
  }

  private manifestPath(id: string): string {
    return path.join(this.agentDir(id), "manifest.json");
  }
}

