# Aktivace Phoenix Learning Extension v Copilot CLI

Tento průvodce ti pomůže nastavit observability + self-learning do GitHub Copilot CLI v **5 krocích**.

## 🎯 Co se stane?

Po nastavení bude Copilot CLI:
- 📊 **Sledovat** každý svůj krok (prompt → response → tool calls)
- 🧠 **Učit se** ze svých chyb (analýza failures)
- 💾 **Pamatovat si** lekce (uložené v `~/.copilot/copilot-lessons.json`)
- 🔄 **Zlepšovat se** (injektuje top 8 lekcí do prompt)

---

## 📋 Krok 1: Ověř předpoklady

```bash
# Musíš mít nainstalované:
node --version    # ≥ v18
npm --version     # ≥ v9
copilot --version # ≥ 2024.1

# Zkontroluj, zda máš repozitář stažený
ls -la /root/pi-phoenix-learning/extensions/unified-phoenix-extension.ts
# Měl by existovat ✓
```

**Pokud chybí repo**, stáhni si:
```bash
git clone https://github.com/zombiegirlcz/pi-phoenix-learning.git /root/pi-phoenix-learning
# nebo
git clone git@github.com:zombiegirlcz/pi-phoenix-learning.git /root/pi-phoenix-learning
```

---

## 🔧 Krok 2: Instaluj dependencies

```bash
cd /root/pi-phoenix-learning
npm install
```

**Ověř instalaci:**
```bash
npm run type-check
# Měl by vypsat: "✓ Successfully compiled TypeScript"
# (staré extensiony budou mít chyby, ale to je OK)
```

---

## 🚀 Krok 3: Nastav Copilot extension

### Možnost A: Auto-setup (recommended)

```bash
# Přidej extension do Copilot settings.json (auto)
cat >> ~/.copilot/settings.json << 'EOF'
{
  "extensions": {
    "directories": [
      "/root/pi-phoenix-learning/extensions"
    ],
    "mode": "load_and_augment"
  }
}
EOF
```

### Možnost B: Manuální setup

1. Otevři `~/.copilot/settings.json`
2. Přidej nebo uprav `extensions` sekci:

```json
{
  "extensions": {
    "directories": [
      "/root/pi-phoenix-learning/extensions"
    ],
    "mode": "load_and_augment"
  }
}
```

3. Ulož a zavři.

**Ověř nastavení:**
```bash
cat ~/.copilot/settings.json | jq '.extensions'
# Mělo by se zobrazit:
# {
#   "directories": [
#     "/root/pi-phoenix-learning/extensions"
#   ],
#   "mode": "load_and_augment"
# }
```

---

## 🐦 Krok 4: Spusť Copilot s extension

```bash
# Restartuj všechny Copilot procesy (vyčisti cache)
pkill copilot

# Spusť Copilot - extension se automaticky načte
copilot -p "Ahoj, jsem připravený se učit"
```

**Očekávaný výstup:**
```
Ahoj, jsem připravený se učit

Changes    +0 -0
AI Credits 0.45 (19s)
Tokens     ↑ 14.7k • ↓ 412
```

Pokud vidíš odpověď bez chyb → **extension se načetl! ✓**

---

## 🧪 Krok 5: Ověř, že extension funguje

### a) Zkontroluj, že se trace posílá do Phoenix

```bash
# Spusť Phoenix (pokud neběží)
docker run -d --name phoenix -p 6006:6006 arizephoenix/phoenix:latest
# nebo
./scripts/setup-phoenix.sh --daemon

# Ověř, že Phoenix běží
curl -s http://localhost:6006/health
# Měl by vrátit: {"status":"ok"}
```

### b) Zkontroluj, že se vytvořily lekce

```bash
# Spusť nějaký Copilot úkol s chybou (např. špatná cesta):
copilot -p "Zkusit se podívat na /nonexistent/file"

# Počkej ~5-10 sekund (learner analyzuje traces)

# Zkontroluj lekce:
cat ~/.copilot/copilot-lessons.json | jq .
```

**Očekávaný výstup (JSON array s lekcemi):**
```json
[
  {
    "id": "abc1234f",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "category": "verification_failure",
    "summary": "Vždy ověř cesty souborů před přístupem",
    "detail": "Pokusil se číst /nonexistent/file bez ověření existence",
    "trace_id": "trace-xyz",
    "count": 1,
    "last_seen": "2024-01-15T10:30:00.000Z"
  }
]
```

