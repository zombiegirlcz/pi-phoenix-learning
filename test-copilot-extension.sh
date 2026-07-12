#!/bin/bash
#
# Ověřovací script pro pi-phoenix-learning Copilot extension
# Spusť: ./test-copilot-extension.sh
#

set -e

echo "🧪 Ověřování pi-phoenix-learning Copilot extension..."
echo ""

# Barvy pro output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Počítadlo testů
PASSED=0
FAILED=0

# Helper funkce
test_check() {
  local test_name=$1
  local command=$2
  echo -n "Testování: $test_name ... "
  
  if eval "$command" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((PASSED++))
  else
    echo -e "${RED}✗ FAILED${NC}"
    ((FAILED++))
  fi
}

# ============================================================================
# 1. PŘEDPOKLADY
# ============================================================================
echo -e "${BLUE}1️⃣  PŘEDPOKLADY${NC}"
echo "===================="

test_check "Node.js ≥ v18" 'node --version | grep -E "v(1[89]|[2-9][0-9])"'
test_check "npm ≥ v9" 'npm --version | grep -E "^[9]|^[1-9][0-9]"'
test_check "Copilot CLI nainstalován" 'command -v copilot'
test_check "Repository existuje" 'test -d /root/pi-phoenix-learning'
test_check "Extension file existuje" 'test -f /root/pi-phoenix-learning/extensions/unified-phoenix-extension.ts'

echo ""

# ============================================================================
# 2. DEPENDENCES
# ============================================================================
echo -e "${BLUE}2️⃣  DEPENDENCE (npm)${NC}"
echo "===================="

test_check "package.json existuje" 'test -f /root/pi-phoenix-learning/package.json'
test_check "node_modules existují" 'test -d /root/pi-phoenix-learning/node_modules'

echo ""

# ============================================================================
# 3. TYPESCRIPT TYPE CHECK
# ============================================================================
echo -e "${BLUE}3️⃣  TYPESCRIPT TYPE CHECK${NC}"
echo "========================"

cd /root/pi-phoenix-learning || exit 1

# Zkontroluj pouze nový unified extension (ignoruj stary code)
echo -n "Testování: Unified extension TypeScript syntax ... "
if npx tsc --noEmit extensions/unified-phoenix-extension.ts --skipLibCheck 2>&1 | grep -q "error"; then
  echo -e "${RED}✗ FAILED${NC}"
  ((FAILED++))
else
  echo -e "${GREEN}✓ PASSED${NC}"
  ((PASSED++))
fi

echo ""

# ============================================================================
# 4. KNIHOVNY (lib/)
# ============================================================================
echo -e "${BLUE}4️⃣  KNIHOVNY (lib/)${NC}"
echo "==================="

for lib in span-builder phoenix-api lesson-storage llm-provider lesson-analyzer; do
  test_check "lib/${lib}.ts existuje" "test -f /root/pi-phoenix-learning/lib/${lib}.ts"
done

echo ""

# ============================================================================
# 5. COPILOT SETTINGS
# ============================================================================
echo -e "${BLUE}5️⃣  COPILOT SETTINGS${NC}"
echo "===================="

test_check "~/.copilot/settings.json existuje" 'test -f ~/.copilot/settings.json'
test_check "settings.json je validní JSON" 'jq . ~/.copilot/settings.json > /dev/null'

echo -n "Testování: Extension je v settings.json ... "
if jq '.extensions.directories[]?' ~/.copilot/settings.json 2>/dev/null | grep -q "pi-phoenix-learning"; then
  echo -e "${GREEN}✓ PASSED${NC}"
  ((PASSED++))
else
  echo -e "${YELLOW}⚠ NOT SET (nastav manuálně)${NC}"
fi

echo ""

# ============================================================================
# 6. PHOENIX SERVER
# ============================================================================
echo -e "${BLUE}6️⃣  PHOENIX SERVER${NC}"
echo "=================="

