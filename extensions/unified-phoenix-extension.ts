/**
 * Unified Phoenix Extension for Pi and Copilot
 *
 * Provides observability and self-learning for both Pi and Copilot agents.
 * Traces every interaction to Phoenix, analyzes for mistakes, and stores lessons
 * to prevent repeated errors and improve future performance.
 *
 * Environment variables:
 * - PHOENIX_HOST (default: http://localhost:6006)
 * - PHOENIX_PROJECT (default: pi)
 * - PI_LESSONS_PATH (override ~/.pi/agent/pi-lessons.json)
 * - COPILOT_LESSONS_PATH (override ~/.copilot/copilot-lessons.json)
 * - COPILOT_PHOENIX_PROJECT (default: copilot)
 * - PHOENIX_API_KEY (optional)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  generateTraceId,
  generateSpanId,
  isoNow,
  truncate,
  createRootSpan,
  createTurnSpan,
  createToolSpan,
  type PhoenixSpan,
} from "../lib/span-builder.js";
import {
  getPhoenixConfig,
  sendSpans,
  fetchSpans,
  type PhoenixConfig,
} from "../lib/phoenix-api.js";
import {
  getLessonsPath,
  loadLessons,
  saveLessons,
  upsertLesson,
  getTopLessons,
  formatLessonsForPrompt,
  type Lesson,
} from "../lib/lesson-storage.js";
import {
  buildConversation,
  analyzeConversationForLessons,
  findHeuristicErrors,
} from "../lib/lesson-analyzer.js";

// Configuration
const AGENT_TYPE = "pi";
const PI_PHOENIX_PROJECT = process.env.PHOENIX_PROJECT || "pi";

let phoenixConfig: PhoenixConfig;
let lessonsPath: string;

function initConfig() {
  phoenixConfig = getPhoenixConfig(PI_PHOENIX_PROJECT);
  lessonsPath = getLessonsPath("pi", process.env.PI_LESSONS_PATH);
  console.log(`[phoenix-unified] Initialized for ${AGENT_TYPE} (project: ${phoenixConfig.project})`);
}

// Tracer State
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
  spans: PhoenixSpan[];
  prompt: string;
  assistantResponse: string;
  toolExecutions: Map<string, ToolExecState>;
  turnStates: Map<number, TurnState>;
}

let currentTrace: AgentTraceState | null = null;

function initTraceForAgent(event: any, ctx: any) {
  const traceId = generateTraceId();
  const rootSpanId = generateSpanId();

  currentTrace = {
    traceId,
    rootSpanId,
    rootStartTime: isoNow(),
    turnCount: 0,
    spans: [],
    prompt: event.prompt ?? "",
    assistantResponse: "",
    toolExecutions: new Map(),
    turnStates: new Map(),
  };

  const rootSpan = createRootSpan(traceId, rootSpanId, event.prompt ?? "", {
    id: ctx?.model?.id,
    provider: ctx?.model?.provider,
  });
  rootSpan.name = `${AGENT_TYPE}.agent`;
  Object.keys(rootSpan.attributes).forEach((key: string) => {
    if (key.startsWith("agent.")) {
      const newKey = `${AGENT_TYPE}.${key.slice(6)}`;
      rootSpan.attributes[newKey] = rootSpan.attributes[key];
      delete rootSpan.attributes[key];
    }
  });
  currentTrace.spans.push(rootSpan);
}

function handleTurnStart(event: any, ctx: any) {
  if (!currentTrace) return;
  const trace = currentTrace;
  const turnIndex = event.turnIndex ?? trace.turnCount;
  const spanId = generateSpanId();

  trace.turnStates.set(turnIndex, {
    spanId,
    startTime: isoNow(),
    responseText: "",
    toolCallIds: [],
  });

  const turnSpan = createTurnSpan(trace.traceId, spanId, trace.rootSpanId, turnIndex, {
    id: ctx?.model?.id,
    provider: ctx?.model?.provider,
  });
  turnSpan.name = `${AGENT_TYPE}.turn.${turnIndex}`;
  Object.keys(turnSpan.attributes).forEach((key: string) => {
    if (key.startsWith("agent.")) {
      const newKey = `${AGENT_TYPE}.${key.slice(6)}`;
      turnSpan.attributes[newKey] = turnSpan.attributes[key];
      delete turnSpan.attributes[key];
    }
  });
  trace.spans.push(turnSpan);
}

function handleMessageEnd(event: any) {
  if (!currentTrace) return;
  if (event.message?.role !== "assistant") return;

  const trace = currentTrace;
  const turnIndex = trace.turnCount;
  const turnState = trace.turnStates.get(turnIndex);
  if (!turnState) return;

  const textParts = (event.message.content ?? [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text ?? "")
    .join("\n");

  turnState.responseText = textParts;
  trace.assistantResponse += (trace.assistantResponse ? "\n\n" : "") + textParts;

  const span = trace.spans.find((s) => s.context.span_id === turnState.spanId);
  if (span) {
    const attrKey = `${AGENT_TYPE}.assistant_response`;
    span.attributes[attrKey] = truncate(textParts, 2000);
  }
}

function handleToolExecutionStart(event: any) {
  if (!currentTrace) return;
  const trace = currentTrace;
  const spanId = generateSpanId();

  trace.toolExecutions.set(event.toolCallId, {
    spanId,
    startTime: isoNow(),
    toolName: event.toolName,
    args: event.args,
  });

  const turnIndex = trace.turnCount;
  const turnState = trace.turnStates.get(turnIndex);
  if (turnState) turnState.toolCallIds.push(event.toolCallId);

  const parentSpanId = turnState?.spanId ?? trace.rootSpanId;

  const toolSpan = createToolSpan(
    trace.traceId,
    spanId,
    parentSpanId,
    event.toolCallId,
    event.toolName,
    event.args,
  );
  toolSpan.name = `${AGENT_TYPE}.tool.${event.toolName}`;
  Object.keys(toolSpan.attributes).forEach((key: string) => {
    if (key.startsWith("agent.")) {
      const newKey = `${AGENT_TYPE}.${key.slice(6)}`;
      toolSpan.attributes[newKey] = toolSpan.attributes[key];
      delete toolSpan.attributes[key];
    }
  });
  trace.spans.push(toolSpan);
}

function handleToolExecutionEnd(event: any) {
  if (!currentTrace) return;
  const trace = currentTrace;
  const exec = trace.toolExecutions.get(event.toolCallId);
  if (!exec) return;

  const now = isoNow();
  const span = trace.spans.find((s) => s.context.span_id === exec.spanId);
  if (span) {
    span.end_time = now;
    const outputStr = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? {});
    const attrKey = `${AGENT_TYPE}.tool_output`;
    span.attributes[attrKey] = truncate(outputStr, 3000);
    if (event.isError) {
      span.status_code = "ERROR";
      span.status_message = truncate(outputStr, 500);
    }
  }
  trace.toolExecutions.delete(event.toolCallId);
}

function handleTurnEnd(event: any) {
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
}

async function handleAgentEnd(event: any, ctx: any) {
  if (!currentTrace) return;
  const trace = currentTrace;
  const now = isoNow();

  const rootSpan = trace.spans.find((s) => s.context.span_id === trace.rootSpanId);
  if (rootSpan) {
    rootSpan.end_time = now;
    rootSpan.attributes[`${AGENT_TYPE}.turn_count`] = trace.turnCount;
    rootSpan.attributes[`${AGENT_TYPE}.total_tokens`] = trace.spans
      .filter((s) => s.name.startsWith(`${AGENT_TYPE}.turn`))
      .reduce((sum: number, s: any) => sum + (s.attributes?.["openinference.llm.token_count.total"] ?? 0), 0);
  }

  const spansToSend = [...trace.spans];
  currentTrace = null;

  const sendResult = await sendSpans(spansToSend, phoenixConfig);
  if (!sendResult.success) {
    console.warn(`[phoenix-unified] Failed to send spans: ${sendResult.error}`);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
  await analyzeLessonsAndUpdate(ctx);
}

async function analyzeLessonsAndUpdate(ctx: any) {
  const result = await fetchSpans(phoenixConfig);
  if (result.spans.length === 0) {
    console.warn("[phoenix-unified] No spans found in Phoenix for analysis");
    return;
  }

  const conversation = buildConversation(result.spans);
  if (!conversation) {
    console.warn("[phoenix-unified] Could not build conversation from spans");
    return;
  }

  const heuristicLessons = findHeuristicErrors(result.spans);
  const llmLessons = await analyzeConversationForLessons(conversation, ctx?.model);
  const allLessons = [...heuristicLessons, ...llmLessons];

  let storedLessons = loadLessons(lessonsPath);
  for (const lesson of allLessons) {
    storedLessons = upsertLesson(
      storedLessons,
      lesson.category,
      lesson.summary,
      lesson.detail,
      conversation.traceId,
    );
  }

  if (saveLessons(storedLessons, lessonsPath)) {
    const topLessons = getTopLessons(storedLessons, 8);
    console.log(`[phoenix-unified] Extracted ${allLessons.length} lessons. Top reminders:`);
    topLessons.forEach((l: Lesson) => console.log(`  - ${l.summary}`));
  }
}

export default function initExtension(pi: ExtensionAPI) {
  initConfig();

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const lessons = loadLessons(lessonsPath);
    const topLessons = getTopLessons(lessons, 8);
    const lessonPrompt = formatLessonsForPrompt(topLessons);
    if (lessonPrompt && event.systemPrompt) {
      event.systemPrompt = `${event.systemPrompt}\n\n${lessonPrompt}`;
    }
    initTraceForAgent(event, ctx);
  });

  pi.on("turn_start", async (event: any, ctx: any) => {
    handleTurnStart(event, ctx);
  });

  pi.on("message_end", async (event: any) => {
    handleMessageEnd(event);
  });

  pi.on("tool_execution_start", async (event: any) => {
    handleToolExecutionStart(event);
  });

  pi.on("tool_execution_end", async (event: any) => {
    handleToolExecutionEnd(event);
  });

  pi.on("turn_end", async (event: any) => {
    handleTurnEnd(event);
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    await handleAgentEnd(event, ctx);
  });
}
