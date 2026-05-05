import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadPlatformConfig, validatePlatformConfig } from "./platform-config.js";
import { resolveEnvConfigPath } from "./env-config.js";

export type DoctorStatus = "pass" | "fail";

export interface DoctorCheckResult {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface PlatformDoctorReport {
  ok: boolean;
  checkedAt: string;
  checks: DoctorCheckResult[];
}

export async function runPlatformDoctor(): Promise<PlatformDoctorReport> {
  const checks: DoctorCheckResult[] = [];

  checks.push(checkRequiredEnv("minios_data_dir", "MINIOS_DATA_DIR"));
  checks.push(checkRequiredEnv("minios_redis_url", "MINIOS_REDIS_URL"));
  checks.push(checkRequiredEnv("minios_mqtt_url", "MINIOS_MQTT_URL"));
  checks.push(checkRequiredEnv("minios_s3_endpoint", "MINIOS_S3_ENDPOINT"));
  checks.push(checkRequiredEnv("minios_s3_bucket_in", "MINIOS_S3_BUCKET_IN"));
  checks.push(checkRequiredEnv("minios_s3_bucket_out", "MINIOS_S3_BUCKET_OUT"));
  checks.push(checkCommand("node_cli", ["node", "--version"]));
  checks.push(checkCommand("qmd_cli", ["qmd", "--version"]));
  checks.push(checkCommand("aws_cli", ["aws", "--version"]));
  checks.push(checkBinaryPresence("mqtt_bash_exec_channel_cli", "mqtt-bash-exec-channel"));

  const dataDir = process.env.MINIOS_DATA_DIR;
  if (dataDir) {
    checks.push(await checkPathWritable("data_dir_writable", dataDir));
  }

  const redisUrl = process.env.MINIOS_REDIS_URL;
  if (redisUrl) {
    checks.push(await checkSocketUrl("redis_connectivity", redisUrl));
  }

  const mqttUrl = process.env.MINIOS_MQTT_URL;
  if (mqttUrl) {
    checks.push(await checkSocketUrl("mqtt_connectivity", mqttUrl));
  }

  const s3Endpoint = process.env.MINIOS_S3_ENDPOINT;
  if (s3Endpoint) {
    checks.push(await checkHttpEndpoint("s3_endpoint_connectivity", s3Endpoint));
  }
  checks.push(await checkPlatformConfig());

  return {
    ok: checks.every((check) => check.status === "pass"),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

async function checkPlatformConfig(): Promise<DoctorCheckResult> {
  const dataDir = process.env.MINIOS_DATA_DIR ?? "/data/minios";
  const configPath =
    process.env.MINIOS_LLM_CONFIG_PATH ??
    path.join(dataDir, "config", "llm.json");
  try {
    const config = await loadPlatformConfig(configPath);
    const result = validatePlatformConfig(config);
    if (result.ok) {
      const backupCount = result.config?.agents.defaults.model.backups.length ?? 0;
      return {
        name: "platform_config",
        status: "pass",
        detail: `validated ${configPath}; primary plus ${backupCount} backup model(s)`,
      };
    }
    return {
      name: "platform_config",
      status: "fail",
      detail: [...result.errors, ...result.warnings].join(" | "),
    };
  } catch (error) {
    return {
      name: "platform_config",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function currentEnvConfigPath(): string {
  return resolveEnvConfigPath();
}

function checkRequiredEnv(name: string, envName: string): DoctorCheckResult {
  const value = process.env[envName];
  if (typeof value === "string" && value.length > 0) {
    return {
      name,
      status: "pass",
      detail: `${envName} is set`,
    };
  }
  return {
    name,
    status: "fail",
    detail: `${envName} is missing`,
  };
}

function checkCommand(name: string, argv: string[]): DoctorCheckResult {
  const command = argv[0];
  if (!command) {
    return {
      name,
      status: "fail",
      detail: "missing command",
    };
  }

  const result = spawnSync(command, argv.slice(1), {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status === 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return {
      name,
      status: "pass",
      detail: output.length > 0 ? output.split("\n")[0] ?? "ok" : "ok",
    };
  }
  return {
    name,
    status: "fail",
    detail: [result.error?.message, result.stderr?.trim(), result.stdout?.trim()]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" | ") || "command failed",
  };
}

function checkBinaryPresence(name: string, binaryName: string): DoctorCheckResult {
  const result = spawnSync("bash", ["-lc", `command -v ${shellEscape(binaryName)}`], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status === 0) {
    return {
      name,
      status: "pass",
      detail: (result.stdout ?? "").trim() || `${binaryName} is available`,
    };
  }
  return {
    name,
    status: "fail",
    detail: `${binaryName} is not in PATH`,
  };
}

async function checkPathWritable(name: string, targetPath: string): Promise<DoctorCheckResult> {
  try {
    await access(targetPath, fsConstants.W_OK);
    return {
      name,
      status: "pass",
      detail: `${targetPath} is writable`,
    };
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkSocketUrl(name: string, rawUrl: string): Promise<DoctorCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: `invalid url: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const host = parsed.hostname;
  const port = parsed.port.length > 0 ? Number(parsed.port) : defaultPort(parsed.protocol);
  if (!host || !port) {
    return {
      name,
      status: "fail",
      detail: `missing host or port in ${rawUrl}`,
    };
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };

      const socket =
        parsed.protocol === "mqtts:" || parsed.protocol === "rediss:" || parsed.protocol === "tls:"
          ? tls.connect({
              host,
              port,
              servername: host,
              rejectUnauthorized: false,
            })
          : net.connect({
              host,
              port,
            });

      socket.setTimeout(10_000, () => {
        socket.destroy(new Error(`timeout connecting to ${host}:${port}`));
      });
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("secureConnect", () => {
        socket.end();
        resolve();
      });
    });

    return {
      name,
      status: "pass",
      detail: `connected to ${host}:${port}`,
    };
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkHttpEndpoint(name: string, rawUrl: string): Promise<DoctorCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: `invalid url: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const candidatePaths = parsed.hostname.includes("minio") ? ["/minio/health/live", "/"] : ["/"];
  for (const candidatePath of candidatePaths) {
    const candidate = new URL(rawUrl);
    candidate.pathname = candidatePath;
    candidate.search = "";
    try {
      const response = await requestHttp(candidate);
      if (response.statusCode >= 200 && response.statusCode < 500) {
        return {
          name,
          status: "pass",
          detail: `${candidate.toString()} responded with ${response.statusCode}`,
        };
      }
    } catch (error) {
      if (candidatePath === candidatePaths[candidatePaths.length - 1]) {
        return {
          name,
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  return {
    name,
    status: "fail",
    detail: `no successful response from ${rawUrl}`,
  };
}

async function requestHttp(target: URL): Promise<{ statusCode: number }> {
  const client = target.protocol === "https:" ? https : http;
  return new Promise<{ statusCode: number }>((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: "GET",
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        resolve({ statusCode: response.statusCode ?? 0 });
      },
    );
    request.once("timeout", () => {
      request.destroy(new Error(`timeout fetching ${target.toString()}`));
    });
    request.once("error", reject);
    request.end();
  });
}

function defaultPort(protocol: string): number | null {
  if (protocol === "redis:" || protocol === "rediss:") {
    return 6379;
  }
  if (protocol === "mqtt:" || protocol === "mqtts:") {
    return protocol === "mqtts:" ? 8883 : 1883;
  }
  if (protocol === "http:") {
    return 80;
  }
  if (protocol === "https:") {
    return 443;
  }
  return null;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