echo -n "Testování: Phoenix běží na localhost:6006 ... "
if curl -s http://localhost:6006/health 2>/dev/null | jq . > /dev/null 2>&1; then
  echo -e "${GREEN}✓ PASSED${NC}"
  ((PASSED++))
else
  echo -e "${YELLOW}⚠ NOT RUNNING${NC}"
  echo "  💡 Spusť: docker run -d --name phoenix -p 6006:6006 arizephoenix/phoenix:latest"
fi

echo ""

# ============================================================================
# 7. LEKCE (copilot-lessons.json)
# ============================================================================
echo -e "${BLUE}7️⃣  LEKCE (PERSISTENCE)${NC}"
echo "====================="

echo -n "Testování: ~/.copilot/ adresář existuje ... "
if test -d ~/.copilot/; then
  echo -e "${GREEN}✓ PASSED${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAILED${NC}"
  ((FAILED++))
fi

echo -n "Testování: copilot-lessons.json (pokud existuje je validní) ... "
if test -f ~/.copilot/copilot-lessons.json; then
  if jq . ~/.copilot/copilot-lessons.json > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((PASSED++))
  else
    echo -e "${RED}✗ FAILED (JSON nevalidní)${NC}"
    ((FAILED++))
  fi
else
  echo -e "${YELLOW}ℹ NEEXISTUJE (vytvoří se po prvním běhu)${NC}"
fi

echo ""

# ============================================================================
# 8. CONFIGURE ENVIRONMENT
# ============================================================================
echo -e "${BLUE}8️⃣  ENVIRONMENT VARIABLES${NC}"
echo "========================="

echo "Aktuální nastavení:"
echo "  PHOENIX_HOST=${PHOENIX_HOST:-'(default: localhost:6006)'}"
echo "  COPILOT_PHOENIX_PROJECT=${COPILOT_PHOENIX_PROJECT:-'(default: copilot)'}"
echo "  COPILOT_LESSONS_PATH=${COPILOT_LESSONS_PATH:-'(default: ~/.copilot/copilot-lessons.json)'}"

echo ""

# ============================================================================
# 9. SOUBORY & DOKUMENTACE
# ============================================================================
echo -e "${BLUE}9️⃣  DOKUMENTACE${NC}"
echo "================"

test_check "README.md existuje" "test -f /root/pi-phoenix-learning/README.md"
test_check "SETUP_GUIDE_CZ.md existuje" "test -f /root/pi-phoenix-learning/SETUP_GUIDE_CZ.md"
test_check "INSTALACE_COPILOT.md existuje" "test -f /root/pi-phoenix-learning/INSTALACE_COPILOT.md"

echo ""

# ============================================================================
# FINÁLNÍ VÝSLEDEK
# ============================================================================
echo -e "${BLUE}📊 VÝSLEDEK${NC}"
echo "==========="
echo -e "  ${GREEN}✓ Prošly: $PASSED${NC}"
echo -e "  ${RED}✗ Selhaly: $FAILED${NC}"
TOTAL=$((PASSED + FAILED))
echo "  Celkem: $TOTAL"

echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}🎉 Všechny testy prošly! Extension je připraven k použití.${NC}"
  echo ""
  echo "Příští kroky:"
  echo "  1. Restartuj Copilot: pkill copilot && sleep 2 && copilot -p 'Ahoj'"
  echo "  2. Otevři Phoenix UI: http://localhost:6006"
  echo "  3. Zkontroluj lekce: cat ~/.copilot/copilot-lessons.json"
  exit 0
else
  echo -e "${RED}❌ Některé testy selhaly. Zkontroluj výstup výše.${NC}"
  echo ""
  echo "Řešení:"
  echo "  1. Čti SETUP_GUIDE_CZ.md pro detaily"
  echo "  2. Zkontroluj ~/.copilot/settings.json"
  echo "  3. Podívej se na Troubleshooting v README.md"
  exit 1
fi