### c) Ověř, že se lekce injektují do promptu

```bash
# Spusť Copilot s debug logsem
copilot --logLevel debug -p "Ahoj" 2>&1 | grep -i "lesson\|injecting\|learned"

# Mělo by se zobrazit:
# [INFO] Injecting 1 learned lessons into system prompt
# [DEBUG] Top lessons: [...summary of lessons...]
```

### d) Ověř traces v Phoenix UI

1. Otevři http://localhost:6006 v prohlížeči
2. Vlevo **vyber projekt "copilot"** (ne "pi")
3. Měly by se zobrazit traces z tvého Copilot běhu
4. Klikni na trace → vidíš nested spans (prompts, responses, tool calls)

---

## 📊 Co vidíš v Phoenix?

**Struktura trace:**

```
copilot.agent (CHAIN)
├── copilot.turn.0 (LLM)
│   ├── tool.bash (TOOL) - shell commands
│   ├── tool.view (TOOL) - čtení souborů
│   └── tool.edit (TOOL) - úpravy souborů
├── copilot.turn.1 (LLM)
│   └── tool.bash (TOOL)
└── copilot.turn.2 (LLM)
    └── tool.bash (TOOL)
```

**Klíčové atributy v spanech:**

```
pi.prompt              → "Tvůj zadaný prompt"
pi.assistant_response → "Copilotova odpověď"
pi.tool_name          → "bash" / "view" / "edit" / ...
pi.tool_args          → JSON argumenty tool
pi.tool_output        → "Výstup tool nebo error"
status_code           → "SUCCESS" / "ERROR"
```

---

## 🎓 Kategorie lekcí (co se Copilot učí)

| Kategorie | Popis | Příklad |
|-----------|-------|---------|
| `task_misunderstanding` | Copilot nepochopil úkol | Myslel si, že má vytvořit test, ale měl psát docs |
| `context_loss` | Zapomněl předchozí kontext | Zapomněl na předchozí variabilní jména |
| `incomplete_info` | Nedostatečná informace | Předpokládal strukturu JSON bez ověření |
| `verification_failure` | Neověřil výstup | Nezačistal output po filtru grep |
| `tool_misuse` | Špatné parametry tool | Použil `rm` bez `-r` na adresář |
| `premature_conclusion` | Odpověděl moc brzo | Říkal "hotovo", ale bylo zbývajících 3 kroky |
| `chain_error` | Kaskádový error | Jedna chyba kazila všechny dalších operace |
| `instruction_ignored` | Ignoroval instrukci | Měl zapsat do souboru, ale vypisoval |
| `other` | Ostatní chyby | Nespecifikované problémy |

---

## 🔌 Nastavení proměnných

Pokud chceš customize nastavení, přidej do `~/.bashrc` nebo `~/.zshrc`:

```bash
# Phoenix server (default: http://localhost:6006)
export PHOENIX_HOST=http://localhost:6006

# Copilot Phoenix projekt (default: copilot)
export COPILOT_PHOENIX_PROJECT=copilot

# API klíč pro Phoenix (pokud vyžaduje auth)
export PHOENIX_API_KEY=your-secret-key

# Model pro analýzu lekcí (default: aktuální Copilot model)
export COPILOT_LEARNER_MODEL=claude-3-5-sonnet

# Cesta k lekcím (default: ~/.copilot/copilot-lessons.json)
export COPILOT_LESSONS_PATH=~/.copilot/copilot-lessons.json

# Log level (debug, info, warn, error)
export COPILOT_LEARNER_LOG_LEVEL=debug
```

Pak reload:
```bash
source ~/.bashrc
```

---

## ❌ Troubleshooting

### Extension se nenačítá
```bash
# 1. Zkontroluj logs
copilot --logLevel debug 2>&1 | grep -i "error\|extension"

# 2. Ověř syntaxi settings.json
jq . ~/.copilot/settings.json

# 3. Zkontroluj cestu v settings
ls -la /root/pi-phoenix-learning/extensions/unified-phoenix-extension.ts

# 4. Restartuj Copilot
pkill copilot && sleep 2 && copilot -p "test"
```

### Phoenix není dostupný
```bash
# Zkontroluj, zda běží
curl -s http://localhost:6006/health

# Pokud ne, spusť:
docker run -d --name phoenix -p 6006:6006 arizephoenix/phoenix:latest

# Nebo se podívej do logu:
docker logs phoenix | tail -30
```

