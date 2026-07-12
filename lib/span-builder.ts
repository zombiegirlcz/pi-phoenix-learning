/**
 * Shared span building utilities for Phoenix tracing.
 * Abstracts OpenTelemetry span creation for both Pi and Copilot.
 */

import { randomBytes } from "node:crypto";

const MAX_ATTR_LENGTH = 5000;

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function truncate(s: string | null | undefined, max: number = MAX_ATTR_LENGTH): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

export interface SpanContext {
  trace_id: string;
  span_id: string;
}

export interface PhoenixSpan {
  name: string;
  context: SpanContext;
  span_kind: "CHAIN" | "LLM" | "TOOL" | "OTHER";
  parent_id: string | null;
  start_time: string;
  end_time: string;
  status_code: "OK" | "ERROR";
  status_message: string;
  attributes: Record<string, any>;
  events: any[];
}

/**
 * Create root span for agent invocation (CHAIN type)
 */
export function createRootSpan(
  traceId: string,
  rootSpanId: string,
  prompt: string,
  model: { id?: string; provider?: string } | null,
): PhoenixSpan {
  const now = isoNow();
  return {
    name: "agent",
    context: { trace_id: traceId, span_id: rootSpanId },
    span_kind: "CHAIN",
    parent_id: null,
    start_time: now,
    end_time: now,
    status_code: "OK",
    status_message: "",
    attributes: {
      "agent.prompt": truncate(prompt, 2000),
      "agent.model": model?.id ?? "unknown",
      "agent.provider": model?.provider ?? "unknown",
      "agent.total_tokens": 0,
      "agent.turn_count": 0,
      "openinference.span.type": "chain",
    },
    events: [],
  };
}

/**
 * Create LLM turn span
 */
export function createTurnSpan(
  traceId: string,
  spanId: string,
  rootSpanId: string,
  turnIndex: number,
  model: { id?: string; provider?: string } | null,
): PhoenixSpan {
  const now = isoNow();
  return {
    name: `turn.${turnIndex}`,
    context: { trace_id: traceId, span_id: spanId },
    span_kind: "LLM",
    parent_id: rootSpanId,
    start_time: now,
    end_time: now,
    status_code: "OK",
    status_message: "",
    attributes: {
      "agent.turn_index": turnIndex,
      "agent.assistant_response": "",
      "openinference.span.type": "llm",
      "openinference.llm.invocation_parameters": JSON.stringify({
        model: model?.id ?? "unknown",
        provider: model?.provider ?? "unknown",
      }),
      "openinference.llm.token_count.prompt": 0,
      "openinference.llm.token_count.completion": 0,
      "openinference.llm.token_count.total": 0,
    },
    events: [],
  };
}

/**
 * Create tool execution span
 */
export function createToolSpan(
  traceId: string,
  spanId: string,
  parentSpanId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: any,
): PhoenixSpan {
  const now = isoNow();
  return {
    name: `tool.${toolName}`,
    context: { trace_id: traceId, span_id: spanId },
    span_kind: "TOOL",
    parent_id: parentSpanId,
    start_time: now,
    end_time: now,
    status_code: "OK",
    status_message: "",
    attributes: {
      "agent.tool_call_id": toolCallId,
      "agent.tool_name": toolName,
      "agent.tool_args": truncate(JSON.stringify(toolArgs ?? {}), 2000),
      "agent.tool_output": "",
      "openinference.span.type": "tool",
    },
    events: [],
  };
}
