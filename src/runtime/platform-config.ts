import { readJsonFile } from "../core/fs-utils.js";

export interface SecretRef {
  source: "env";
  provider: string;
  id: string;
}

export interface ProviderModelDefinition {
  id: string;
  name: string;
  contextTokens: number;
}

export interface ProviderDefinition {
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseUrl: string;
  apiKey: SecretRef;
  models: ProviderModelDefinition[];
}

interface RawProviderDefinition {
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseUrl?: string;
  apiKey?: Partial<SecretRef>;
  apiKeyEnv?: string;
  models?: ProviderModelDefinition[];
}

export interface AgentModelSelection {
  primary: string;
  backups: string[];
}

export interface PlatformConfigDocument {
  agents: {
    defaults: {
      workspace?: string;
      model: AgentModelSelection;
    };
  };
  gateway?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  models: {
    mode?: string;
    providers: Record<string, ProviderDefinition>;
  };
}

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  config?: PlatformConfigDocument;
}

export interface ResolvedModelTarget {
  providerId: string;
  modelId: string;
  provider: ProviderDefinition;
  model: ProviderModelDefinition;
  secretEnvName: string;
}

export async function loadPlatformConfig(configPath: string): Promise<PlatformConfigDocument> {
  const raw = await readJsonFile<unknown>(configPath);
  return normalizePlatformConfig(raw);
}

export function validatePlatformConfig(raw: unknown): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["config root must be an object"], warnings };
  }

  const config = raw as Partial<PlatformConfigDocument>;
  const modelSelection = config.agents?.defaults?.model;
  if (!modelSelection || typeof modelSelection !== "object") {
    errors.push("agents.defaults.model is required");
  }

  const primary = modelSelection?.primary;
  if (typeof primary !== "string" || primary.length === 0) {
    errors.push("agents.defaults.model.primary must be a non-empty string");
  }

  const backupsValue = modelSelection && "backups" in modelSelection ? modelSelection.backups : [];
  if (!Array.isArray(backupsValue)) {
    errors.push("agents.defaults.model.backups must be an array");
  }
  const backups = Array.isArray(backupsValue) ? backupsValue : [];
  for (const [index, item] of backups.entries()) {
    if (typeof item !== "string" || item.length === 0) {
      errors.push(`agents.defaults.model.backups[${index}] must be a non-empty string`);
    }
  }

  const providers = config.models?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    errors.push("models.providers must be a non-empty object");
  }

  const providerMap = providers && typeof providers === "object" && !Array.isArray(providers) ? providers : {};
  const knownModelIds = new Set<string>();

  for (const [providerId, provider] of Object.entries(providerMap)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      errors.push(`models.providers.${providerId} must be an object`);
      continue;
    }

    const candidate = provider as RawProviderDefinition;
    const candidateApi = candidate.api;
    if (
      candidateApi !== "openai-completions" &&
      candidateApi !== "openai-responses" &&
      candidateApi !== "anthropic-messages"
    ) {
      errors.push(`models.providers.${providerId}.api is invalid`);
    }
    if (typeof candidate.baseUrl !== "string" || candidate.baseUrl.length === 0) {
      errors.push(`models.providers.${providerId}.baseUrl must be a non-empty string`);
    }
    const apiKeyEnvName = readProviderApiKeyEnvName(candidate);
    if (!apiKeyEnvName) {
      errors.push(`models.providers.${providerId}.apiKey or apiKeyEnv is required`);
    } else if (!process.env[apiKeyEnvName]) {
      warnings.push(`environment variable ${apiKeyEnvName} is not set`);
    }
    if (!Array.isArray(candidate.models) || candidate.models.length === 0) {
      errors.push(`models.providers.${providerId}.models must be a non-empty array`);
      continue;
    }

    for (const [index, model] of candidate.models.entries()) {
      if (!model || typeof model !== "object" || Array.isArray(model)) {
        errors.push(`models.providers.${providerId}.models[${index}] must be an object`);
        continue;
      }
      const modelCandidate = model as Partial<ProviderModelDefinition>;
      if (typeof modelCandidate.id !== "string" || modelCandidate.id.length === 0) {
        errors.push(`models.providers.${providerId}.models[${index}].id must be a non-empty string`);
        continue;
      }
      knownModelIds.add(`${providerId}/${modelCandidate.id}`);
      if (typeof modelCandidate.name !== "string" || modelCandidate.name.length === 0) {
        errors.push(`models.providers.${providerId}.models[${index}].name must be a non-empty string`);
      }
      if (typeof modelCandidate.contextTokens !== "number" || modelCandidate.contextTokens <= 0) {
        errors.push(`models.providers.${providerId}.models[${index}].contextTokens must be > 0`);
      }
    }
  }

  if (typeof primary === "string" && primary.length > 0 && !knownModelIds.has(primary)) {
    errors.push(`agents.defaults.model.primary references unknown model: ${primary}`);
  }
  for (const backup of backups) {
    if (!knownModelIds.has(backup)) {
      errors.push(`agents.defaults.model.backups references unknown model: ${backup}`);
    }
  }

  const result: ConfigValidationResult = {
    ok: errors.length === 0,
    errors,
    warnings,
  };
  if (errors.length === 0) {
    result.config = normalizePlatformConfig(raw);
  }
  return result;
}

