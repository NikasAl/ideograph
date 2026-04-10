#!/usr/bin/env bash
# ============================================================
# Идеограф — Install Native Messaging Host
#
# This script installs the ideograph-host.py script and
# registers it with Google Chrome as a Native Messaging Host.
#
# Usage: bash install.sh [--user | --system]
#   --user   Install for current user only (default)
#   --system Install system-wide (requires sudo)
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

# Chrome NativeMessagingHosts directory
CHROME_USER_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
CHROME_SYSTEM_DIR="/etc/opt/chrome/native-messaging-hosts"

# Chromium NativeMessagingHosts directory
CHROMIUM_USER_DIR="$HOME/.config/chromium/NativeMessagingHosts"
CHROMIUM_SYSTEM_DIR="/etc/chromium/native-messaging-hosts"

INSTALL_MODE="user"

for arg in "$@"; do
    case "$arg" in
        --user)   INSTALL_MODE="user" ;;
        --system) INSTALL_MODE="system" ;;
        -h|--help)
            echo "Usage: $0 [--user | --system]"
            echo "  --user   Install for current user only (default)"
            echo "  --system Install system-wide (requires sudo)"
            exit 0
            ;;
    esac
done

echo "=== Идеограф — Установка Native Messaging Host ==="
echo "Режим: $INSTALL_MODE"
echo ""

# 1. Create install directory and copy host script
echo "[1/4] Копирование хост-скрипта..."
mkdir -p "$INSTALL_DIR"
cp "$HOST_SCRIPT_ABS" "$HOST_SCRIPT_INSTALLED"
chmod +x "$HOST_SCRIPT_INSTALLED"
echo "  ✓ Хост-скрипт: $HOST_SCRIPT_INSTALLED"

# 2. Verify Python3 is available
echo "[2/4] Проверка Python3..."
if command -v python3 &>/dev/null; then
    PYTHON_VERSION=$(python3 --version 2>&1)
    echo "  ✓ $PYTHON_VERSION"
else
    echo "  ✗ Python3 не найден! Установите: sudo apt install python3"
    exit 1
fi

# 3. Check for zathura
echo "[3/4] Проверка zathura..."
if command -v zathura &>/dev/null; then
    ZATHURA_VERSION=$(zathura --version 2>&1 || echo "installed")
    echo "  ✓ zathura: $ZATHURA_VERSION"
else
    echo "  ⚠ zathura не найден. Установите: sudo apt install zathura"
fi

# 4. Install manifest for Chrome and Chromium
echo "[4/4] Установка манифеста..."

install_manifest() {
    local manifest_src="$SCRIPT_DIR/$HOST_MANIFEST_NAME"
    local manifest_dir="$1"
    local manifest_dest="$manifest_dir/$HOST_MANIFEST_NAME"

    mkdir -p "$manifest_dir"

    # Update path in manifest to point to installed script
    sed "s|/home/nikas/.local/share/ideograph/ideograph-host.py|$HOST_SCRIPT_INSTALLED|g" \
        "$manifest_src" > "$manifest_dest"

    echo "  ✓ $manifest_dest"
}

if [ "$INSTALL_MODE" = "system" ]; then
    sudo mkdir -p "$CHROME_SYSTEM_DIR"
    sudo mkdir -p "$CHROMIUM_SYSTEM_DIR"
    sudo bash -c "$(declare -f install_manifest); install_manifest '$CHROME_SYSTEM_DIR'"
    sudo bash -c "$(declare -f install_manifest); install_manifest '$CHROMIUM_SYSTEM_DIR'"
else
    install_manifest "$CHROME_USER_DIR"
    install_manifest "$CHROMIUM_USER_DIR"
fi

echo ""
echo "=== Установка завершена! ==="
echo ""
echo "Перезапустите Chrome/Chromium чтобы изменения вступили в силу."
echo ""
echo "Проверка работоспособности:"
echo "  python3 $HOST_SCRIPT_INSTALLED"
echo "  (затем вставьте: {\"action\":\"ping\"} и нажмите Enter, Ctrl+D)"
echo ""
echo "Удаление:"
echo "  rm -rf $INSTALL_DIR"
echo "  rm $CHROME_USER_DIR/$HOST_MANIFEST_NAME"
echo "  rm $CHROMIUM_USER_DIR/$HOST_MANIFEST_NAME"
