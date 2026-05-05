import http from "node:http";
import { mkdirSync } from "node:fs";
import { bootstrapRuntimeEnv } from "../runtime/env-config.js";

interface GatewayConfig {
  port: number;
  host: string;
  nodeEnv: string;
  dataDir: string;
  rootDir: string;
  redisUrl: string;
  mqttUrl: string;
  mqttUsername: string;
  mqttPasswordSet: boolean;
  minioEndpoint: string;
  minioAccessKey: string;
  minioSecretKeySet: boolean;
  minioBucketIn: string;
  minioBucketOut: string;
}

function getEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : defaultValue;
}

function loadConfig(): GatewayConfig {
  return {
    port: Number(getEnv("MINIOS_PORT", "8080")),
    host: getEnv("MINIOS_HOST", "0.0.0.0"),
    nodeEnv: getEnv("NODE_ENV", "development"),
    dataDir: getEnv("MINIOS_DATA_DIR", "/data/minios"),
    rootDir: getEnv("MINIOS_ROOT_DIR", process.cwd()),
    redisUrl: getEnv("MINIOS_REDIS_URL", "redis://redis:6379/0"),
    mqttUrl: getEnv("MINIOS_MQTT_URL", "mqtt://emqx:1883"),
    mqttUsername: getEnv("MINIOS_MQTT_USERNAME", "minios"),
    mqttPasswordSet: Boolean(process.env.MINIOS_MQTT_PASSWORD),
    minioEndpoint: getEnv("MINIOS_S3_ENDPOINT", "http://minio:9000"),
    minioAccessKey: getEnv("MINIOS_S3_ACCESS_KEY", "miniosadmin"),
    minioSecretKeySet: Boolean(process.env.MINIOS_S3_SECRET_KEY),
    minioBucketIn: getEnv("MINIOS_S3_BUCKET_IN", "agents-in"),
    minioBucketOut: getEnv("MINIOS_S3_BUCKET_OUT", "agents-out"),
  };
}

function createServer(config: GatewayConfig): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return writeJson(response, 200, {
        ok: true,
        service: "minios-gateway",
        time: new Date().toISOString(),
      });
    }

    if (request.method === "GET" && url.pathname === "/readyz") {
      return writeJson(response, 200, {
        ok: true,
        service: "minios-gateway",
        config: redactConfig(config),
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return writeJson(response, 200, {
        ok: true,
        service: "minios-gateway",
        message: "MiniOS gateway is running",
        endpoints: ["/healthz", "/readyz"],
      });
    }

    return writeJson(response, 404, {
      ok: false,
      error: "not found",
      path: url.pathname,
    });
  });
}

function redactConfig(config: GatewayConfig): Record<string, unknown> {
  return {
    port: config.port,
    host: config.host,
    nodeEnv: config.nodeEnv,
    dataDir: config.dataDir,
    rootDir: config.rootDir,
    redisUrl: config.redisUrl,
    mqttUrl: config.mqttUrl,
    mqttUsername: config.mqttUsername,
    mqttPasswordSet: config.mqttPasswordSet,
    minioEndpoint: config.minioEndpoint,
    minioAccessKey: config.minioAccessKey,
    minioSecretKeySet: config.minioSecretKeySet,
    minioBucketIn: config.minioBucketIn,
    minioBucketOut: config.minioBucketOut,
  };
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main(): Promise<void> {
  await bootstrapRuntimeEnv();
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const server = createServer(config);

  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `${JSON.stringify(
        {
          level: "info",
          service: "minios-gateway",
          event: "startup",
          config: redactConfig(config),
        },
        null,
        2,
      )}\n`,
    );
  });
}

void main();
