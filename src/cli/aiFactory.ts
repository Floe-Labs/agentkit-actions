export type AIProviderType = "openai" | "claude" | "ollama";

export interface AIConfig {
  provider: AIProviderType;
  apiKey?: string;
  model?: string;
  ollamaBaseUrl?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createAIModel(config: AIConfig): Promise<any> {
  switch (config.provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "OpenAI API key required. Set OPENAI_API_KEY env var or provide via prompt."
        );
      }
      const openai = createOpenAI({ apiKey });
      return openai(config.model || "gpt-4o");
    }
    case "claude": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "Anthropic API key required. Set ANTHROPIC_API_KEY env var or provide via prompt."
        );
      }
      const anthropic = createAnthropic({ apiKey });
      return anthropic(config.model || "claude-sonnet-4-5-20250514");
    }
    case "ollama": {
      try {
        const { createOllama } = await import("ai-sdk-ollama");
        const ollama = createOllama({
          baseURL: config.ollamaBaseUrl || "http://localhost:11434/api",
        });
        return ollama(config.model || "llama3.1");
      } catch {
        throw new Error(
          "Ollama provider not available. Install it with: npm install ollama-ai-provider"
        );
      }
    }
  }
}

export async function validateOllamaConnection(
  baseUrl: string
): Promise<boolean> {
  try {
    const url = baseUrl.replace(/\/api\/?$/, "") + "/api/tags";
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}
