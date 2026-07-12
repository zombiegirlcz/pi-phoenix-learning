# Instalace Phoenix rozšíření pro Copilot CLI

## Metoda 1: Instalace z lokálního adresáře (Development)

```bash
# Naviguj do adresáře projektu
cd /path/to/pi-phoenix-learning

# Instaluj plugin
copilot plugin install .

# Ověř instalaci
copilot plugins list --kind extensions
```

Výstup by měl zobrazit:
```
Extensions
  pi-phoenix-learning  (local)
```

## Metoda 2: Instalace z Git repozitáře

```bash
# Instaluj z GitHub repozitáře
copilot plugin install git:github.com/pi-phoenix-learning/pi-phoenix-learning

# Ověř instalaci
copilot plugins list
```

## Metoda 3: Instalace z GitHub organizace/uživatele

```bash
# Pokud je plugin v awesome-copilot marketplace
copilot plugin install awesome-copilot/pi-phoenix-learning
```

## Ověření Instalace

```bash
# Vypis všech instalovaných pluginů
copilot plugins list

# Vypis jen rozšíření
copilot plugins list --kind extensions

# Vypis konfigurací
copilot plugins list --scope user
```

## Ověření Funkcionalit

```bash
# 1. Zkontroluj, že se načítá
copilot -p "Hello" 2>&1 | grep -i phoenix

# 2. Zkontroluj Phoenix projekt
cat ~/.copilot/copilot-lessons.json 2>/dev/null || echo "Lessons file not created yet"

# 3. Zkontroluj Phoenix traces
curl -s http://localhost:6006/v1/projects/copilot/spans | jq '.' 2>/dev/null | head -20
```

## Nastavení Prostředí

Přidej do `~/.bashrc`, `~/.zshrc` nebo `~/.profile`:

```bash
# Phoenix Tracing for Copilot CLI
export PHOENIX_HOST=http://localhost:6006
export COPILOT_PHOENIX_PROJECT=copilot
export COPILOT_LESSONS_PATH=~/.copilot/copilot-lessons.json
```

## Spuštění Phoenix Serveru

```bash
# Start Phoenix v background
python3 -m phoenix.server.main --port 6006 &

# Nebo pomocí setup skriptu z projektu
cd /path/to/pi-phoenix-learning
./scripts/setup-phoenix.sh --daemon

# Ověř, že běží
curl -s http://localhost:6006/health
```

## Konfigurace (Volitelné)

### Soubor: `~/.copilot/copilot-extensions.json`

```json
{
  "extensions": {
    "pi-phoenix-learning": {
      "enabled": true,
      "config": {
        "phoenix_host": "http://localhost:6006",
        "phoenix_project": "copilot",
        "lessons_path": "~/.copilot/copilot-lessons.json"
      }
    }
  }
}
```

## Odinstalace

```bash
# Odinstaluj plugin
copilot plugin uninstall pi-phoenix-learning

# Ověř
copilot plugins list
```

## Troubleshooting

### Plugin se nenačítá

```bash
# Zkontroluj chyby v logech
cat ~/.copilot/logs/agent.log | tail -50

# Zkontroluj, že package.json má správné pole
cat package.json | jq '.copilot'

# Spusť debug režim
copilot -p "test" --verbose 2>&1 | tail -20
```

### Phoenix není dostupný

```bash
# Zkontroluj, že server běží
curl -s http://localhost:6006/health

# Start Phoenix, pokud není spuštěný
python3 -c "import phoenix; phoenix.serve(port=6006)"
```

### Lessons se neukládají

```bash
# Zkontroluj oprávnění
ls -la ~/.copilot/
chmod 755 ~/.copilot

# Zkontroluj, že Copilot má přístup
touch ~/.copilot/test.json && rm ~/.copilot/test.json && echo "OK"
```

## Příklady Použití

```bash
# 1. Začni konverzaci s Copilot (extension se automaticky spustí)
copilot

# 2. Spusť jeden příkaz (bez interakce)
copilot -p "Help me debug this bash script" < script.sh

# 3. Spusť s povolením všech nástrojů
copilot --allow-all-tools -p "Refactor this file" < file.ts

# 4. Spusť s konkrétním adresářem
copilot --add-dir ./src -p "Analyze all TypeScript files"
```

## Co se Děje V Pozadí

Když spustíš Copilot s aktivním rozšířením:

1. **before_agent_start** → Rozšíření se inicializuje
   - Načte top 8 lessons z `~/.copilot/copilot-lessons.json`
   - Injektuje je do system promptu

2. **Během konverzace** → Tracer zachytává:
   - Tvůj prompt
   - Copilotovu odpověď
   - Všechny tool volání (bash, file edits, searches...)

3. **agent_end** → Learner analyzuje:
   - Posílá spans do Phoenix (`copilot` projektu)
   - Čeká 3 sekundy na ingestion
   - Stáhne spans a analyzuje chyby
   - Extrahuje nové lessons a uloží do JSON

4. **Další běh** → Lessons se injektují znova
   - Copilot se učí z minulých chyb
   - Vylepšuje se automaticky

## Ověření V Phoenix UI

1. Otevři http://localhost:6006
2. Klikni na projekt **`copilot`** (ne `pi`)
3. Měl by zobrazit traces z tvých Copilot relací
4. Klikni na trace → uvidíš nested spans:
   - `copilot.agent` (CHAIN)
   - `copilot.turn.0` (LLM response)
   - `copilot.tool.bash`, `copilot.tool.view` (tool calls)

## Další Kroky

- [ ] Instalovat plugin
- [ ] Spustit Phoenix server
- [ ] Vyzkoušet s Copilot CLI
- [ ] Ověřit spans v Phoenix UI
- [ ] Zkontrolovat lessons v `~/.copilot/copilot-lessons.json`
- [ ] Vyzkoušet s jinou úlohou a vidět, jak se lessons injektují
