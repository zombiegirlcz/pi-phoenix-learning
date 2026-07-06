/**
 * Phoenix Tracer Extension
 *
 * Captures every Pi agent call and sends traces to Arize Phoenix
 * for observability, monitoring, and debugging.
 *
 * Phoenix server: http://localhost:6006
 * Project: pi
 *
 * Uses Phoenix REST API (POST /v1/projects/{project}/spans)
 * to ingest spans with full OpenTelemetry-compatible identifiers.
 *
 * Stores rich context including prompts, assistant responses, and tool
 * I/O so the Phoenix Learner can analyze conversation quality.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// Configuration
// =============================================================================

const PHOENIX_HOST = process.env.PHOENIX_HOST || "http://localhost:6006";
const PHOENIX_PROJECT = process.env.PHOENIX_PROJECT || "pi";
const PHOENIX_API_KEY = process.env.PHOENIX_API_KEY || "";
const SPANS_ENDPOINT = `${PHOENIX_HOST}/v1/projects/${encodeURIComponent(PHOENIX_PROJECT)}/spans`;

// Max chars for attribute values (Phoenix has limits)
const MAX_ATTR_LENGTH = 5000;

// =============================================================================
// Helpers
// =============================================================================

function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

function isoNow(): string {
  return new Date().toISOString();
}

function truncate(s: string, max: number = MAX_ATTR_LENGTH): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (PHOENIX_API_KEY) headers["Authorization"] = `Bearer ${PHOENIX_API_KEY}`;
  return headers;
}

async function sendSpans(spans: any[]): Promise<void> {
  if (spans.length === 0) return;
  try {
    const response = await fetch(SPANS_ENDPOINT, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ data: spans }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`[phoenix-tracer] Send failed: ${response.status} ${body.slice(0, 200)}`);
    }
  } catch (error) {
    console.warn(`[phoenix-tracer] Error: ${error instanceof Error ? error.message : error}`);
  }
}

// =============================================================================
// State per agent invocation
// =============================================================================

interface ToolExecState {
  spanId: string;
  startTime: string;
  toolName: string;
  args: any;
}

interface TurnState {
  spanId: string;
  startTime: string;
  responseText: string;
  toolCallIds: string[];
}

interface AgentTraceState {
  traceId: string;
  rootSpanId: string;
  rootStartTime: string;
  turnCount: number;
  spans: any[];
  prompt: string;
  assistantResponse: string;
  toolExecutions: Map<string, ToolExecState>;
  turnStates: Map<number, TurnState>;
}

let currentTrace: AgentTraceState | null = null;

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ── before_agent_start ──────────────────────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const traceId = generateTraceId();
    const rootSpanId = generateSpanId();
    const now = isoNow();

    currentTrace = {
      traceId,
      rootSpanId,
      rootStartTime: now,
      turnCount: 0,
      spans: [],
      prompt: event.prompt ?? "",
      assistantResponse: "",
      toolExecutions: new Map(),
      turnStates: new Map(),
    };

    currentTrace.spans.push({
      name: "pi.agent",
      context: { trace_id: traceId, span_id: rootSpanId },
      span_kind: "CHAIN",
      parent_id: null,
      start_time: now,
      end_time: now,
      status_code: "OK",
      status_message: "",
      attributes: {
        "pi.prompt": truncate(event.prompt ?? "", 2000),
        "pi.model": _ctx.model?.id ?? "unknown",
        "pi.provider": _ctx.model?.provider ?? "unknown",
        "pi.total_tokens": 0,
        "pi.turn_count": 0,
        "openinference.span.type": "chain",
      },
      events: [],
    });
  });

  // ── turn_start ───────────────────────────────────────────────────────
  pi.on("turn_start", async (event, _ctx) => {
    if (!currentTrace) return;
    const trace = currentTrace;
    const turnIndex = event.turnIndex ?? trace.turnCount;
    const spanId = generateSpanId();
    const now = isoNow();

    trace.turnStates.set(turnIndex, {
      spanId,
      startTime: now,
      responseText: "",
      toolCallIds: [],
    });

    trace.spans.push({
      name: `pi.turn.${turnIndex}`,
      context: { trace_id: trace.traceId, span_id: spanId },
      span_kind: "LLM",
      parent_id: trace.rootSpanId,
      start_time: now,
      end_time: now,
      status_code: "OK",
      status_message: "",
      attributes: {
        "pi.turn_index": turnIndex,
        "pi.assistant_response": "",
        "openinference.span.type": "llm",
        "openinference.llm.invocation_parameters": JSON.stringify({
          model: _ctx.model?.id ?? "unknown",
          provider: _ctx.model?.provider ?? "unknown",
        }),
        "openinference.llm.token_count.prompt": 0,
        "openinference.llm.token_count.completion": 0,
        "openinference.llm.token_count.total": 0,
      },
      events: [],
    });
  });

  // ── message_end ─────────────────────────────────────────────────────
  // Capture assistant response text
  pi.on("message_end", async (event, _ctx) => {
    if (!currentTrace) return;
    if (event.message.role !== "assistant") return;

    const trace = currentTrace;
    const turnIndex = trace.turnCount;
    const turnState = trace.turnStates.get(turnIndex);
    if (!turnState) return;

    // Extract text content from the message
    const textParts = (event.message.content ?? [])
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join("\n");

    turnState.responseText = textParts;
    trace.assistantResponse += (trace.assistantResponse ? "\n\n" : "") + textParts;

    // Update the turn span with the response text
    const span = trace.spans.find((s) => s.context.span_id === turnState.spanId);
    if (span) {
      span.attributes["pi.assistant_response"] = truncate(textParts, 2000);
    }
  });

  // ── tool_execution_start ─────────────────────────────────────────────
  pi.on("tool_execution_start", async (event, _ctx) => {
    if (!currentTrace) return;
    const trace = currentTrace;
    const spanId = generateSpanId();
    const now = isoNow();

    trace.toolExecutions.set(event.toolCallId, {
      spanId,
      startTime: now,
      toolName: event.toolName,
      args: event.args,
    });

    const turnIndex = trace.turnCount;
    const turnState = trace.turnStates.get(turnIndex);
    if (turnState) turnState.toolCallIds.push(event.toolCallId);

    const parentSpanId = turnState?.spanId ?? trace.rootSpanId;

    trace.spans.push({
      name: `tool.${event.toolName}`,
      context: { trace_id: trace.traceId, span_id: spanId },
      span_kind: "TOOL",
      parent_id: parentSpanId,
      start_time: now,
      end_time: now,
      status_code: "OK",
      status_message: "",
      attributes: {
        "pi.tool_call_id": event.toolCallId,
        "pi.tool_name": event.toolName,
        "pi.tool_args": truncate(JSON.stringify(event.args ?? {}), 2000),
        "pi.tool_output": "",
        "openinference.span.type": "tool",
      },
      events: [],
    });
  });

  // ── tool_execution_end ───────────────────────────────────────────────
  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!currentTrace) return;
    const trace = currentTrace;
    const exec = trace.toolExecutions.get(event.toolCallId);
    if (!exec) return;

    const now = isoNow();
    const span = trace.spans.find((s) => s.context.span_id === exec.spanId);
    if (span) {
      span.end_time = now;

      const outputStr = typeof event.result === "string"
        ? event.result
        : JSON.stringify(event.result ?? {});

      span.attributes["pi.tool_output"] = truncate(outputStr, 3000);

      if (event.isError) {
        span.status_code = "ERROR";
        span.status_message = truncate(outputStr, 500);
      }
    }

    trace.toolExecutions.delete(event.toolCallId);
  });

  // ── turn_end ─────────────────────────────────────────────────────────
  pi.on("turn_end", async (event, _ctx) => {
    if (!currentTrace) return;
    const trace = currentTrace;
    const turnIndex = event.turnIndex ?? trace.turnCount;
    const turnState = trace.turnStates.get(turnIndex);

    if (turnState) {
      const now = isoNow();
      const span = trace.spans.find((s) => s.context.span_id === turnState.spanId);
      if (span) {
        span.end_time = now;
        const usage = event.message?.usage;
        if (usage) {
          span.attributes["openinference.llm.token_count.prompt"] = usage.input ?? 0;
          span.attributes["openinference.llm.token_count.completion"] = usage.output ?? 0;
          span.attributes["openinference.llm.token_count.total"] = (usage.input ?? 0) + (usage.output ?? 0);
        }
        if (usage?.cost?.total !== undefined) {
          span.attributes["openinference.llm.cost"] = usage.cost.total;
        }
      }
    }

    trace.turnCount = turnIndex + 1;
  });

  // ── agent_end ────────────────────────────────────────────────────────
  pi.on("agent_end", async (event, _ctx) => {
    if (!currentTrace) return;
    const trace = currentTrace;
    const now = isoNow();

    const rootSpan = trace.spans.find((s) => s.context.span_id === trace.rootSpanId);
    if (rootSpan) {
      rootSpan.end_time = now;
      rootSpan.attributes["pi.turn_count"] = trace.turnCount;
      rootSpan.attributes["pi.total_tokens"] = trace.spans
        .filter((s) => s.name.startsWith("pi.turn"))
        .reduce((sum: number, s: any) => {
          return sum + (s.attributes?.["openinference.llm.token_count.total"] ?? 0);
        }, 0);
    }

    const spansToSend = [...trace.spans];
    currentTrace = null;
    await sendSpans(spansToSend);
  });
}
