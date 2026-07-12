# Instalace pi-phoenix-learning do GitHub Copilot CLI

Tato příručka popisuje, jak přidat observability a self-learning extension do GitHub Copilot CLI.

## Přehled

Rozšíření **phoenix-tracer + learner** sleduje každý krok Copilota, posílá traces do Phoenix a automaticky vytvářím lekce ze chyb. Copilot se učí ze svých chyb a neusílí stejné kroky.

- 📊 **Tracing**: Každý prompt, response, tool call se pošle do Arize Phoenix
- 🧠 **Learning**: Analýza chyb → lekce uložené v `~/.copilot/copilot-lessons.json`
- 🔄 **Auto-injection**: Top 8 lekcí se vloží do system prompts automaticky
- 🎯 **Separate storage**: Copilot lekce odděleny od Pi lekcí

## Instalace

### 1. **Krok 1: Nainstaluj balíček**

```bash
# Přidej repositář do ~/.copilot/ nebo jiného umístění
git clone https://github.com/<owner>/<repo>.git ~/.copilot/pi-phoenix-learning

# nebo pokud máš lokální cestu:
npm install --prefix ~/.copilot/pi-phoenix-learning
```

### 2. **Krok 2: Přidej extension do Copilot settings.json**

```bash
# Otevři ~/.copilot/settings.json a přidej extension:
jq '.extensions.directories += ["/root/pi-phoenix-learning/extensions"]' ~/.copilot/settings.json > ~/.copilot/settings.json.tmp
mv ~/.copilot/settings.json.tmp ~/.copilot/settings.json

# Ověř:
cat ~/.copilot/settings.json | jq '.extensions'
```

Mělo by to vypadat takto:
```json
{
  "extensions": {
    "mode": "load_and_augment",
    "directories": [
      "/root/pi-phoenix-learning/extensions"
    ],
    "load_order": [
      "./extensions/unified-phoenix-extension.ts"
    ]
  }
}
```

### 3. **Krok 3: Restartuj Copilot**

```bash
# Zavřít všechny běžící session
pkill copilot

# Spustit nový Copilot (extension se načte automaticky)
copilot -p "Ahoj"
```

## Ověření instalace

### 1. Zkontroluj logs
```bash
# Kopilot by měl najít extension
copilot --debug 2>&1 | grep -i "phoenix\|extension\|unified"

# Mělo by se zobrazit:
# [INFO] Loading extension: ./extensions/unified-phoenix-extension.ts
# [INFO] Phoenix tracer initialized for copilot project
```

### 2. Ověř Phoenix traces
```bash
# Spusť Phoenix (pokud už neběží)
docker run --rm -p 6006:6006 arizephoenix/phoenix:latest

# Otevři https://localhost:6006 v prohlížeči
# Měl by existovat projekt "copilot"
```

### 3. Zkontroluj lekce
```bash
# Po prvním Copilot běhu by měl vzniknout soubor:
ls -la ~/.copilot/copilot-lessons.json

# Měl by obsahovat extrakt chyb:
cat ~/.copilot/copilot-lessons.json | jq .
```

## Proměnné prostředí

Nastav tyto proměnné pro customizaci:

```bash
# Phoenix server URL (default: http://localhost:6006)
export PHOENIX_HOST=http://localhost:6006

# Projekt v Phoenix pro Copilot (default: copilot)
export COPILOT_PHOENIX_PROJECT=copilot

# API klíč pro Phoenix (pokud vyžaduje auth)
export PHOENIX_API_KEY=your-api-key

# LLM pro analýzu lekcí (default: aktuální Copilot model)
export COPILOT_LEARNER_MODEL=claude-3-haiku

# Cesta k souboru lekcí (default: ~/.copilot/copilot-lessons.json)
export COPILOT_LESSONS_PATH=~/.copilot/copilot-lessons.json
```

## Struktura lekcí

Lekce jsou uloženy v `~/.copilot/copilot-lessons.json`:

```json
[
  {
    "id": "abc1234f",
    "timestamp": "2024-07-12T10:30:00.000Z",
    "category": "verification_failure",
    "summary": "Vždy ověř cesty souborů před zápisem",
    "detail": "Pokusil se zapsat do /nonexistent/path bez ověření existence",
    "trace_id": "deadbeef...",
    "count": 3,
    "last_seen": "2024-07-12T10:30:00.000Z"
  }
]
```

### Kategorie lekcí

