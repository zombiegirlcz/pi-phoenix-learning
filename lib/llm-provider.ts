/**
 * Provider-agnostic LLM caller for lesson analysis.
 * Routes to correct provider based on model configuration.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Model {
  id?: string;
  provider?: string;
}

interface LLMConfig {
  baseUrl: string;
  modelId: string;
  apiKey: string | null;
}

/**
 * Resolve LLM config from model and environment
 */
export function resolveLLMConfig(model: Model | null | undefined): LLMConfig {
  const provider = model?.provider ?? "";
  const modelId = model?.id ?? "";

  let baseUrl = "https://opencode.ai/zen/v1";
  let apiKey: string | null = null;

  // Try to read auth.json from Pi's agent directory
  let auth: Record<string, any> = {};
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (existsSync(authPath)) {
      auth = JSON.parse(readFileSync(authPath, "utf-8"));
    }
  } catch {}

  // Route by provider
  if (!provider) {
    // No provider — try env vars in order
    apiKey =
      process.env.OPENAI_API_KEY ??
      process.env.ANTHROPIC_API_KEY ??
      process.env.OPENCODE_API_KEY ??
      null;
    if (process.env.OPENAI_BASE_URL) {
      baseUrl = process.env.OPENAI_BASE_URL;
    }
  } else if (provider === "opencode" || provider === "opencode-go") {
    baseUrl = "https://opencode.ai/zen/v1";
    apiKey = auth.opencode?.access ?? process.env.OPENCODE_API_KEY ?? null;
  } else if (provider === "anthropic") {
    baseUrl = "https://api.anthropic.com/v1";
    apiKey =
      auth.anthropic?.access ??
      process.env.ANTHROPIC_API_KEY ??
      auth.anthropic?.apiKey ??
      null;
  } else if (provider === "openai") {
    baseUrl = "https://api.openai.com/v1";
    apiKey = auth.openai?.access ?? process.env.OPENAI_API_KEY ?? null;
  } else if (provider === "google") {
    baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    apiKey = auth.google?.access ?? process.env.GOOGLE_API_KEY ?? null;
  } else if (provider === "ollama") {
    baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
    apiKey = null; // Ollama typically doesn't need auth
  } else {
    // Fallback: assume OpenAI-compatible endpoint
    baseUrl =
      process.env.OPENAI_BASE_URL ?? process.env.LLM_BASE_URL ?? baseUrl;
    apiKey =
      process.env.OPENAI_API_KEY ??
      process.env.LLM_API_KEY ??
      process.env.OPENCODE_API_KEY ??
      null;
  }

  return { baseUrl, modelId, apiKey };
}

export interface LLMAnalysisRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
}

export interface LLMAnalysisResponse {
  text: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Call LLM for lesson analysis
 * Supports OpenAI-compatible endpoints (Anthropic, OpenCode, etc.)
 */
export async function callLLMForAnalysis(
  request: LLMAnalysisRequest,
  model: Model | null | undefined,
): Promise<LLMAnalysisResponse | null> {
  const config = resolveLLMConfig(model);

  if (!config.apiKey) {
    console.warn(
      "[llm-provider] No API key found for LLM analysis. Skipping lesson analysis.",
    );
    return null;
  }

  if (!config.modelId) {
    console.warn("[llm-provider] No model ID configured for LLM analysis.");
    return null;
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [
          ...(request.systemPrompt
            ? [{ role: "system", content: request.systemPrompt }]
            : []),
          { role: "user", content: request.prompt },
        ],
        temperature: 0.7,
        max_tokens: request.maxTokens ?? 2000,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        `[llm-provider] LLM call failed: ${response.status} ${body.slice(0, 200)}`,
      );
      return null;
    }

    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content ?? "";
    const usage = data?.usage;

    return {
      text: content,
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
          }
        : undefined,
    };
  } catch (error) {
    console.warn(
      `[llm-provider] Error calling LLM: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
