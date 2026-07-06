# 🧠 pi-phoenix-learning

**Self-improving Pi agent.** Traces every agent call to [Arize Phoenix](https://phoenix.arize.com) for observability, then automatically analyzes conversations to extract lessons — so your agent gets smarter over time.

```
User prompt  ──►  pi agent  ──►  phoenix-tracer  ──►  Phoenix (traces)
                         │
                         ▼
                   phoenix-learner ◄────── reads spans
                         │
                         ▼
              pi-lessons.json ◄────── stores lessons
                         │
                         ▼
              injected into system prompt
              before next agent call
```

## ✨ Features

| Komponenta | Popis |
|---|---|
| **🔭 phoenix-tracer** | Zachytává každé volání pi agenta a posílá spans do Phoenixu |
| **🧠 phoenix-learner** | Analyzuje tracy pomocí LLM, hledá chyby a ukládá ponaučení |
| **💾 Globální paměť** | Lessons se ukládají do `~/.pi/agent/pi-lessons.json` |
| **🔌 Injekce do promptu** | Před každým agent_start se lessons přidají do system promptu |

### Sledované kategorie chyb

| Ikona | Kategorie | Příklad |
|---|---|---|
| 🎯 | Nepochopení úkolu | Agent dělá něco jiného, než bylo zadáno |
| 🔄 | Ztráta kontextu | Zapomene co se řešilo o pár turnů dřív |
| 🔍 | Neúplné informace | Dělá domněnky místo ověření |
| ✅ | Neověření výsledků | Nezkusí, jestli kód funguje |
| 🔧 | Špatné použití nástrojů | Volání bash bez argumentů |
| ⚡ | Předčasný závěr | Odpoví bez dostatku dat |
| ⛓️ | Řetězení chyb | Jedna chyba vede k dalším |
| ⚠️ | Ignorování instrukcí | System prompt nebo user požadavek |

## 📦 Instalace

### 1. Phoenix server

Nejjednodušší (Python):

```bash
pip install arize-phoenix
# nebo
uv tool install arize-phoenix
```

Spuštění:

```bash
# foreground
phoenix serve

# background
./scripts/setup-phoenix.sh --daemon
```

Ověř že běží: `curl http://localhost:6006/health` → `200`

### 2. Pi package

```bash
pi install git:github.com/pi-phoenix-learning/pi-phoenix-learning
```

Nebo lokálně:

```bash
pi install /path/to/pi-phoenix-learning
```

### 3. Restart pi

```bash
/reload
# nebo spusť pi znovu
```

## 🔧 Konfigurace

### Environment variables

| Proměnná | Výchozí | Popis |
|---|---|---|
| `PHOENIX_HOST` | `http://localhost:6006` | Phoenix server URL |
| `PHOENIX_PROJECT` | `pi` | Název projektu v Phoenixu |
| `PHOENIX_API_KEY` | *(prázdné)* | API key pro Phoenix (volitelné) |
| `PHOENIX_LEARNER_MODEL` | *(aktuální model v pi)* | Model pro LLM analýzu (přepíše automatický výběr) |

### Pi settings (`~/.pi/agent/settings.json`)

```json
{
  "packages": [
    "git:github.com/pi-phoenix-learning/pi-phoenix-learning"
  ]
}
```

Viz `config/pi-settings.example.json`.

## 📋 Příkazy

Po instalaci máš k dispozici tyhle `/` příkazy:

| Příkaz | Popis |
|---|---|
| `/learn` | Ručně spustí analýzu posledních traceů z Phoenixu |
| `/lessons` | Zobrazí všechny uložené lessons |
| `/forget-lesson <id>` | Smaže jednu lesson podle ID |
| `/forget-lesson --all` | Smaže všechny lessons |
| `/review` | Analyzuje aktuální konverzaci (aktuální session) |

## 🧪 Jak to funguje v praxi

### Automatický režim

1. **Po každém agent volání** (`agent_end`):
   - Počká 3s (než se spans ingestnou)
   - Stáhne poslední trace z Phoenixu
   - Provede heuristickou analýzu (tool errors)
   - Pošle konverzaci LLM na behaviorální analýzu
   - Uloží nové lessons do `pi-lessons.json`

2. **Před každým agent voláním** (`before_agent_start`):
   - Načte lessons z `pi-lessons.json`
   - 8 nejčastějších/chybovějších přidá do system promptu
   - Agent ví, na co si dát pozor

### Ruční režim

```bash
/learn          # projde celou historii traceů a extrahuje lessons
/lessons        # zobrazí co všechno už agent ví
/review         # analyzuje právě probíhající konverzaci
```

## 🏗️ Struktura balíčku

```
pi-phoenix-learning/
├── package.json                      # Pi package manifest
├── README.md                         # Tento soubor
├── LICENSE                           # MIT
├── .gitignore
├── extensions/
│   ├── phoenix-tracer.ts             # Tracing extension
│   └── phoenix-learner.ts            # Learning extension
├── scripts/
│   └── setup-phoenix.sh              # Phoenix server launcher
└── config/
    └── pi-settings.example.json      # Ukázkové nastavení
```

## 🔗 Závislosti

- **Pi** >= 0.78.0 (extension API)
- **Arize Phoenix** — viz výše (Python package)
- **API klíč** pro LLM analýzu — použije se provider/model který máš aktivní v pi
- Podporovaní: OpenCode, OpenAI, Anthropic, Kilo, Google, Ollama, nebo vlastní přes `OPENAI_BASE_URL`

## 🩺 Troubleshooting

**Phoenix není dostupný:**
```bash
./scripts/setup-phoenix.sh --status
./scripts/setup-phoenix.sh --daemon
```

**Tracy se neposílají:**
Zkontroluj `PHOENIX_HOST` proměnnou. Výchozí je `http://localhost:6006`.

**Learner neanalyzuje:**
1. Zkus `/learn` ručně
2. Zkontroluj `pi-lessons.json`: `cat ~/.pi/agent/pi-lessons.json`
3. Ověř API klíč: `echo $OPENCODE_API_KEY`

## 📊 Phoenix UI

Otevři http://localhost:6006 — uvidíš projekt `pi` se všemi tracy:

- Každý agent request = jedna trace
- Spans: agent (CHAIN) → turn (LLM) → tool calls (TOOL)
- V atributech: prompt, odpověď, tool vstup/výstup, token counts

## 📜 License

MIT
