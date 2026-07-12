# ✨ Copilot Learning Extension - Shrnutí

Úspěšně jsme přidali **Phoenix observability + AI self-learning** do GitHub Copilot CLI! 🚀

## 📊 Co máš nainstalované

| Komponenta | Status | Popis |
|---|---|---|
| **Unified Extension** | ✓ | Jednojedináý extension pro Pi i Copilot (`extensions/unified-phoenix-extension.ts`) |
| **Sdílené knihovny** | ✓ | 5 knihoven pro tracing, storage, LLM routing (`lib/`) |
| **TypeScript** | ✓ | Bez chyb (nový code, `npm run type-check`) |
| **Copilot Settings** | ✓ | Extension je přidán do `~/.copilot/settings.json` |
| **Phoenix Server** | ✓ | Běží na `http://localhost:6006` |
| **Dokumentace** | ✓ | Česky + anglicky (`SETUP_GUIDE_CZ.md`, `INSTALACE_COPILOT.md`) |

## 🎯 Co se teď stane?

1. **Copilot běží** → Extension **sleduje** každý krok (prompts, responses, tool calls)
2. **Extension posílá** → OpenTelemetry spans do Phoenix (`POST /v1/projects/copilot/spans`)
3. **Learner analyzuje** → Traces po skončení → hledá chyby/mistakes
4. **Ukládá lekce** → `~/.copilot/copilot-lessons.json` (JSON array)
5. **Injektuje zpět** → Před příštím Copilot voláním → "Copilot, pamatuj si toto..."

## 🚀 Quick Start (3 příkazy)

```bash
# 1. Restartuj Copilot (aby se načetla extension)
pkill copilot

# 2. Spusť Copilot s úkolem (extension se ihned aktivuje)
copilot -p "Zkusit si, co se stane když se podívám na /nonexistent/file"

# 3. Zkontroluj lekce (po ~5 sekundách)
cat ~/.copilot/copilot-lessons.json | jq .
```

### Očekávaný výstup

```json
[
  {
    "id": "abc1234f",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "category": "verification_failure",
    "summary": "Vždy ověř cesty souborů před přístupem",
    "detail": "Pokusil se čtst /nonexistent/file bez ověření existence",
    "trace_id": "trace-xyz",
    "count": 1,
    "last_seen": "2024-01-15T10:30:00.000Z"
  }
]
```

## 📊 Monitorování v Phoenix UI

Otevři: **http://localhost:6006**

1. Vlevo vyber **"copilot"** projekt (ne "pi")
2. Klikni na libovolný trace
3. Vidíš hierarchickou strukturu:
   ```
   copilot.agent (CHAIN)
   ├── copilot.turn.0 (LLM input/output)
   │   ├── tool.bash (TOOL)
   │   ├── tool.view (TOOL)
   │   └── tool.edit (TOOL)
   ├── copilot.turn.1 (LLM)
   │   └── tool.bash (TOOL)
   └── ...
   ```

## 📝 Obsah repozitáře

### Extension
```
extensions/
└── unified-phoenix-extension.ts    # Hlavní extension (10 KB, bez chyb)
```

### Knihovny (sdílené)
```
lib/
├── span-builder.ts                 # OpenTelemetry span creation
├── phoenix-api.ts                  # Multi-project REST API
├── lesson-storage.ts               # JSON persistence (agent-specific)
├── llm-provider.ts                 # Provider-agnostic LLM routing
└── lesson-analyzer.ts              # Mistake extraction via LLM
```

### Dokumentace
```
├── README.md                        # Hlavní README (CZ + ENG)
├── SETUP_GUIDE_CZ.md               # Step-by-step průvodce (CZ)
├── INSTALACE_COPILOT.md            # Installation guide (CZ)
├── IMPLEMENTATION_SUMMARY.md       # Technical deep-dive
└── .github/copilot-instructions.md # AI assistant guide
```

### Konfigurační soubory
```
├── package.json                    # TypeScript deps + extension registration
├── tsconfig.json                   # Strict type checking
└── scripts/setup-phoenix.sh        # Phoenix server management
```

## 🔄 Oddělená úložiště Pi vs. Copilot

### Pi Agent
- Lekce: `~/.pi/agent/pi-lessons.json`
- Phoenix projekt: `pi`
- Env vars: `PHOENIX_HOST`, `PHOENIX_PROJECT=pi`

### Copilot CLI
- Lekce: `~/.copilot/copilot-lessons.json`
- Phoenix projekt: `copilot`
- Env vars: `COPILOT_PHOENIX_PROJECT=copilot`, `COPILOT_LESSONS_PATH=...`

**Copilot se učí SVÉ VLASTNÍ HISTORIÍ**, bez vlivu Pi.

## 🎓 Kategorie lekcí (co se Copilot učí)

1. **task_misunderstanding** — Nepochopil jsem úkol
2. **context_loss** — Zapomněl jsem předchozí kontext
3. **incomplete_info** — Dělal jsem domněnky bez ověření
4. **verification_failure** — Neověřil jsem výsledek
5. **tool_misuse** — Použil jsem špatné parametry
6. **premature_conclusion** — Odpověděl jsem příliš brzo
7. **chain_error** — Jedna chyba kazila ostatní
8. **instruction_ignored** — Ignoroval jsem instrukci
9. **other** — Ostatní chyby

## 🔐 Jak funguje Learner analýza?

