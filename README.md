# 🧠 pi-phoenix-learning

**Self-improving agents.** Traces every Pi and Copilot CLI call to [Arize Phoenix](https://phoenix.arize.com) for observability, then automatically analyzes conversations to extract lessons — so your agents get smarter over time.

```
User prompt  ──►  pi agent or copilot cli  ──►  phoenix-tracer  ──►  Phoenix (traces)
                         │
                         ▼
                   unified-phoenix-extension ◄─ reads spans
                         │
                         ▼
         pi-lessons.json or copilot-lessons.json ◄── stores lessons
                         │
                         ▼
              injected into system prompt
              before next agent call
```

## ✨ Features

| Komponenta | Popis |
|---|---|
| **🔭 phoenix-tracer** | Zachytává každé volání pi agenta nebo Copilot CLI a posílá spans do Phoenixu |
| **🧠 phoenix-learner** | Analyzuje tracy pomocí LLM, hledá chyby a ukládá ponaučení |
| **💾 Globální paměť** | Lessons se ukládají do `~/.pi/agent/pi-lessons.json` (Pi) nebo `~/.copilot/copilot-lessons.json` (Copilot) |
| **🔌 Injekce do promptu** | Před každým agent_start se lessons přidají do system promptu |
| **🔀 Unifikované rozšíření** | Jeden extension kód pro oba agenty, detekuje agenta automaticky |

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
pi install git:github.com/zombiegirlcz/pi-phoenix-learning
```

Nebo lokálně:

```bash
pi install /path/to/pi-phoenix-learning
```

### 2. Copilot CLI (experimentální)

```bash
copilot install /path/to/pi-phoenix-learning
```

### 3. Restart

```bash
/reload  # for Pi
```

## 🔧 Konfigurace

### Environment variables (Pi)

| Proměnná | Výchozí | Popis |
|---|---|---|
| `PHOENIX_HOST` | `http://localhost:6006` | Phoenix server URL |
| `PHOENIX_PROJECT` | `pi` | Název projektu v Phoenixu |
| `PHOENIX_API_KEY` | *(prázdné)* | API key pro Phoenix (volitelné) |
| `PI_LESSONS_PATH` | `~/.pi/agent/pi-lessons.json` | Vlastní cesta k Pi lessons |

### Environment variables (Copilot CLI)

| Proměnná | Výchozí | Popis |
|---|---|---|
| `PHOENIX_HOST` | `http://localhost:6006` | Phoenix server URL |
| `COPILOT_PHOENIX_PROJECT` | `copilot` | Název projektu v Phoenixu pro Copilot |
| `COPILOT_LESSONS_PATH` | `~/.copilot/copilot-lessons.json` | Vlastní cesta k Copilot lessons |
| `PHOENIX_API_KEY` | *(prázdné)* | API key pro Phoenix (volitelné) |

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
├── package.json                      # Pi/Copilot package manifest
├── tsconfig.json                     # TypeScript configuration
├── README.md                         # Tento soubor
├── LICENSE                           # MIT
├── .gitignore
├── extensions/
│   ├── unified-phoenix-extension.ts  # Unifikované extension (Pi + Copilot)
│   ├── phoenix-tracer.ts             # Original Pi tracing extension
│   └── phoenix-learner.ts            # Original Pi learning extension
├── lib/
│   ├── span-builder.ts               # Shared span building utilities
│   ├── phoenix-api.ts                # Multi-project Phoenix API
│   ├── lesson-storage.ts             # Lesson persistence
│   ├── llm-provider.ts               # Provider-agnostic LLM calls
│   └── lesson-analyzer.ts            # Conversation analysis & extraction
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

## 🦅 GitHub Copilot CLI Support

Stejné tracing + learning capabilities jsou dostupné i pro **GitHub Copilot CLI** (ne VS Code, jen CLI).

### Setup v 5 krocích

```bash
# 1. Stáhni repository
git clone https://github.com/zombiegirlcz/pi-phoenix-learning.git /root/pi-phoenix-learning

# 2. Instaluj dependencies
cd /root/pi-phoenix-learning && npm install

# 3. Přidej extension do Copilot settings.json
jq '.extensions.directories += ["/root/pi-phoenix-learning/extensions"] |
    .extensions.mode = "load_and_augment"' \
  ~/.copilot/settings.json > ~/.copilot/settings.json.tmp && \
  mv ~/.copilot/settings.json.tmp ~/.copilot/settings.json

# 4. Spusť Phoenix server
docker run -d --name phoenix -p 6006:6006 arizephoenix/phoenix:latest

# 5. Restartuj Copilot
pkill copilot
copilot -p "Ahoj, jsem připravený se učit"
```

### Ověření

```bash
# Zkontroluj, zda se vytv ořily lekce
cat ~/.copilot/copilot-lessons.json | jq .

# Zkontroluj Phoenix UI
curl -s http://localhost:6006/v1/projects/copilot/spans | jq '.data | length'

# Měl bys vidět traces v http://localhost:6006 → projekt "copilot"
```

### Copilot vs. Pi: Oddělená úložiště

| Komponenta | Pi | Copilot |
|---|---|---|
| **Lekce** | `~/.pi/agent/pi-lessons.json` | `~/.copilot/copilot-lessons.json` |
| **Phoenix projekt** | `pi` | `copilot` |
| **Env prefix** | `PHOENIX_` | `COPILOT_` |
| **Extension** | via `pi install` | via settings.json |

Copilot se **učí svou vlastní historií**, nezavírá se jím lekce z Pi a naopak.

### Troubleshooting Copilot

```bash
# Extension se nenačítá?
copilot --logLevel debug -p "test" 2>&1 | grep -i "error\|extension"

# Lekce se nevytváří?
curl -s http://localhost:6006/v1/projects/copilot/spans | jq '.data | length'

# Ověř auth pro LLM
cat ~/.copilot/auth.json 2>/dev/null | jq .

# Všechny lekce vyresetuj
rm ~/.copilot/copilot-lessons.json
```

**Přečti si podrobný průvodce:** [SETUP_GUIDE_CZ.md](./SETUP_GUIDE_CZ.md)

## 📊 Phoenix UI

Otevři http://localhost:6006 — uvidíš oddělené projekty:

- **Pi project** (`pi`) — traces pro Pi agent
- **Copilot project** (`copilot`) — traces pro Copilot CLI

V každém projektu:
- Každý request = jedna trace
- Spans: agent (CHAIN) → turn (LLM) → tool calls (TOOL)
- V atributech: prompt, odpověď, tool vstup/výstup, token counts

## 📜 License

MIT
