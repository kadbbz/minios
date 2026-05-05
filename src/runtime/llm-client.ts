import path from "node:path";
import {
  loadPlatformConfig,
  resolveModelTargets,
  type PlatformConfigDocument,
  type ProviderDefinition,
  type ResolvedModelTarget,
} from "./platform-config.js";

export interface LlmTemplateFillInput {
  templateMarkdown: string;
  taskText: string;
}

export interface LlmTemplateFillResult {
  text: string;
  selectedModel: string;
  selectedModelName: string;
  triedModels: string[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  configSummary: {
    primary: string;
    backups: string[];
    providerApi: string;
    providerBaseUrl: string;
    apiKeyEnvName: string;
  };
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

export class LlmClient {
  async fillTemplate(input: LlmTemplateFillInput): Promise<LlmTemplateFillResult> {
    const configPath = path.resolve(
      process.env.MINIOS_LLM_CONFIG_PATH ??
        path.join(process.env.MINIOS_DATA_DIR ?? "/data/minios", "config", "llm.json"),
    );
    const config = await loadPlatformConfig(configPath);
    const targets = resolveModelTargets(config);
    const triedModels: string[] = [];
    let lastError: Error | undefined;

    for (const target of targets) {
      triedModels.push(`${target.providerId}/${target.modelId}`);
      try {
        const response = await this.invokeChatCompletion(target, input, config);
        return {
          text: response.text,
          selectedModel: `${target.providerId}/${target.modelId}`,
          selectedModelName: target.model.name,
          triedModels,
          usage: response.usage,
          configSummary: {
            primary: config.agents.defaults.model.primary,
            backups: config.agents.defaults.model.backups,
            providerApi: target.provider.api,
            providerBaseUrl: target.provider.baseUrl,
            apiKeyEnvName: target.secretEnvName,
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `all configured models failed: ${triedModels.join(", ")}${lastError ? ` | last error: ${lastError.message}` : ""}`,
    );
  }

  private async invokeChatCompletion(
    target: ResolvedModelTarget,
    input: LlmTemplateFillInput,
    config: PlatformConfigDocument,
  ): Promise<{
    text: string;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }> {
    if (target.provider.api !== "openai-completions") {
      throw new Error(`provider api not yet supported for template fill: ${target.provider.api}`);
    }

    const apiKey = process.env[target.secretEnvName];
    if (!apiKey || apiKey.length === 0) {
      throw new Error(`missing api key env: ${target.secretEnvName}`);
    }

    const response = await fetch(this.chatCompletionsUrl(target.provider), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: target.modelId,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: [
              "你是 MiniOS 中的 Agent 运行时。",
              "你的任务是读取 Markdown 模板，并基于当前真实运行配置填写模板。",
              "只返回填写完成的 Markdown，不要输出代码块，不要补充解释。",
            ].join("\n"),
          },
          {
            role: "user",
            content: buildTemplateFillPrompt(input, config, target),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`llm request failed with ${response.status}: ${errorText}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    const normalized = normalizeMessageContent(content);
    if (normalized.length === 0) {
      throw new Error(payload.error?.message ?? "llm response content is empty");
    }
    return {
      text: normalized,
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0,
      },
    };
  }

  private chatCompletionsUrl(provider: ProviderDefinition): string {
    return `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }
}

function normalizeMessageContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("")
    .trim();
}

function buildTemplateFillPrompt(
  input: LlmTemplateFillInput,
  config: PlatformConfigDocument,
  target: ResolvedModelTarget,
): string {
  return [
    "请填写下面这个 Markdown 模板。",
    "如果模板里有空白、占位符或待填字段，请用当前真实运行配置填入。",
    "请保留 Markdown 结构。",
    "",
    "当前运行配置：",
    `- primary: ${config.agents.defaults.model.primary}`,
    `- backups: ${config.agents.defaults.model.backups.length > 0 ? config.agents.defaults.model.backups.join(", ") : "(none)"}`,
    `- selected provider: ${target.providerId}`,
    `- selected model: ${target.modelId}`,
    `- provider api: ${target.provider.api}`,
    `- provider baseUrl: ${target.provider.baseUrl}`,
    `- api key env: ${target.secretEnvName}`,
    "",
    "用户任务：",
    input.taskText.length > 0 ? input.taskText : "请填写模板中的配置字段。",
    "",
    "Markdown 模板开始：",
    input.templateMarkdown,
    "Markdown 模板结束。",
  ].join("\n");
}
