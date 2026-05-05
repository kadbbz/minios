import path from "node:path";
import { pathExists, readJsonFile } from "../core/fs-utils.js";

export interface RuntimeEnvConfigDocument {
  gateway?: Record<string, string | number | boolean | null>;
  node?: Record<string, string | number | boolean | null>;
  minio?: Record<string, string | number | boolean | null>;
  emqx?: Record<string, string | number | boolean | null>;
}

let bootstrapCompleted = false;

export async function bootstrapRuntimeEnv(): Promise<void> {
  if (bootstrapCompleted) {
    return;
  }

  const envPath = resolveEnvConfigPath();
  if (!(await pathExists(envPath))) {
    bootstrapCompleted = true;
    return;
  }

  const raw = await readJsonFile<RuntimeEnvConfigDocument>(envPath);
  applyEnvBlock(raw.node);
  applyEnvBlock(raw.gateway);
  applyEnvBlock(raw.minio);
  applyEnvBlock(raw.emqx);
  process.env.MINIOS_ENV_PATH ??= envPath;
  bootstrapCompleted = true;
}

export function resolveEnvConfigPath(): string {
  const configuredPath = process.env.MINIOS_ENV_PATH;
  if (configuredPath && configuredPath.length > 0) {
    return path.resolve(configuredPath);
  }

  const dataDir = process.env.MINIOS_DATA_DIR;
  if (dataDir && dataDir.length > 0) {
    return path.resolve(dataDir, "config", "env.json");
  }

  return path.resolve(process.cwd(), "config", "env.json");
}

function applyEnvBlock(block: Record<string, string | number | boolean | null> | undefined): void {
  if (!block) {
    return;
  }

  for (const [key, value] of Object.entries(block)) {
    if (value === null) {
      continue;
    }
    if (process.env[key] === undefined) {
      process.env[key] = String(value);
    }
  }
}
