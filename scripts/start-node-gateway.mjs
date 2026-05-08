#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { initComposeData } from "./init-compose-data.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

function parseArgs(argv) {
  let dataDir = path.join(rootDir, "data");
  let skipBuild = false;
  const passthroughArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--data-dir") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error("--data-dir requires a value");
      }
      dataDir = path.resolve(nextArg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--data-dir=")) {
      dataDir = path.resolve(arg.slice("--data-dir=".length));
      continue;
    }
    passthroughArgs.push(arg);
  }

  return { dataDir, skipBuild, passthroughArgs };
}

function spawnOrThrow(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}

function resolveNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function main(argv) {
  const { dataDir, skipBuild, passthroughArgs } = parseArgs(argv);
  await initComposeData(dataDir, "node");

  if (!skipBuild) {
    process.stdout.write("building gateway before local node startup\n");
    spawnOrThrow(resolveNpmCommand(), ["run", "build"], { cwd: rootDir, env: process.env });
  }

  const modeRootDir = path.join(dataDir, "node");
  const gatewayDataDir = path.join(modeRootDir, "gateway");
  const configDir = path.join(modeRootDir, "config");
  const env = {
    ...process.env,
    MINIOS_DATA_DIR: gatewayDataDir,
    MINIOS_ROOT_DIR: path.join(gatewayDataDir, "root"),
    MINIOS_LLM_CONFIG_PATH: path.join(configDir, "llm.json"),
    MINIOS_ENV_PATH: path.join(configDir, "env.json"),
    MINIOS_VENDOR_DIR: path.join(rootDir, "vendor"),
  };

  process.stdout.write(`starting gateway in local node mode with data dir: ${path.resolve(modeRootDir)}\n`);
  spawnOrThrow("node", ["dist/gateway/server.js", ...passthroughArgs], { cwd: rootDir, env });
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
