#!/usr/bin/env node

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

async function main(argv) {
  const rootDir = path.resolve(argv[0] ?? process.cwd());
  const configDir = path.join(rootDir, "config");
  const runtimeEnvDir = path.join(rootDir, "runtime-env");
  const envPath = path.join(configDir, "env.json");

  const raw = JSON.parse(await readFile(envPath, "utf8"));
  const minio = serializeEnvBlock(raw.minio, "env.json.minio");
  const emqx = serializeEnvBlock(raw.emqx, "env.json.emqx");

  await mkdir(runtimeEnvDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(runtimeEnvDir, "minio.env"), minio, "utf8"),
    writeFile(path.join(runtimeEnvDir, "emqx.env"), emqx, "utf8"),
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    rootDir,
    outputs: [
      path.join(runtimeEnvDir, "minio.env"),
      path.join(runtimeEnvDir, "emqx.env"),
    ],
  }, null, 2)}\n`);
}

function serializeEnvBlock(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const lines = [];
  for (const [key, rawValue] of Object.entries(value)) {
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new Error(`${label}.${key} must use shell-safe env key format`);
    }
    if (rawValue === null || rawValue === undefined) {
      lines.push(`${key}=`);
      continue;
    }
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw new Error(`${label}.${key} must be string, number, boolean, null or undefined`);
    }
    lines.push(`${key}=${String(rawValue)}`);
  }
  return `${lines.join("\n")}\n`;
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