### Lekce se nevytváří
```bash
# 1. Zkontroluj, zda Phoenix má traces
curl -s http://localhost:6006/v1/projects/copilot/spans | jq . | head -20

# 2. Zkontroluj LLM auth
cat ~/.copilot/auth.json 2>/dev/null || echo "Nemáš auth.json"

# 3. Spusť manual analýzu
copilot --analyze-traces 2>&1 | tee /tmp/analyze.log

# 4. Podívej se do logu
cat /tmp/analyze.log
```

### Lekce se neinjektují do promptu
```bash
# 1. Zkontroluj obsah lekcí
cat ~/.copilot/copilot-lessons.json | jq '.[] | .summary'

# 2. Restartuj Copilot (refresh cache)
pkill copilot && sleep 2 && copilot -p "test"

# 3. Zkontroluj, že se injektují
copilot --debug -p "test" 2>&1 | grep -i "injecting"
```

### TypeScript chyby v npm run type-check
```bash
# To je OK - existují chyby ve STARÝCH extensionech (phoenix-tracer.ts, phoenix-learner.ts)
# Nový unified extension je bez chyb

# Zkontroluj jenom nový extension:
npx tsc --noEmit extensions/unified-phoenix-extension.ts --skipLibCheck
# Měl by vypsat: Status 0 (bez chyb)
```

---

## 🎯 Příkazy pro práci s lekcemi

Když máš extension aktivní, v Copilot můžeš používat:

```bash
# Zobrazit všechny lekce
copilot --show-lessons
# nebo
cat ~/.copilot/copilot-lessons.json | jq .

# Spustit manuální analýzu lekcí
copilot --analyze-traces

# Smazat jednu lekci (podle ID)
copilot --forget-lesson abc1234f

# Smazat VŠECHNY lekce
copilot --forget-all-lessons
# nebo
rm ~/.copilot/copilot-lessons.json
```

---

## 📊 Monitoring v reálném čase

Chceš vidět, co se děje? Otevři **4 terminály**:

### Terminal 1: Copilot s debug logsem
```bash
copilot --logLevel debug -p "Tvůj úkol"
```

### Terminal 2: Sleduj lekce
```bash
watch -n 1 'cat ~/.copilot/copilot-lessons.json | jq . | head -30'
```

### Terminal 3: Sleduj Phoenix traces
```bash
watch -n 3 'curl -s http://localhost:6006/v1/projects/copilot/spans | jq ".data | length"'
```

### Terminal 4: Sleduj Phoenix server
```bash
docker logs -f phoenix 2>/dev/null || echo "Phoenix neběží"
```

---

## ✅ Checklist: Máš to nastavené?

- [ ] Node.js ≥ v18
- [ ] npm ≥ v9
- [ ] Copilot CLI ≥ 2024.1
- [ ] Repository `/root/pi-phoenix-learning` existuje
- [ ] `npm install` prošel bez chyb
- [ ] `~/.copilot/settings.json` má `extensions.directories`
- [ ] Phoenix běží na `http://localhost:6006`
- [ ] `~/.copilot/copilot-lessons.json` existuje (po prvním běhu)
- [ ] Lekce se injektují do prompt (vidíš v debug logu)

---

## 📚 Další dokumentace

- **[INSTALACE_COPILOT.md](./INSTALACE_COPILOT.md)** — Detailnější instalační průvodce
- **[README.md](./README.md)** — Celkový přehled projektu
- **[IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)** — Technické detaily
- **[Arize Phoenix Docs](https://docs.arize.com/phoenix)** — Phoenix trace documentation
- **[OpenTelemetry Spec](https://opentelemetry.io/docs/reference/specification/)** — Span spec

---

## 🤝 Potřebuješ pomoc?

Pokud se něco pokazí:

1. Zkontroluj **Troubleshooting** výše
2. Sbírání diagnostiky:
   ```bash
   echo "=== Verze ===" && \
   node --version && \
   npm --version && \
   copilot --version && \
   echo "=== Settings ===" && \
   cat ~/.copilot/settings.json | jq .extensions && \
   echo "=== Lekce ===" && \
   cat ~/.copilot/copilot-lessons.json 2>/dev/null | jq . && \
   echo "=== Phoenix ===" && \
   curl -s http://localhost:6006/health
   ```
3. Podívej se do issue sekce repo (je-li GitHub)

Hodně štěstí! 🚀
