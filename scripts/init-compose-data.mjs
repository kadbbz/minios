#!/usr/bin/env node

import path from "node:path";
import { copyFile, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderRuntimeEnv } from "./render-runtime-env.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

const sharedSubdirs = [
  "redis",
  "emqx/data",
  "emqx/log",
  "minio/data",
  "minio/config",
];

function modeSubdirs(mode) {
  return [
    `${mode}/config`,
    `${mode}/gateway/root/data/platform/templates`,
    `${mode}/gateway/root/data/platform/skills/global`,
    `${mode}/gateway/root/data/agents`,
    `${mode}/gateway/logs`,
    `${mode}/gateway/test-runs`,
    `${mode}/runtime-env`,
  ];
}

export function resolveModeConfig(mode) {
  const normalizedMode = mode ?? "standalone";
  if (!["standalone", "gateway", "node"].includes(normalizedMode)) {
    throw new Error(`unsupported mode: ${normalizedMode}`);
  }
  return {
    mode: normalizedMode,
    sourceConfigDir: path.join(rootDir, "config", normalizedMode),
  };
}

export async function initComposeData(targetArg = path.join(rootDir, "data"), modeArg = "standalone") {
  const targetDir = path.resolve(targetArg);
  const { mode, sourceConfigDir } = resolveModeConfig(modeArg);

  await Promise.all(
    [...sharedSubdirs, ...modeSubdirs(mode)].map((relativeDir) =>
      mkdir(path.join(targetDir, relativeDir), { recursive: true }),
    ),
  );

  const targetConfigDir = path.join(targetDir, mode, "config");
  await copyIfMissing(path.join(sourceConfigDir, "llm.json"), path.join(targetConfigDir, "llm.json"));
  await copyIfMissing(path.join(sourceConfigDir, "env.json"), path.join(targetConfigDir, "env.json"));

  await renderRuntimeEnv(path.join(targetDir, mode));

  return {
    ok: true,
    targetDir,
    mode,
  };
}

async function copyIfMissing(sourcePath, targetPath) {
  try {
    await access(targetPath);
  } catch {
    await copyFile(sourcePath, targetPath);
  }
}

async function main(argv) {
  const result = await initComposeData(argv[0] ?? path.join(rootDir, "data"), argv[1] ?? "standalone");
  process.stdout.write(`initialized compose data root: ${result.targetDir} (mode=${result.mode})\n`);
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
