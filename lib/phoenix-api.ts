/**
 * Phoenix API utilities for sending and fetching spans.
 * Supports multiple projects (pi, copilot, etc.).
 */

import type { PhoenixSpan } from "./span-builder.js";

export interface PhoenixConfig {
  host: string;
  project: string;
  apiKey?: string;
}

/**
 * Build Phoenix config from environment variables.
 * @param projectOverride - if provided, overrides PHOENIX_PROJECT env var
 */
export function getPhoenixConfig(projectOverride?: string): PhoenixConfig {
  return {
    host: process.env.PHOENIX_HOST || "http://localhost:6006",
    project: projectOverride || process.env.PHOENIX_PROJECT || "pi",
    apiKey: process.env.PHOENIX_API_KEY || undefined,
  };
}

function apiHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Send spans to Phoenix
 */
export async function sendSpans(
  spans: PhoenixSpan[],
  config: PhoenixConfig,
): Promise<{ success: boolean; error?: string }> {
  if (spans.length === 0) return { success: true };

  const endpoint = `${config.host}/v1/projects/${encodeURIComponent(config.project)}/spans`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: apiHeaders(config.apiKey),
      body: JSON.stringify({ data: spans }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = `Phoenix send failed: ${response.status} ${body.slice(0, 200)}`;
      console.warn(`[phoenix-api] ${error}`);
      return { success: false, error };
    }

    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[phoenix-api] Error sending spans: ${msg}`);
    return { success: false, error: msg };
  }
}

export interface PhoenixSpanResponse {
  name: string;
  context: { trace_id: string; span_id: string };
  span_kind: string;
  parent_id: string | null;
  start_time: string;
  end_time: string;
  status_code: string;
  status_message: string;
  attributes: Record<string, any>;
}

/**
 * Fetch spans from Phoenix for a project
 */
export async function fetchSpans(
  config: PhoenixConfig,
): Promise<{ spans: PhoenixSpanResponse[]; error?: string }> {
  const endpoint = `${config.host}/v1/projects/${encodeURIComponent(config.project)}/spans`;

  try {
    const response = await fetch(endpoint, {
      headers: apiHeaders(config.apiKey),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      console.warn(`[phoenix-api] Fetch failed: ${response.status}`);
      return { spans: [] };
    }

    const data = (await response.json()) as { data?: PhoenixSpanResponse[] };
    return { spans: data.data ?? [] };
  } catch (error) {
    console.warn(
      `[phoenix-api] Fetch error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { spans: [] };
  }
}

/**
 * Health check for Phoenix server
 */
export async function checkPhoenixHealth(host: string): Promise<boolean> {
  try {
    const response = await fetch(`${host}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
