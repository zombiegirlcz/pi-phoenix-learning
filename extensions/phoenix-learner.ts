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
 * 3. Sends transcript to LLM (via OpenCode API) for behavioral analysis
 * 4. Extracts structured lessons and stores in ~/.pi/agent/pi-lessons.json
 * 5. Before each agent_start, injects relevant lessons into system prompt
 *
 * Commands:
 *   /lessons        – zobrazí všechny uložené lessons
 *   /learn          – ručně spustí analýzu posledních traceů
 *   /forget-lesson  – smaže lesson (podle ID nebo --all)
 *   /review         – analyzuje poslední konverzaci z aktuální session
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

// OpenCode API for LLM analysis
const OPENCODE_API_BASE = "https://opencode.ai/zen/v1";
const ANALYSIS_MODEL = process.env.PHOENIX_LEARNER_MODEL || "deepseek-v4-flash-free";

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

/** Normalize lesson text to create a stable fingerprint */
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
    // One contains the other
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

async function fetchTraces(): Promise<any[]> {
  try {
    const url = `${PHOENIX_HOST}/v1/projects/${encodeURIComponent(PHOENIX_PROJECT)}/traces`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { data: any[] };
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
          try {
            const raw = tool.attributes?.["pi.tool_args"];
            return raw ? JSON.parse(raw) : {};
          } catch { return {}; }
        })(),
        output: tool.attributes?.["pi.tool_output"] ?? "",
        isError: tool.status_code === "ERROR",
      }));

    turns.push({
      turnIndex,
      prompt: turnIndex === 0 ? prompt : "[pokračování z předchozího turnu]",
      assistantResponse: ts.attributes?.["pi.assistant_response"] ?? "",
      toolCalls,
      tokenCount: ts.attributes?.["openinference.llm.token_count.total"] ?? 0,
    });
  }

  // Build a readable transcript
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

  return {
    traceId,
    turns,
    fullTranscript: lines.join("\n"),
  };
}

// =============================================================================
// LLM Analysis via OpenCode API
// =============================================================================

function getApiKey(): string | null {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      // Try opencode first, then fall back to env var
      const key = auth.opencode?.access ?? process.env.OPENCODE_API_KEY;
      if (key && typeof key === "string" && key.length > 10) return key;
    }
    return process.env.OPENCODE_API_KEY ?? null;
  } catch {
    return process.env.OPENCODE_API_KEY ?? null;
  }
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

interface LLMFinding {
  category: LessonCategory;
  summary: string;
  detail: string;
  advice: string;
}

interface LLMAnalysisResult {
  findings: LLMFinding[];
}