export function resolveModelTargets(config: PlatformConfigDocument): ResolvedModelTarget[] {
  const selections = [config.agents.defaults.model.primary, ...config.agents.defaults.model.backups];
  return selections.map((selection) => resolveModelTarget(config, selection));
}

export function resolveModelTarget(config: PlatformConfigDocument, selection: string): ResolvedModelTarget {
  const slashIndex = selection.indexOf("/");
  if (slashIndex <= 0 || slashIndex === selection.length - 1) {
    throw new Error(`invalid model selection: ${selection}`);
  }

  const providerId = selection.slice(0, slashIndex);
  const modelId = selection.slice(slashIndex + 1);
  const provider = config.models.providers[providerId];
  if (!provider) {
    throw new Error(`unknown provider in model selection: ${selection}`);
  }

  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`unknown model in model selection: ${selection}`);
  }

  return {
    providerId,
    modelId,
    provider,
    model,
    secretEnvName: provider.apiKey.id,
  };
}

function normalizePlatformConfig(raw: unknown): PlatformConfigDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config root must be an object");
  }

  const config = raw as Partial<PlatformConfigDocument>;
  const providers = config.models?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("models.providers must be a non-empty object");
  }

  const normalizedProviders: Record<string, ProviderDefinition> = {};
  for (const [providerId, provider] of Object.entries(providers)) {
    const candidate = provider as RawProviderDefinition;
    const apiKeyEnvName = readProviderApiKeyEnvName(candidate);
    if (!apiKeyEnvName) {
      throw new Error(`models.providers.${providerId}.apiKey or apiKeyEnv is required`);
    }

    const normalizedProvider: ProviderDefinition = {
      api: candidate.api ?? "openai-completions",
      baseUrl: candidate.baseUrl ?? "",
      apiKey: {
        source: "env",
        provider: "default",
        id: apiKeyEnvName,
      },
      models: Array.isArray(candidate.models) ? candidate.models : [],
    };
    normalizedProviders[providerId] = normalizedProvider;
  }

  const normalizedConfig: PlatformConfigDocument = {
    agents: config.agents ?? {
      defaults: {
        model: {
          primary: "",
          backups: [],
        },
      },
    },
    models: {
      providers: normalizedProviders,
    },
  };
  if (config.gateway) {
    normalizedConfig.gateway = config.gateway;
  }
  if (config.memory) {
    normalizedConfig.memory = config.memory;
  }
  if (typeof config.models?.mode === "string") {
    normalizedConfig.models.mode = config.models.mode;
  }
  return normalizedConfig;
}

function readProviderApiKeyEnvName(provider: RawProviderDefinition): string | null {
  if (typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv.length > 0) {
    return provider.apiKeyEnv;
  }
  if (provider.apiKey && typeof provider.apiKey === "object" && typeof provider.apiKey.id === "string" && provider.apiKey.id.length > 0) {
    return provider.apiKey.id;
  }
  return null;
}