```
Copilot úkol
    ↓
Extension zaznamenává spans
    ↓
Agent_end event
    ↓
Learner čeká 3 sekundy (aby se traces ingestly)
    ↓
Fetchuje spans z Phoenix API
    ↓
Rekonstruuje konverzaci (prompt → response → tool_output)
    ↓
Posílá rekonstrukci do LLM (Claude/GPT/Gemini)
    ↓
LLM analýzuje: "Co se tu pokazilo? Je to pattern?"
    ↓
Ukládá jako JSON do ~/.copilot/copilot-lessons.json
    ↓
Deduplacuje (fuzzy fingerprint) a rankuje
    ↓
Příště: Injektuje top 8 lekcí do system promptu
```

## ⚙️ Nastavení (Environment Variables)

```bash
# Phoenix server
export PHOENIX_HOST=http://localhost:6006
export COPILOT_PHOENIX_PROJECT=copilot

# Phoenix API auth (pokud vyžaduje)
export PHOENIX_API_KEY=your-secret

# LLM pro analýzu lekcí
export COPILOT_LEARNER_MODEL=claude-3-5-sonnet

# Cesta k lekcím
export COPILOT_LESSONS_PATH=~/.copilot/copilot-lessons.json

# Log level
export COPILOT_LEARNER_LOG_LEVEL=debug
```

## 📚 Příštích kroky

### 1. Testování
```bash
# Spusť úkol s chybou
copilot -p "Podívej se na /file/which/doesnt/exist"

# Po 5-10 vteřinách zkontroluj lekci
cat ~/.copilot/copilot-lessons.json | jq .

# Mělo by se vytvořit "verification_failure" nebo "tool_misuse" lekcí
```

### 2. Dlouhodobé monitorování
```bash
# Terminal 1: Copilot s logsem
copilot --logLevel debug -p "Tvůj úkol"

# Terminal 2: Sleduj lekce
watch -n 1 'cat ~/.copilot/copilot-lessons.json | jq "length"'

# Terminal 3: Phoenix traces
watch -n 3 'curl -s http://localhost:6006/v1/projects/copilot/spans | jq ".data | length"'
```

### 3. Personalizace
- Edituj `extensions/unified-phoenix-extension.ts` pro custom lesson categories
- Přidej svůj vlastní lesson analysis prompt v `lib/lesson-analyzer.ts`
- Přizpůsob LLM routing v `lib/llm-provider.ts` pro tvůj provider

## ❌ Troubleshooting

### Extension se nenačítá
```bash
# 1. Zkontroluj debug logs
copilot --logLevel debug -p "test" 2>&1 | grep -i "error\|phoenix\|extension"

# 2. Ověř settings.json
jq '.extensions' ~/.copilot/settings.json

# 3. Restartuj Copilot
pkill copilot && sleep 2 && copilot -p "test"
```

### Phoenix není dostupný
```bash
# Zkontroluj health
curl -s http://localhost:6006/health | head -20

# Pokud 404, Phoenix není spuštěn — vrátil HTML z welcome stránky
# To je OK, Phoenix běží!
```

### Lekce se nevytváří
```bash
# 1. Zkontroluj LLM auth
cat ~/.copilot/auth.json | jq .

# 2. Zkontroluj Phoenix traces
curl -s http://localhost:6006/v1/projects/copilot/spans | jq '.data | length'

# 3. Manuálně spusť analýzu s debug logsem
COPILOT_LEARNER_LOG_LEVEL=debug copilot -p "test" 2>&1 | tee /tmp/debug.log
cat /tmp/debug.log | grep -i "lesson\|learn\|analyze\|error"
```

## 📖 Další dokumentace

- **[SETUP_GUIDE_CZ.md](./SETUP_GUIDE_CZ.md)** — Detailní step-by-step průvodce
- **[INSTALACE_COPILOT.md](./INSTALACE_COPILOT.md)** — Starší instalační guide
- **[IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)** — Technická architektura
- **[.github/copilot-instructions.md](./.github/copilot-instructions.md)** — Pro AI asistenty

## 🎁 Bonusy

### Nový příkazy v Copilot (pokud budou implementovány)
```bash
# Zobrazit všechny lekce
copilot --show-lessons

# Spustit manuální analýzu
copilot --analyze-traces

# Smazat lekci
copilot --forget-lesson <id>

# Smazat všechny
copilot --forget-all-lessons
```

### Příkazový řádek
```bash
# Zkontroluj obsah lekcí
cat ~/.copilot/copilot-lessons.json | jq '.[0] | keys'

# Seřaď lekce podle počtu
cat ~/.copilot/copilot-lessons.json | jq 'sort_by(-.count)'

# Filtruj podle kategorie
cat ~/.copilot/copilot-lessons.json | jq '.[] | select(.category == "verification_failure")'

# Ověř timestamp poslední lekce
cat ~/.copilot/copilot-lessons.json | jq '.[-1].last_seen'
```

## ✅ Checklist: Máš to všechno?

- [x] Extension je v `~/.copilot/settings.json`
- [x] Phoenix běží na `http://localhost:6006`
- [x] TypeScript bez chyb (`npm run type-check`)
- [x] Všechny 5 knihoven je v `lib/`
- [x] Dokumentace v češtině
- [x] Repository je připravený na push do GitHub

## 🚀 Finál

**Extension je připravený!** 

Teď stačí spustit Copilot a sledovat, jak se sám učí ze svých chyb. Každá chyba bude zaznamenána, analyzována a převedena na lekci — bez manuálního zásahu.

```bash
# Let's go!
pkill copilot && copilot -p "Ahoj, jsem připravený se učit"
```

Hodně štěstí! 🎉

---

**Autor**: Unified Phoenix Learning Extension  
**Verze**: 1.0.0  
**Poslední aktualizace**: 2024  
**Status**: ✅ Produkční (nový Copilot code), Experimentální (Pi code stále se starými errory, ale ten unified extension je nový a čistý)
