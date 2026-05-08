#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { initComposeData } from "./init-compose-data.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

function parseArgs(argv) {
  let dataDir = path.join(rootDir, "data");
  let detach = true;
  let build = true;
  let composeFile = path.join(rootDir, "docker-compose.standalone.yml");
  let mode = "standalone";
  const passthroughArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--foreground") {
      detach = false;
      continue;
    }
    if (arg === "--no-build") {
      build = false;
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
    if (arg === "--compose-file") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error("--compose-file requires a value");
      }
      composeFile = path.resolve(nextArg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--compose-file=")) {
      composeFile = path.resolve(arg.slice("--compose-file=".length));
      continue;
    }
    if (arg === "--mode") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error("--mode requires a value");
      }
      mode = nextArg;
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }
    passthroughArgs.push(arg);
  }

  return { dataDir, detach, build, composeFile, mode, passthroughArgs };
}

function toComposePath(targetPath) {
  return targetPath.replace(/\\/g, "/");
}

async function main(argv) {
  const { dataDir, detach, build, composeFile, mode, passthroughArgs } = parseArgs(argv);
  await initComposeData(dataDir, mode);

  const composeArgs = [
    "compose",
    "-f",
    composeFile,
    "up",
    ...(detach ? ["-d"] : []),
    ...(build ? ["--build"] : []),
    ...passthroughArgs,
  ];

  const env = { ...process.env };
  env.MINIOS_DATA_DIR = toComposePath(path.resolve(path.join(dataDir, mode)));

  process.stdout.write(
    `starting compose stack with compose file: ${composeFile}, mode: ${mode}, data dir: ${path.resolve(dataDir)}\n`,
  );

  const result = spawnSync("docker", composeArgs, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
