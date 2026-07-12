/**
 * Lesson analysis utilities for extracting learning opportunities from conversations.
 * Analyzes transcripts using LLM to identify mistakes and extract actionable lessons.
 */

import type { PhoenixSpanResponse } from "./phoenix-api.js";
import type { LessonCategory } from "./lesson-storage.js";
import { callLLMForAnalysis, type Model } from "./llm-provider.js";

export interface ConversationTurn {
  turnIndex: number;
  prompt: string;
  assistantResponse: string;
  toolCalls: Array<{
    toolName: string;
    args: any;
    output: string;
    isError: boolean;
  }>;
  tokenCount: number;
}

export interface ConversationAnalysis {
  traceId: string;
  turns: ConversationTurn[];
  fullTranscript: string;
}

/**
 * Build conversation transcript from spans
 */
export function buildConversation(spans: PhoenixSpanResponse[]): ConversationAnalysis | null {
  const rootSpan = spans.find((s) => s.span_kind === "CHAIN");
  if (!rootSpan) return null;

  const traceId = rootSpan.context.trace_id;
  const prompt = rootSpan.attributes?.["agent.prompt"] ?? "";

  const turnSpans = spans
    .filter((s) => s.name.startsWith("turn"))
    .sort(
      (a, b) =>
        (a.attributes?.["agent.turn_index"] ?? 0) -
        (b.attributes?.["agent.turn_index"] ?? 0),
    );

  const toolSpans = spans.filter((s) => s.span_kind === "TOOL");

  const turns: ConversationTurn[] = [];

  for (const ts of turnSpans) {
    const turnIndex = ts.attributes?.["agent.turn_index"] ?? 0;
    const toolCalls = toolSpans
      .filter((tool) => tool.parent_id === ts.context.span_id)
      .map((tool) => ({
        toolName: tool.attributes?.["agent.tool_name"] ?? "unknown",
        args: (() => {
          try {
            return JSON.parse(tool.attributes?.["agent.tool_args"] ?? "{}");
          } catch {
            return {};
          }
        })(),
        output: tool.attributes?.["agent.tool_output"] ?? "",
        isError: tool.status_code === "ERROR",
      }));

    turns.push({
      turnIndex,
      prompt: turnIndex === 0 ? prompt : "[continuation]",
      assistantResponse: ts.attributes?.["agent.assistant_response"] ?? "",
      toolCalls,
      tokenCount: ts.attributes?.["openinference.llm.token_count.total"] ?? 0,
    });
  }

  // Build full transcript
  const lines: string[] = [`## Conversation (trace: ${traceId.slice(0, 12)}...)`];
  lines.push(`**Task:** ${prompt}`);
  lines.push("");

  for (const turn of turns) {
    if (turn.assistantResponse) {
      lines.push(`### Turn ${turn.turnIndex} — Response:`);
      lines.push(turn.assistantResponse.slice(0, 2000));
      lines.push("");
    }
    for (const tc of turn.toolCalls) {
      const status = tc.isError ? " ❌ ERROR" : "";
      lines.push(`Tool: ${tc.toolName}${status}`);
      lines.push(`  Args: ${JSON.stringify(tc.args).slice(0, 500)}`);
      lines.push(`  Output: ${tc.output.slice(0, 1000)}`);
      lines.push("");
    }
  }

  return { traceId, turns, fullTranscript: lines.join("\n") };
}

export interface ExtractedLesson {
  category: LessonCategory;
  summary: string;
  detail: string;
}

/**
 * Parse LLM analysis response to extract lessons
 */
export function parseLessonResponse(response: string): ExtractedLesson[] {
  const lessons: ExtractedLesson[] = [];

  // Look for JSON blocks in the response
  const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.category && item.summary) {
            lessons.push({
              category: (item.category as LessonCategory) || "other",
              summary: String(item.summary).slice(0, 200),
              detail: String(item.detail || "").slice(0, 1000),
            });
          }
        }
      }
    } catch {
      // JSON parsing failed, skip
    }
  }

  return lessons;
}

/**
 * Analyze conversation to extract lessons
 */
export async function analyzeConversationForLessons(
  conversation: ConversationAnalysis,
  model: Model | null | undefined,
): Promise<ExtractedLesson[]> {
  const systemPrompt = `You are an AI coach helping agents improve. Analyze the conversation and identify up to 5 specific, actionable mistakes the agent made.

Respond with a JSON array of lessons in this format:
\`\`\`json
[
  {
    "category": "task_misunderstanding|context_loss|incomplete_info|verification_failure|tool_misuse|premature_conclusion|chain_error|instruction_ignored|other",
    "summary": "Brief lesson (max 100 chars): e.g., 'Always verify file paths before writing'",
    "detail": "Full context with example from conversation (max 500 chars)"
  }
]
\`\`\`

Focus on:
- Misunderstanding what the user asked
- Forgetting context from earlier in conversation
- Making assumptions without checking
- Not testing or verifying results
- Using tools incorrectly (wrong args, wrong flags)
- Stopping too early without enough information
- Cascading errors from earlier mistakes
- Ignoring explicit instructions

Only include CLEAR MISTAKES you can evidence from the conversation.`;

  const userPrompt = `Analyze this conversation:\n\n${conversation.fullTranscript}`;

  const response = await callLLMForAnalysis(
    {
      prompt: userPrompt,
      systemPrompt,
      maxTokens: 2000,
    },
    model,
  );

  if (!response) {
    return [];
  }

  return parseLessonResponse(response.text);
}

/**
 * Check for obvious heuristic errors in spans (before LLM analysis)
 */
export function findHeuristicErrors(spans: PhoenixSpanResponse[]): ExtractedLesson[] {
  const lessons: ExtractedLesson[] = [];

  // Check for tool errors
  const toolSpans = spans.filter((s) => s.span_kind === "TOOL");
  for (const span of toolSpans) {
    if (span.status_code === "ERROR") {
      const toolName = span.attributes?.["agent.tool_name"] ?? "unknown";
      const errorMsg = span.status_message || span.attributes?.["agent.tool_output"] || "";
      lessons.push({
        category: "tool_misuse",
        summary: `Tool ${toolName} failed — check arguments`,
        detail: `${toolName} returned error: ${errorMsg.slice(0, 300)}`,
      });
    }
  }

  // Check for incomplete tool outputs
  const emptyToolOutputs = toolSpans.filter(
    (s) =>
      !s.attributes?.["agent.tool_output"] ||
      s.attributes["agent.tool_output"].length === 0,
  );
  if (emptyToolOutputs.length > 0) {
    lessons.push({
      category: "incomplete_info",
      summary: "Some tools returned empty results — may need validation",
      detail: `${emptyToolOutputs.length} tool calls had no output`,
    });
  }

  return lessons;
}
