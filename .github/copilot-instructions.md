# Copilot Instructions: pi-phoenix-learning

## Project Overview

**pi-phoenix-learning** is a unified package that adds observability and self-improvement capabilities to both **Pi** and **Copilot CLI** agents. It consists of shared utilities and a unified extension:

1. **Unified phoenix extension** — Captures every agent call (prompts, responses, tool I/O) and sends traces to [Arize Phoenix](https://phoenix.arize.com) for observability. Auto-detects whether running in Pi or Copilot context.
2. **Learner** — Analyzes traces post-execution, identifies mistakes (task misunderstanding, context loss, verification failures), and stores lessons in separate JSON files to improve future runs.

The extension runs on every agent invocation automatically. Lessons are extracted after each call completes and injected into the system prompt before the next invocation.

## Build, Test & Lint

This is a **Node.js/TypeScript package** with no build step (extensions are imported directly by Pi).

```bash
# Install dependencies
npm install

# Type-check only (no build output, but catches errors)
npm run type-check  # if available, or use tsc directly
tsc --noEmit        # one-shot type check

# Format check (if prettier is configured)
npm run format:check
npm run format      # fix formatting

# No test suite yet — tests would go in tests/ directory
```

**Debug workflow:**
- Modify extension code in `extensions/*.ts`
- Reinstall the package in Pi: `/reload` command or restart Pi process
- Watch Phoenix traces: http://localhost:6006 (project: `pi`)
- Check lessons: `~/.pi/agent/pi-lessons.json` or `/lessons` command in Pi

## Architecture

## Architecture

### Unified Extension Design

The new unified extension (`extensions/unified-phoenix-extension.ts`) detects its runtime context and adapts:

**For Pi agent:**
- Registers handlers on Pi's ExtensionAPI
- Traces to Phoenix project: `pi`
- Lessons stored in: `~/.pi/agent/pi-lessons.json`
- Lessons injected into system prompt via `before_agent_start` hook

**For Copilot CLI (experimental):**
- Registers handlers on Copilot's extension API
- Traces to Phoenix project: `copilot` (configurable)
- Lessons stored in: `~/.copilot/copilot-lessons.json` (configurable)
- Lessons injected if API supports system prompt modification

### Shared Library Architecture

All reusable logic extracted into `lib/` modules:

- **span-builder.ts** — OpenTelemetry-compatible span creation (root, turn, tool)
- **phoenix-api.ts** — Multi-project Phoenix REST API wrapper (send/fetch spans)
- **lesson-storage.ts** — Persistent lesson JSON file handling (load/save/deduplicate)
- **llm-provider.ts** — Provider-agnostic LLM calls (routes to OpenAI/Anthropic/OpenCode/etc.)
- **lesson-analyzer.ts** — Conversation reconstruction from spans + LLM analysis for mistake extraction

### Extension Integration Points

**Tracer (shared for both agents):**
- Hooks into `before_agent_start` → initialize trace
- Hooks into `turn_start`, `message_end`, `tool_execution_start/end`, `turn_end` → build spans
- Hooks into `agent_end` → finalize and send spans to Phoenix

**Learner (shared for both agents):**
- Hooks into `before_agent_start` → load top 8 lessons, inject into system prompt
- Hooks into `agent_end` → fetch spans, analyze for mistakes, upsert lessons

### Span Structure (Phoenix)

Each invocation creates one trace with nested spans (both Pi and Copilot):
```
[agent-type].agent (CHAIN)
├── [agent-type].turn.0 (LLM)
│   ├── [agent-type].tool.bash (TOOL)
│   ├── [agent-type].tool.view (TOOL)
│   └── ...
├── [agent-type].turn.1 (LLM)
│   └── [agent-type].tool.bash (TOOL)
└── ...
```

Span names are namespaced: `pi.agent`, `copilot.agent`, `pi.turn.0`, `copilot.turn.0`, etc.

## Key Conventions

### Environment Configuration

**For Pi agent:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `PHOENIX_HOST` | `http://localhost:6006` | Phoenix server URL |
| `PHOENIX_PROJECT` | `pi` | Project name in Phoenix UI |
| `PI_LESSONS_PATH` | `~/.pi/agent/pi-lessons.json` | Lessons file location |
| `PHOENIX_API_KEY` | *(empty)* | Optional auth for remote Phoenix |

**For Copilot CLI:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `PHOENIX_HOST` | `http://localhost:6006` | Phoenix server URL |
| `COPILOT_PHOENIX_PROJECT` | `copilot` | Project name in Phoenix UI |
| `COPILOT_LESSONS_PATH` | `~/.copilot/copilot-lessons.json` | Lessons file location |
| `PHOENIX_API_KEY` | *(empty)* | Optional auth for remote Phoenix |

### Lesson Categories

The learner tags mistakes with these categories (in `Lesson.category`):

- `task_misunderstanding` — Agent misinterpreted the request
- `context_loss` — Agent forgot prior conversation context
- `incomplete_info` — Agent made assumptions instead of asking/verifying
- `verification_failure` — Agent didn't test/validate its work
- `tool_misuse` — Tool called incorrectly (wrong args, misused flags)
- `premature_conclusion` — Agent stopped before gathering enough info
- `chain_error` — One error cascaded to others
- `instruction_ignored` — System prompt or user instruction was violated
- `other` — General mistake

### Lesson Storage Format

Lessons are stored separately for each agent:

**Pi**: `~/.pi/agent/pi-lessons.json`
**Copilot**: `~/.copilot/copilot-lessons.json`

Each file stores an array of lessons:

```json
[
  {
    "id": "abc1234f",
    "timestamp": "2024-07-12T10:30:00.000Z",
    "category": "verification_failure",
    "summary": "Always verify file paths before writing",
    "detail": "Tried to write to /nonexistent/path without checking existence",
    "trace_id": "deadbeef...",
    "count": 3,
    "last_seen": "2024-07-12T10:30:00.000Z"
  }
]
```

- `summary` is injected into the system prompt (top 8 by frequency/recency)
- `detail` is kept for user reference
- Duplicates are deduplicated by fingerprinting `summary` (lowercase, stripped punctuation/digits)
- Max 50 lessons stored; older ones are pruned

### Extension API Patterns

When modifying extensions, follow these patterns:

```typescript
// Register event handler
pi.on("event_name", async (event, ctx) => {
  // ctx.model?.id — current model identifier
  // ctx.model?.provider — current provider (opencode, anthropic, etc.)
  // event.* — event-specific payload
});

// Add slash commands (learner style)
pi.addCommand({
  name: "command_name",
  description: "...",
  handler: async (args: string, ctx: Context) => {
    return "response text";
  },
});
```

### Phoenix API Integration

Spans are sent and fetched separately for each Phoenix project:

**Send spans (both agents):**
```
POST {PHOENIX_HOST}/v1/projects/{project}/spans
Content-Type: application/json
Authorization: Bearer {PHOENIX_API_KEY}  (optional)

{ "data": [{ name, context, span_kind, parent_id, start_time, end_time, status_code, attributes, events }, ...] }
```

**Fetch spans (both agents):**
```
GET {PHOENIX_HOST}/v1/projects/{project}/spans
```

**Projects:**
- `pi` — traces for Pi agent (default)
- `copilot` — traces for Copilot CLI (default, configurable)

Max attribute value: 5000 chars (truncate before sending).

### Provider-Agnostic LLM Calls (Learner)

The learner uses `model.provider` to route API calls to the right endpoint. Supported providers:
- `opencode` / `opencode-go` → `https://opencode.ai/zen/v1`
- `anthropic` → `https://api.anthropic.com/v1`
- `openai` → `https://api.openai.com/v1`
- `google`, `ollama`, and others via fallback logic

Auth is read from `~/.pi/agent/auth.json` or environment variables.

## File Organization

```
pi-phoenix-learning/
├── extensions/
│   ├── unified-phoenix-extension.ts  — Unified tracer + learner (Pi + Copilot)
│   ├── phoenix-tracer.ts             — Original Pi-only tracer (backward compat)
│   └── phoenix-learner.ts            — Original Pi-only learner (backward compat)
├── lib/
│   ├── span-builder.ts               — Shared OpenTelemetry span creation
│   ├── phoenix-api.ts                — Multi-project Phoenix REST API
│   ├── lesson-storage.ts             — JSON persistence for lessons
│   ├── llm-provider.ts               — Provider-agnostic LLM routing
│   └── lesson-analyzer.ts            — Conversation analysis + LLM extraction
├── scripts/
│   └── setup-phoenix.sh              — Start/stop Phoenix server locally
├── config/
│   └── pi-settings.example.json      — Example Pi configuration
├── package.json                      — Declares extensions for Pi and Copilot
├── tsconfig.json                     — TypeScript configuration
└── README.md
```

**Key files for modification:**
- `extensions/unified-phoenix-extension.ts` — Main extension logic (tracer + learner combined)
- `lib/*.ts` — Utility modules (extract and reuse shared logic here)
- `package.json` — Extension registration (both `pi.extensions` and `copilot.extensions` fields)

## Common Tasks

### Add a New Event Hook

1. Check [Pi Extension API docs](https://docs.pi.rocks) for available events
2. Add handler in `extensions/unified-phoenix-extension.ts`:
   ```typescript
   pi.on("new_event", async (event, ctx) => {
     // Handle event - code shared for both Pi and Copilot
   });
   ```
   or for Copilot-specific:
   ```typescript
   if (AGENT_TYPE === "copilot") {
     copilot.on("copilot_specific_event", async (event, ctx) => {
       // Copilot-only handler
     });
   }
   ```
3. Reload: `/reload` in Pi, or restart Copilot CLI process

### Debug Spans in Phoenix

1. Ensure Phoenix is running: `./scripts/setup-phoenix.sh --daemon`
2. Open http://localhost:6006 → **separate tabs** for projects:
   - `pi` project → Pi agent traces
   - `copilot` project → Copilot CLI traces
3. Check traces tab for recent calls
4. Click on a trace to see nested spans and attributes
5. Look for `status_code: "ERROR"` in tool spans for failures
6. Inspect span names: `pi.turn.0`, `copilot.turn.0`, `pi.tool.bash`, `copilot.tool.view`, etc.

### Inspect Lessons

**For Pi:**
```bash
cat ~/.pi/agent/pi-lessons.json     # raw JSON
/lessons                             # in Pi: formatted list
/forget-lesson <id>                  # remove one lesson
/forget-lesson --all                 # clear all lessons
```

**For Copilot CLI:**
```bash
cat ~/.copilot/copilot-lessons.json  # raw JSON (no built-in commands yet)
```

### Test Learner Analysis

**For Pi:**
```bash
/learn          # analyzes all traces in Phoenix (pi project)
/review         # analyzes current session only
```

**For Copilot CLI:**
```bash
# Manual trigger not yet implemented
# Lessons are extracted automatically after each invocation
cat ~/.copilot/copilot-lessons.json  # check extracted lessons
```

Output updates respective JSON files and logs analysis results.

## Troubleshooting

| Issue | Check |
|-------|-------|
| **Phoenix not available** | `curl http://localhost:6006/health` → should return 200. Run `./scripts/setup-phoenix.sh --daemon` |
| **Spans not appearing in Phoenix** | Check `PHOENIX_HOST` env var. Tracer logs warnings if POST fails. |
| **Learner not creating lessons** | 1) Ensure Phoenix is running. 2) Check `/lessons` output. 3) Verify LLM API key (env vars or auth.json). 4) Run `/learn` manually to check for errors. |
| **Lessons not injected into prompt** | Check `~/.pi/agent/pi-lessons.json` exists and is readable. Restart Pi. |
| **TypeScript errors** | Run `tsc --noEmit` to get full error report. |

## External Resources

- [Arize Phoenix Docs](https://docs.arize.com/phoenix) — trace query, project management
- [Pi Extension API](https://docs.pi.rocks/extensions) — event hooks, commands, context API
- [OpenTelemetry Spec](https://opentelemetry.io/docs/reference/specification/) — span structure reference
