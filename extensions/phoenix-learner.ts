/**
 * Phoenix Learner Extension
 *
 * Reads traces from Phoenix, analyzes conversation quality using LLM,
 * identifies mistakes (task misunderstanding, context loss, incomplete
 * work, etc.), and stores lessons in pi's global memory so future
 * agent calls know what to watch out for.
 *
 * How it works:
 * 1. After each agent_end, fetches spans from Phoenix for the last trace
 * 2. Builds a conversation transcript from span attributes
 * 3. Sends transcript to LLM (user's current model) for behavioral analysis
 * 4. Extracts structured lessons and stores in ~/.pi/agent/pi-lessons.json
 * 5. Before each agent_start, injects relevant lessons into system prompt
 *
 * Commands:
 *   /lessons        – zobrazí všechny uložené lessons
 *   /learn          – ručně spustí analýzu posledních traceů
 *   /forget-lesson  – smaže lesson (podle ID nebo --all)
 *   /review         – analyzuje poslední konverzaci z aktuální session
 *
 * Provider-agnostic: používá model, který má uživatel právě aktivní v pi.
 */

import type { ExtensionAPI, Model } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// =============================================================================
// Configuration
// =============================================================================

const PHOENIX_HOST = process.env.PHOENIX_HOST || "http://localhost:6006";
const PHOENIX_PROJECT = process.env.PHOENIX_PROJECT || "pi";
const MAX_LESSONS = 50;
const MAX_LESSONS_IN_PROMPT = 8;

// =============================================================================
// Lesson Storage
// =============================================================================

type LessonCategory =
  | "task_misunderstanding"   // nepochopení úkolu, dělá něco jiného
  | "context_loss"            // ztráta kontextu v průběhu konverzace
  | "incomplete_info"         // neúplné zjištění informací, dělá domněnky
  | "verification_failure"    // neověřuje výsledky, nevaliduje
  | "tool_misuse"             // špatné použití nástrojů
  | "premature_conclusion"    // předčasný závěr bez dostatku dat
  | "chain_error"             // řetězení chyb
  | "instruction_ignored"     // ignorování instrukcí
  | "other";

interface Lesson {
  id: string;
  timestamp: string;
  category: LessonCategory;
  summary: string;            // krátká rada: "Vždy ověř cestu před zápisem"
  detail: string;             // kontext: "Při čtení /etc/hostname ..."
  trace_id: string;
  count: number;
  last_seen: string;
}

const LESSONS_PATH = join(homedir(), ".pi", "agent", "pi-lessons.json");