async function analyzeWithLLM(transcript: string): Promise<LLMFinding[]> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("[phoenix-learner] No API key for LLM analysis");
    return [];
  }

  try {
    const response = await fetch(`${OPENCODE_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        messages: [
          { role: "system", content: ANALYSIS_PROMPT },
          { role: "user", content: transcript },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`[phoenix-learner] LLM analysis failed: ${response.status} ${body.slice(0, 200)}`);
      return [];
    }

    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return [];

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const result = JSON.parse(jsonMatch[0]) as LLMAnalysisResult;
    return result.findings ?? [];
  } catch (e) {
    console.warn(`[phoenix-learner] LLM analysis error: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

// =============================================================================
// Extension State
// =============================================================================

let lessons: Lesson[] = [];
let analyzedTraceIds: Set<string> = new Set();

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  lessons = loadLessons();
  console.log(`[phoenix-learner] Loaded ${lessons.length} lessons from ${LESSONS_PATH}`);

  // ── before_agent_start ──────────────────────────────────────────────
  // Inject lessons into system prompt
  pi.on("before_agent_start", async (event, _ctx) => {
    lessons = loadLessons();
    if (lessons.length === 0) return;

    // Sort: most frequent + most recent first
    const sorted = [...lessons].sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
    });

    const active = sorted.slice(0, MAX_LESSONS_IN_PROMPT);

    const lessonLines = active.map((l, i) => {
      const icon: Record<string, string> = {
        task_misunderstanding: "🎯",
        context_loss: "🔄",
        incomplete_info: "🔍",
        verification_failure: "✅",
        tool_misuse: "🔧",
        premature_conclusion: "⚡",
        chain_error: "⛓️",
        instruction_ignored: "⚠️",
        other: "💡",
      };
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
    // Short delay for spans to be ingested
    await new Promise((r) => setTimeout(r, 3000));

    try {
      const spans = await fetchSpans();
      if (spans.length === 0) return;

      // Get latest trace
      const sorted = [...spans].sort(
        (a, b) => new Date(b.end_time).getTime() - new Date(a.end_time).getTime(),
      );
      const latestTraceId = sorted[0]?.context.trace_id;
      if (!latestTraceId || analyzedTraceIds.has(latestTraceId)) return;

      analyzedTraceIds.add(latestTraceId);
      if (analyzedTraceIds.size > 200) {
        analyzedTraceIds = new Set([...analyzedTraceIds].slice(-100));
      }

      // Filter spans for this trace
      const traceSpans = spans.filter((s) => s.context.trace_id === latestTraceId);

      // 1) Heuristic analysis for obvious errors
      const errorSpans = traceSpans.filter((s) => s.status_code === "ERROR");
      const toolErrors = traceSpans.filter(
        (s) => s.span_kind === "TOOL" && s.status_code === "ERROR",
      );

      let hasFindings = false;

      for (const es of errorSpans) {
        const isTool = es.span_kind === "TOOL";
        const toolName = es.attributes?.["pi.tool_name"] ?? "";

        const summary = isTool
          ? `Nástroj ${toolName} selhal — před použitím ověř vstup`
          : `Volání AI selhalo — zkontroluj parametry modelu`;

        const detail = es.status_message
          ? `${es.name}: ${es.status_message}`
          : `Chyba v ${es.name}`;

        lessons = upsertLesson(
          lessons,
          isTool ? "tool_misuse" : "other",
          summary,
          detail.slice(0, 300),
          latestTraceId,
        );
        hasFindings = true;
      }

      // 2) LLM-based behavioral analysis (for deeper issues)
      const conversation = buildConversation(traceSpans);
      if (conversation && conversation.turns.length > 0) {
        const findings = await analyzeWithLLM(conversation.fullTranscript);

        for (const f of findings) {
          // Combine summary with advice for the lesson
          const fullSummary = f.advice.startsWith(f.summary)
            ? f.advice
            : `${f.advice} (${f.summary})`;

          lessons = upsertLesson(
            lessons,
            f.category,
            fullSummary,
            f.detail.slice(0, 300),
            latestTraceId,
          );
          hasFindings = true;
        }
      }

      if (hasFindings) {
        saveLessons(lessons);
        const newCount = lessons.length;
        console.log(`[phoenix-learner] Saved ${newCount} lessons`);
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

        // Group by trace_id
        const traceMap = new Map<string, PHSpan[]>();
        for (const s of spans) {
          const tid = s.context.trace_id;
          if (!traceMap.has(tid)) traceMap.set(tid, []);
          traceMap.get(tid)!.push(s);
        }

        ctx.ui.notify(`📊 Analyzuji ${traceMap.size} traceů...`, "info");
        let totalFindings = 0;

        for (const [traceId, traceSpans] of traceMap) {
          // Heuristic
          const errors = traceSpans.filter((s) => s.status_code === "ERROR");
          for (const es of errors) {
            const isTool = es.span_kind === "TOOL";
            const toolName = es.attributes?.["pi.tool_name"] ?? "";
            const summary = isTool
              ? `Nástroj ${toolName} selhal`
              : `Chyba v ${es.name}`;
            lessons = upsertLesson(lessons, isTool ? "tool_misuse" : "other", summary, es.status_message?.slice(0, 300) ?? "", traceId);
            totalFindings++;
          }

          // LLM analysis for recent traces
          const conv = buildConversation(traceSpans);
          if (conv && conv.turns.length > 0) {
            const findings = await analyzeWithLLM(conv.fullTranscript);
            for (const f of findings) {
              const fullSummary = f.advice;
              lessons = upsertLesson(lessons, f.category, fullSummary, f.detail.slice(0, 300), traceId);
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
        if (!byCategory[l.category]) byCategory[l.category] = [];
        byCategory[l.category].push(l);
      }

      const lines: string[] = [];
      const icon: Record<string, string> = {
        task_misunderstanding: "🎯", context_loss: "🔄",
        incomplete_info: "🔍", verification_failure: "✅",
        tool_misuse: "🔧", premature_conclusion: "⚡",
        chain_error: "⛓️", instruction_ignored: "⚠️", other: "💡",
      };

      const catNames: Record<string, string> = {
        task_misunderstanding: "Nepochopení úkolu",
        context_loss: "Ztráta kontextu",
        incomplete_info: "Neúplné informace",
        verification_failure: "Neověření výsledků",
        tool_misuse: "Špatné použití nástrojů",
        premature_conclusion: "Předčasný závěr",
        chain_error: "Řetězení chyb",
        instruction_ignored: "Ignorování instrukcí",
        other: "Ostatní",
      };

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
      if (!a) {
        ctx.ui.notify("Použití: /forget-lesson <id> nebo /forget-lesson --all", "info");
        return;
      }

      if (a === "--all") {
        lessons = [];
        saveLessons(lessons);
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
        .slice(-20); // Last 20 messages

      if (entries.length < 2) {
        ctx.ui.notify("📝 Konverzace je příliš krátká na analýzu", "info");
        return;
      }

      ctx.ui.notify("🔍 Analyzuji konverzaci...", "info");

      // Build transcript from session
      const transcriptLines: string[] = ["## Aktuální konverzace"];
      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        const role = msg.role === "user" ? "Uživatel" : "AI";
        const text = msg.content
          ?.filter((p: any) => p.type === "text")
          ?.map((p: any) => p.text)
          ?.join("\n") ?? "";
        if (text) {
          transcriptLines.push(`### ${role}`);
          transcriptLines.push(text.slice(0, 1500));
        }
      }

      const transcript = transcriptLines.join("\n");
      const findings = await analyzeWithLLM(transcript);

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

      const lines: string[] = ["📋 Nálezy z review:"];
      for (const f of findings) {
        lines.push(`\n${icon[f.category] ?? "💡"} **${f.summary}**`);
        lines.push(`   ${f.detail}`);
        lines.push(`   ➡️ ${f.advice}`);

        // Auto-save to lessons
        const fullSummary = f.advice;
        lessons = upsertLesson(lessons, f.category, fullSummary, f.detail.slice(0, 300), "session-review");
      }

      saveLessons(lessons);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