- `task_misunderstanding` — Copilot nepochopil úkol
- `context_loss` — Zapomněl předchozí kontext
- `incomplete_info` — Dělal předpoklady bez ověření
- `verification_failure` — Neověřil výstup tool
- `tool_misuse` — Špatné argumenty/flags tool
- `premature_conclusion` — Odpověděl příliš brzy
- `chain_error` — Jedna chyba vyvolala další
- `instruction_ignored` — Ignoroval instrukci
- `other` — Ostatní chyby

## Troubleshooting

### Phoenix není dostupný
```bash
# Zkontroluj, zda Phoenix běží
curl http://localhost:6006/health

# Pokud ne, spusť:
docker run --rm -p 6006:6006 arizephoenix/phoenix:latest

# Nastav správný PHOENIX_HOST:
export PHOENIX_HOST=http://localhost:6006
```

### Extension se nenačítá
```bash
# 1. Zkontroluj logs
copilot --debug 2>&1 | grep -i "error\|extension"

# 2. Ověř cestu v settings.json
cat ~/.copilot/settings.json | jq '.extensions.directories'

# 3. Zkontroluj oprávnění
ls -la /root/pi-phoenix-learning/extensions/unified-phoenix-extension.ts

# 4. Restartuj Copilot (zkažený cache)
pkill copilot && sleep 2 && copilot -p "test"
```

### Lekce se nevytváří
```bash
# 1. Zkontroluj, zda Phoenix má traces
curl http://localhost:6006/v1/projects/copilot/spans | jq .

# 2. Zkontroluj logs Copilot
copilot --logLevel debug 2>&1 | grep -i "lesson\|learn\|analyze"

# 3. Ověř LLM auth
cat ~/.pi/agent/auth.json | jq .  # auth konfig

# 4. Zkontroluj oprávnění ~/.copilot/
ls -la ~/.copilot/
chmod 755 ~/.copilot
```

### Lekce se neinjektují do promptu
```bash
# 1. Zkontroluj, zda lekce existují
cat ~/.copilot/copilot-lessons.json

# 2. Zkontroluj, zda extension vidí lekce
copilot --debug 2>&1 | grep -i "injecting\|lesson"

# 3. Restartuj Copilot (refresh cache)
pkill copilot && sleep 2 && copilot -p "test"
```

## Příkazy v Copilot CLI

Když je extension aktivní, máš přístup k příkazům:

```bash
# Zobrazit všechny lekce
/lessons

# Spustit analýzu lekcí (manuálně)
/learn

# Odstranit jednu lekci
/forget-lesson <id>

# Smazat všechny lekce
/forget-lesson --all
```

## Architecture

Extension je dělena na:

### Knihovny (`lib/`)
- **span-builder.ts** — vytváření OpenTelemetry spans
- **phoenix-api.ts** — komunikace s Phoenix API
- **lesson-storage.ts** — ukládání/načítání lekcí
- **llm-provider.ts** — rozhraní k LLM (Anthropic, OpenAI, Google, atd.)
- **lesson-analyzer.ts** — analýza chyb a vytváření lekcí

### Extension (`extensions/`)
- **unified-phoenix-extension.ts** — hlavní extension (Pi + Copilot)

## Separace Pi × Copilot

| Komponenta | Pi | Copilot |
|-----------|----|---------| 
| Lekce | `~/.pi/agent/pi-lessons.json` | `~/.copilot/copilot-lessons.json` |
| Phoenix projekt | `pi` | `copilot` |
| Env prefix | `PHOENIX_` | `COPILOT_` |
| Traces | http://localhost:6006/pi | http://localhost:6006/copilot |

Lekce ze Pi se NEZNAČUJÍ do Copilot a naopak — každý agent si uchovává vlastní learnings.

## Development

### Spuštění type-check
```bash
npm run type-check
```

### Modifikace extension
1. Edituj `extensions/unified-phoenix-extension.ts` nebo `lib/*.ts`
2. Restartuj Copilot: `pkill copilot`
3. Spusť znovu: `copilot -p "test"`

### Debug Phoenix traces
1. Otevři http://localhost:6006
2. Vyber projekt "copilot"
3. Klikni na trace pro detaily
4. Hledej `status_code: ERROR` v tool spans

## Další zdroje

- [Arize Phoenix Docs](https://docs.arize.com/phoenix)
- [Pi Extension API](https://docs.pi.rocks/extensions)
- [OpenTelemetry Spec](https://opentelemetry.io/docs/reference/specification/)
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/copilot-cli/about-github-copilot-cli)