function ensureDir(path: string): void {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function loadLessons(): Lesson[] {
  try {
    if (existsSync(LESSONS_PATH)) {
      return JSON.parse(readFileSync(LESSONS_PATH, "utf-8")) as Lesson[];
    }
  } catch (e) {
    console.warn("[phoenix-learner] Failed to load lessons:", e);
  }
  return [];
}

function saveLessons(lessons: Lesson[]): void {
  try {
    ensureDir(LESSONS_PATH);
    writeFileSync(LESSONS_PATH, JSON.stringify(lessons, null, 2), "utf-8");
  } catch (e) {
    console.warn("[phoenix-learner] Failed to save lessons:", e);
  }
}

function lessonFingerprint(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[.,!?;:'"()]/g, "")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function findMatchingLesson(lessons: Lesson[], summary: string): Lesson | undefined {
  const fp = lessonFingerprint(summary);
  return lessons.find((l) => {
    const lfp = lessonFingerprint(l.summary);
    if (lfp === fp) return true;
    if (lfp.includes(fp) || fp.includes(lfp)) return true;
    return false;
  });
}

function upsertLesson(
  lessons: Lesson[],
  category: LessonCategory,
  summary: string,
  detail: string,
  trace_id: string,
): Lesson[] {
  const now = new Date().toISOString();
  const existing = findMatchingLesson(lessons, summary);

  if (existing) {
    return lessons.map((l) =>
      l.id === existing.id
        ? { ...l, count: l.count + 1, last_seen: now }
        : l,
    );
  }

  const newLesson: Lesson = {
    id: randomBytes(4).toString("hex"),
    timestamp: now,
    category,
    summary,
    detail,
    trace_id,
    count: 1,
    last_seen: now,
  };

  lessons = [newLesson, ...lessons];
  if (lessons.length > MAX_LESSONS) lessons = lessons.slice(0, MAX_LESSONS);
  return lessons;
}

// =============================================================================
// Phoenix API
// =============================================================================

interface PHSpan {
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

async function fetchSpans(): Promise<PHSpan[]> {
  try {
    const url = `${PHOENIX_HOST}/v1/projects/${encodeURIComponent(PHOENIX_PROJECT)}/spans`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { data: PHSpan[] };
    return data.data ?? [];
  } catch { return []; }
}

// =============================================================================
// Conversation Reconstruction from Spans
// =============================================================================

interface ConversationTurn {
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

interface ConversationAnalysis {
  traceId: string;
  turns: ConversationTurn[];
  fullTranscript: string;
}

function buildConversation(spans: PHSpan[]): ConversationAnalysis | null {
  const rootSpan = spans.find((s) => s.span_kind === "CHAIN");
  if (!rootSpan) return null;

  const traceId = rootSpan.context.trace_id;
  const prompt = rootSpan.attributes?.["pi.prompt"] ?? "";

  const turnSpans = spans
    .filter((s) => s.name.startsWith("pi.turn"))
    .sort((a, b) => (a.attributes?.["pi.turn_index"] ?? 0) - (b.attributes?.["pi.turn_index"] ?? 0));

  const toolSpans = spans.filter((s) => s.span_kind === "TOOL");

  const turns: ConversationTurn[] = [];

  for (const ts of turnSpans) {
    const turnIndex = ts.attributes?.["pi.turn_index"] ?? 0;
    const toolCalls = toolSpans
      .filter((tool) => tool.parent_id === ts.context.span_id)
      .map((tool) => ({
        toolName: tool.attributes?.["pi.tool_name"] ?? "unknown",
        args: (() => {
          try { return JSON.parse(tool.attributes?.["pi.tool_args"] ?? "{}"); }
          catch { return {}; }
        })(),
        output: tool.attributes?.["pi.tool_output"] ?? "",
        isError: tool.status_code === "ERROR",
      }));

    turns.push({
      turnIndex,
      prompt: turnIndex === 0 ? prompt : "[pokračování]",
      assistantResponse: ts.attributes?.["pi.assistant_response"] ?? "",
      toolCalls,
      tokenCount: ts.attributes?.["openinference.llm.token_count.total"] ?? 0,
    });
  }

  const lines: string[] = [`## Konverzace (trace: ${traceId.slice(0, 12)}...)`];
  lines.push(`**Zadání:** ${prompt}`);
  lines.push("");

  for (const turn of turns) {
    if (turn.assistantResponse) {
      lines.push(`### Turn ${turn.turnIndex} — Odpověď AI:`);
      lines.push(turn.assistantResponse.slice(0, 2000));
      lines.push("");
    }
    for (const tc of turn.toolCalls) {
      const status = tc.isError ? " ❌ CHYBA" : "";
      lines.push(`Nástroj: ${tc.toolName}${status}`);
      lines.push(`  Argumenty: ${JSON.stringify(tc.args).slice(0, 500)}`);
      lines.push(`  Výstup: ${tc.output.slice(0, 1000)}`);
      lines.push("");
    }
  }

  return { traceId, turns, fullTranscript: lines.join("\n") };
}

// =============================================================================
// Provider-agnostic LLM caller
// =============================================================================

/**
 * Resolves provider info from pi's model object.
 * Returns baseUrl and apiKey for the provider.
 */
function resolveLLMConfig(model: Model | null | undefined): {
  baseUrl: string;
  modelId: string;
  apiKey: string | null;
} {
  const provider = model?.provider ?? "";
  const modelId = model?.id ?? "";

  // Default fallback: OpenAI-compatible local/remote endpoint
  let baseUrl = "https://opencode.ai/zen/v1";
  let apiKey: string | null = null;

  // Read auth.json once
  let auth: Record<string, any> = {};
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (existsSync(authPath)) {
      auth = JSON.parse(readFileSync(authPath, "utf-8"));
    }
  } catch {}

  // Try to match provider
  if (!provider) {
    // No provider info — try env vars
    apiKey = process.env.OPENAI_API_KEY
      ?? process.env.ANTHROPIC_API_KEY
      ?? process.env.OPENCODE_API_KEY
      ?? null;
    if (process.env.OPENAI_BASE_URL) baseUrl = process.env.OPENAI_BASE_URL;
  } else if (provider === "opencode" || provider === "opencode-go") {
    baseUrl = "https://opencode.ai/zen/v1";
    apiKey = auth.opencode?.access ?? process.env.OPENCODE_API_KEY ?? null;
  } else if (provider === "anthropic") {
    baseUrl = "https://api.anthropic.com/v1";
    apiKey = auth.anthropic?.access
      ?? process.env.ANTHROPIC_API_KEY
      ?? auth.anthropic?.apiKey
      ?? null;
  } else if (provider === "openai") {
    baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    apiKey = auth.openai?.access
      ?? process.env.OPENAI_API_KEY
      ?? auth.openai?.apiKey
      ?? null;
  } else if (provider === "kilo") {
    baseUrl = auth.kilo?.access
      ? "https://api.kilo.ai/api/openrouter"
      : "https://opencode.ai/zen/v1";
    apiKey = auth.kilo?.access ?? process.env.KILO_API_KEY ?? null;
  } else if (provider === "google" || provider === "google-generative-ai") {
    baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    apiKey = process.env.GEMINI_API_KEY ?? null;
  } else if (provider === "ollama") {
    baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
    apiKey = "ollama"; // Ollama ignores API key
  } else {
    // Unknown provider — try env vars
    apiKey = process.env.OPENAI_API_KEY
      ?? process.env.OPENCODE_API_KEY
      ?? null;
    if (process.env.OPENAI_BASE_URL) baseUrl = process.env.OPENAI_BASE_URL;
  }

  // If we still don't have an API key, try the stored auth providers
  if (!apiKey) {
    for (const p of ["opencode", "openai", "anthropic", "kilo"] as const) {
      const cred = auth[p];
      if (cred?.access) { apiKey = cred.access; break; }
      if (cred?.apiKey) { apiKey = cred.apiKey; break; }
    }
  }

  return { baseUrl, modelId: modelId || "deepseek-v4-flash-free", apiKey };
}

/**
 * Calls the LLM using the provider-agnostic OpenAI-compatible chat completions format.
 * Falls back gracefully if the provider doesn't support it.
 */
async function callLLM(
  config: { baseUrl: string; modelId: string; apiKey: string | null },
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  if (!config.apiKey) {
    console.warn("[phoenix-learner] No API key available for LLM analysis — skipping");
    return null;
  }

  // Build the endpoint URL
  // OpenAI-compatible: {baseUrl}/chat/completions
  // Anthropic needs special handling — skip, use openai-compat only
  const isAnthropic = config.baseUrl.includes("anthropic.com");
  const url = isAnthropic
    ? `${config.baseUrl}/messages`
    : config.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (isAnthropic) {
      headers["x-api-key"] = config.apiKey!;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const body = isAnthropic
      ? {
          model: config.modelId,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          max_tokens: 2000,
          temperature: 0.1,
        }
      : {
          model: config.modelId,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          max_tokens: 2000,
          temperature: 0.1,
        };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(`[phoenix-learner] LLM call failed (${response.status}): ${text.slice(0, 200)}`);
      return null;
    }

    const data = (await response.json()) as any;

    if (isAnthropic) {
      const content = data?.content?.[0]?.text;
      return typeof content === "string" ? content : null;
    }

    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : null;
  } catch (e) {
    console.warn(`[phoenix-learner] LLM call error: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// =============================================================================
// LLM Analysis
// =============================================================================

interface LLMFinding {
  category: LessonCategory;
  summary: string;
  detail: string;
  advice: string;
}

interface LLMAnalysisResult {
  findings: LLMFinding[];
}

const ANALYSIS_PROMPT = `Jsi expert na analýzu konverzací AI coding agentů.
Analyzuj následující konverzaci mezi uživatelem a AI agentem.
Hledej tyto typy problémů:

1. **task_misunderstanding** — Agent nepochopil zadání, dělá něco jiného, než bylo řečeno
2. **context_loss** — Agent ztratil kontext v průběhu konverzace, zapomněl co se řešilo
3. **incomplete_info** — Agent neověřil dostatek informací, dělá domněnky místo aby se zeptal nebo zkontroloval
4. **verification_failure** — Agent neověřil výsledek své práce (např. nezkusil jestli kód funguje)
5. **tool_misuse** — Agent použil nástroj nesprávně (špatné argumenty, nesprávný nástroj)
6. **premature_conclusion** — Agent udělal závěr příliš brzy, bez dostatečných dat
7. **chain_error** — Jedna chyba vedla k řetězení dalších chyb
8. **instruction_ignored** — Agent ignoroval explicitní instrukce z promptu nebo system promptu

Pro KAŽDÝ nalezený problém vypiš:
- KATEGORIE: (jedna z výše uvedených)
- SHRNUTÍ: (krátká věta co se stalo, max 100 znaků)
- DETAIL: (kontext - co agent udělal špatně, max 300 znaků)
- RADA: (jak se tomu příště vyhnout, max 150 znaků)

Pokud není žádný problém, vrať: {"findings": []}

Vrať výsledek jako platné JSON:
{"findings": [{"category": "...", "summary": "...", "detail": "...", "advice": "..."}]}`;

async function analyzeWithLLM(
  transcript: string,
  model: Model | null | undefined,
): Promise<LLMFinding[]> {
  const config = resolveLLMConfig(model);
  const content = await callLLM(config, ANALYSIS_PROMPT, transcript);
  if (!content) return [];

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const result = JSON.parse(jsonMatch[0]) as LLMAnalysisResult;
    return result.findings ?? [];
  } catch {
    return [];
  }
}

// =============================================================================
// Extension State
// =============================================================================

let lessons: Lesson[] = [];
let analyzedTraceIds: Set<string> = new Set();
let currentModel: Model | null | undefined = null;

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  lessons = loadLessons();
  console.log(`[phoenix-learner] Loaded ${lessons.length} lessons from ${LESSONS_PATH}`);

  // ── before_agent_start ──────────────────────────────────────────────
  // Track current model + inject lessons into system prompt
  pi.on("before_agent_start", async (event, ctx) => {
    // Store current model for later analysis
    currentModel = ctx.model;

    // Inject lessons
    lessons = loadLessons();
    if (lessons.length === 0) return;

    const sorted = [...lessons].sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
    });

    const active = sorted.slice(0, MAX_LESSONS_IN_PROMPT);

    const icon: Record<string, string> = {
      task_misunderstanding: "🎯", context_loss: "🔄",
      incomplete_info: "🔍", verification_failure: "✅",
      tool_misuse: "🔧", premature_conclusion: "⚡",
      chain_error: "⛓️", instruction_ignored: "⚠️", other: "💡",
    };

    const lessonLines = active.map((l) => {
      const emoji = icon[l.category] ?? "💡";
      return `${emoji} **${l.summary}** _(${l.count}x)_`;
    });

    const lessonsText = [
      "",
      "─── 🧠 Lessons Learned z předchozích chyb ───",
      "Tyto chyby se v minulosti staly. Dej pozor, aby ses jim vyvaroval(a):",
      ...lessonLines,
      "─── Konec lessons ───",
      "",
    ].join("\n");

    return {
      systemPrompt: event.systemPrompt + "\n" + lessonsText,
    };
  });

  // ── agent_end → auto-analyze ───────────────────────────────────────
  pi.on("agent_end", async (_event, _ctx) => {
    await new Promise((r) => setTimeout(r, 3000));

    try {
      const spans = await fetchSpans();
      if (spans.length === 0) return;

      const sorted = [...spans].sort(
        (a, b) => new Date(b.end_time).getTime() - new Date(a.end_time).getTime(),
      );
      const latestTraceId = sorted[0]?.context.trace_id;
      if (!latestTraceId || analyzedTraceIds.has(latestTraceId)) return;

      analyzedTraceIds.add(latestTraceId);
      if (analyzedTraceIds.size > 200) {
        analyzedTraceIds = new Set([...analyzedTraceIds].slice(-100));
      }

      const traceSpans = spans.filter((s) => s.context.trace_id === latestTraceId);

      // 1) Heuristic: tool errors
      let hasFindings = false;
      for (const es of traceSpans.filter((s) => s.status_code === "ERROR")) {
        const isTool = es.span_kind === "TOOL";
        const toolName = es.attributes?.["pi.tool_name"] ?? "";
        const summary = isTool
          ? `Nástroj ${toolName} selhal — před použitím ověř vstup`
          : `Volání AI selhalo`;
        const detail = es.status_message
          ? `${es.name}: ${es.status_message}`
          : `Chyba v ${es.name}`;
        lessons = upsertLesson(lessons, isTool ? "tool_misuse" : "other", summary, detail.slice(0, 300), latestTraceId);
        hasFindings = true;
      }

      // 2) LLM behavioral analysis (uses user's current model)
      const conversation = buildConversation(traceSpans);
      if (conversation && conversation.turns.length > 0) {
        const findings = await analyzeWithLLM(conversation.fullTranscript, currentModel);
        for (const f of findings) {
          lessons = upsertLesson(lessons, f.category, f.advice, f.detail.slice(0, 300), latestTraceId);
          hasFindings = true;
        }
      }

      if (hasFindings) {
        saveLessons(lessons);
        console.log(`[phoenix-learner] Saved ${lessons.length} lessons`);
      }
    } catch (e) {
      console.warn(`[phoenix-learner] Error: ${e instanceof Error ? e.message : e}`);
    }
  });

  // ── /learn ─────────────────────────────────────────────────────────
  pi.registerCommand("learn", {
    description: "Spustí analýzu posledních traceů z Phoenixu a uloží lessons",
    handler: async (_args, ctx) => {
      ctx.ui.notify("🔍 Stahuji tracy z Phoenixu...", "info");

      try {
        const spans = await fetchSpans();
        if (spans.length === 0) {
          ctx.ui.notify("⚠️ Žádné tracy v Phoenixu", "warning");
          return;
        }

        const traceMap = new Map<string, PHSpan[]>();
        for (const s of spans) {
          const tid = s.context.trace_id;
          if (!traceMap.has(tid)) traceMap.set(tid, []);
          traceMap.get(tid)!.push(s);
        }

        ctx.ui.notify(`📊 Analyzuji ${traceMap.size} traceů...`, "info");
        let totalFindings = 0;

        for (const [traceId, traceSpans] of traceMap) {
          for (const es of traceSpans.filter((s) => s.status_code === "ERROR")) {
            const isTool = es.span_kind === "TOOL";
            const toolName = es.attributes?.["pi.tool_name"] ?? "";
            const summary = isTool ? `Nástroj ${toolName} selhal` : `Chyba v ${es.name}`;
            lessons = upsertLesson(lessons, isTool ? "tool_misuse" : "other", summary, es.status_message?.slice(0, 300) ?? "", traceId);
            totalFindings++;
          }

          const conv = buildConversation(traceSpans);
          if (conv && conv.turns.length > 0) {
            const findings = await analyzeWithLLM(conv.fullTranscript, ctx.model);
            for (const f of findings) {
              lessons = upsertLesson(lessons, f.category, f.advice, f.detail.slice(0, 300), traceId);
              totalFindings++;
            }
          }
        }

        saveLessons(lessons);
        ctx.ui.notify(`✅ Analyzováno: ${totalFindings} nálezů, ${lessons.length} lessons uloženo`, "info");
      } catch (e) {
        ctx.ui.notify(`❌ Chyba: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  });

  // ── /lessons ───────────────────────────────────────────────────────
  pi.registerCommand("lessons", {
    description: "Zobrazí všechny uložené lessons",
    handler: async (_args, ctx) => {
      lessons = loadLessons();
      if (lessons.length === 0) {
        ctx.ui.notify("📭 Žádné lessons — zatím bez chyb", "info");
        return;
      }

      const byCategory: Record<string, Lesson[]> = {};
      for (const l of lessons) {
        (byCategory[l.category] ??= []).push(l);
      }

      const icon: Record<string, string> = {
        task_misunderstanding: "🎯", context_loss: "🔄",
        incomplete_info: "🔍", verification_failure: "✅",
        tool_misuse: "🔧", premature_conclusion: "⚡",
        chain_error: "⛓️", instruction_ignored: "⚠️", other: "💡",
      };
      const catNames: Record<string, string> = {
        task_misunderstanding: "Nepochopení úkolu", context_loss: "Ztráta kontextu",
        incomplete_info: "Neúplné informace", verification_failure: "Neověření výsledků",
        tool_misuse: "Špatné použití nástrojů", premature_conclusion: "Předčasný závěr",
        chain_error: "Řetězení chyb", instruction_ignored: "Ignorování instrukcí", other: "Ostatní",
      };

      const lines: string[] = [];
      for (const [cat, items] of Object.entries(byCategory)) {
        lines.push(`\n${icon[cat] ?? "💡"} ${catNames[cat] ?? cat} (${items.length}):`);
        for (const l of items) {
          lines.push(`  [${l.count}x] ${l.summary}`);
          lines.push(`        ${l.detail.slice(0, 100)}${l.detail.length > 100 ? "..." : ""}`);
          lines.push(`        📝 ${l.id}`);
        }
      }

      ctx.ui.notify(`📚 Lessons (${lessons.length}):\n${lines.join("\n")}`, "info");
    },
  });

  // ── /forget-lesson ─────────────────────────────────────────────────
  pi.registerCommand("forget-lesson", {
    description: "Smaže lesson (podle ID) nebo všechny (--all)",
    handler: async (args, ctx) => {
      const a = args?.trim();
      if (!a) { ctx.ui.notify("Použití: /forget-lesson <id> nebo /forget-lesson --all", "info"); return; }

      if (a === "--all") {
        lessons = []; saveLessons(lessons);
        ctx.ui.notify("🗑️ Všechny lessons smazány", "info");
        return;
      }

      const before = lessons.length;
      lessons = lessons.filter((l) => l.id !== a);
      if (lessons.length < before) {
        saveLessons(lessons);
        ctx.ui.notify(`🗑️ Lesson ${a} smazána`, "info");
      } else {
        ctx.ui.notify(`❌ Lesson ${a} nenalezena`, "warning");
      }
    },
  });

  // ── /review ────────────────────────────────────────────────────────
  pi.registerCommand("review", {
    description: "Analyzuje poslední konverzaci z aktuální session pomocí AI",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries()
        .filter((e: any) => e.type === "message")
        .slice(-20);

      if (entries.length < 2) {
        ctx.ui.notify("📝 Konverzace je příliš krátká na analýzu", "info");
        return;
      }

      ctx.ui.notify("🔍 Analyzuji konverzaci...", "info");

      const lines: string[] = ["## Aktuální konverzace"];
      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        const role = msg.role === "user" ? "Uživatel" : "AI";
        const text = msg.content
          ?.filter((p: any) => p.type === "text")
          ?.map((p: any) => p.text)
          ?.join("\n") ?? "";
        if (text) lines.push(`### ${role}\n${text.slice(0, 1500)}`);
      }

      const findings = await analyzeWithLLM(lines.join("\n"), ctx.model);

      if (findings.length === 0) {
        ctx.ui.notify("✅ Konverzace vypadá v pořádku, žádné problémy", "success");
        return;
      }

      const icon: Record<string, string> = {
        task_misunderstanding: "🎯", context_loss: "🔄",
        incomplete_info: "🔍", verification_failure: "✅",
        tool_misuse: "🔧", premature_conclusion: "⚡",
        chain_error: "⛓️", instruction_ignored: "⚠️", other: "💡",
      };

      const resultLines: string[] = ["📋 Nálezy z review:"];
      for (const f of findings) {
        resultLines.push(`\n${icon[f.category] ?? "💡"} **${f.summary}**`);
        resultLines.push(`   ${f.detail}`);
        resultLines.push(`   ➡️ ${f.advice}`);
        lessons = upsertLesson(lessons, f.category, f.advice, f.detail.slice(0, 300), "session-review");
      }

      saveLessons(lessons);
      ctx.ui.notify(resultLines.join("\n"), "info");
    },
  });
}
