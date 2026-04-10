#!/usr/bin/env bash
# ============================================================
# Идеограф — Install Native Messaging Host
#
# This script installs the ideograph-host.py script and
# registers it with Chrome/Chromium as a Native Messaging Host.
#
# Usage: bash install.sh [EXTENSION_ID]
#   EXTENSION_ID  The Chrome extension ID (from chrome://extensions/)
#                 If not provided, will prompt you to enter it.
#
# Example:
#   bash install.sh bajmijglngikofcohhjljpkdmgdejjem
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/ideograph-host.py"
HOST_MANIFEST_NAME="com.ideograph.host.json"

# Resolve the host script to absolute path
HOST_SCRIPT_ABS="$(readlink -f "$HOST_SCRIPT")"

# Where to install the host script
INSTALL_DIR="$HOME/.local/share/ideograph"
HOST_SCRIPT_INSTALLED="$INSTALL_DIR/ideograph-host.py"

# Chrome NativeMessagingHosts directories
CHROME_NM_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
CHROMIUM_NM_DIR="$HOME/.config/chromium/NativeMessagingHosts"

# ---- Get extension ID ----
EXTENSION_ID="${1:-}"

if [ -z "$EXTENSION_ID" ]; then
    echo ""
    echo "=== Идеограф — Установка Native Messaging Host ==="
    echo ""
    echo "Нужен ID расширения. Как его найти:"
    echo "  1. Откройте chrome://extensions/ в Chrome"
    echo "  2. Включите «Режим разработчика»"
    echo "  3. Найдите «Идеограф» в списке"
    echo "  4. Скопируйте ID (строка вида abcdefghijklmnopqrstuvwxyzabcdef)"
    echo ""

    # Try to auto-detect from Chrome's preferences
    CHROME_PREFS="$HOME/.config/google-chrome/Default/Preferences"
    if [ -f "$CHROME_PREFS" ]; then
        AUTO_ID=$(python3 -c "
import json
with open('$CHROME_PREFS') as f:
    prefs = json.load(f)
extensions = prefs.get('extensions', {}).get('settings', {})
for eid, edata in extensions.items():
    manifest = edata.get('manifest', {})
    if 'Идеограф' in manifest.get('name', '') or 'ideograph' in manifest.get('name', '').lower():
        print(eid)
        break
" 2>/dev/null || true)
        if [ -n "$AUTO_ID" ]; then
            echo "  Автообнаружен ID: $AUTO_ID"
            EXTENSION_ID="$AUTO_ID"
        fi
    fi

    if [ -z "$EXTENSION_ID" ]; then
        read -rp "Введите Extension ID: " EXTENSION_ID
    fi
fi

# Validate extension ID format (32 lowercase hex chars)
if ! echo "$EXTENSION_ID" | grep -qE '^[a-z]{32}$'; then
    echo "Ошибка: Extension ID должен быть 32 символа (lowercase a-z)."
    echo "Получено: '$EXTENSION_ID'"
    echo "Убедитесь что копируете ID без лишних пробелов и символов."
    exit 1
fi

echo ""
echo "Extension ID: $EXTENSION_ID"
echo ""

# ---- Step 1: Install host script ----
echo "[1/4] Установка хост-скрипта..."
mkdir -p "$INSTALL_DIR"
cp "$HOST_SCRIPT_ABS" "$HOST_SCRIPT_INSTALLED"
chmod +x "$HOST_SCRIPT_INSTALLED"
echo "  ✓ $HOST_SCRIPT_INSTALLED"

# ---- Step 2: Check Python3 ----
echo "[2/4] Проверка Python3..."
if command -v python3 &>/dev/null; then
    PYTHON_VERSION=$(python3 --version 2>&1)
    echo "  ✓ $PYTHON_VERSION"
else
    echo "  ✗ Python3 не найден! Установите: sudo apt install python3"
    exit 1
fi

# ---- Step 3: Check zathura ----
echo "[3/4] Проверка zathura..."
if command -v zathura &>/dev/null; then
    ZATHURA_VERSION=$(zathura --version 2>&1 || echo "installed")
    echo "  ✓ zathura: $ZATHURA_VERSION"
else
    echo "  ⚠ zathura не найден. Установите: sudo apt install zathura"
fi

# ---- Step 4: Generate and install manifests ----
echo "[4/4] Установка манифестов для Chrome/Chromium..."

generate_manifest() {
    local dest_dir="$1"
    local dest_file="$dest_dir/$HOST_MANIFEST_NAME"

    mkdir -p "$dest_dir"

    cat > "$dest_file" << EOF
{
  "name": "com.ideograph.host",
  "description": "Идеограф — Native Messaging Host для запуска zathura и других локальных команд",
  "path": "$HOST_SCRIPT_INSTALLED",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

    echo "  ✓ $dest_file"
}

generate_manifest "$CHROME_NM_DIR"
generate_manifest "$CHROMIUM_NM_DIR"

# ---- Summary ----
echo ""
echo "=== Установка завершена! ==="
echo ""
echo "  Extension ID: chrome-extension://$EXTENSION_ID/"
echo "  Host script:  $HOST_SCRIPT_INSTALLED"
echo "  Manifests:"
echo "    - $CHROME_NM_DIR/$HOST_MANIFEST_NAME"
echo "    - $CHROMIUM_NM_DIR/$HOST_MANIFEST_NAME"
echo ""
echo "⚠️  Перезапустите Chrome/Chromium чтобы изменения вступили в силу."
echo ""
echo "Проверка:"
echo "  python3 $HOST_SCRIPT_INSTALLED --test"
echo ""
echo "Удаление:"
echo "  rm -rf $INSTALL_DIR"
echo "  rm $CHROME_NM_DIR/$HOST_MANIFEST_NAME"
echo "  rm $CHROMIUM_NM_DIR/$HOST_MANIFEST_NAME"
