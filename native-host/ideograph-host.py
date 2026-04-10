#!/usr/bin/env python3
"""
Идеограф — Native Messaging Host for Chrome Extension

Receives JSON messages from the Chrome extension via stdin and executes
local commands (zathura, etc.) via subprocess.

Protocol:
  - Chrome sends a 4-byte little-endian length prefix + JSON body
  - Host responds with the same format (4-byte length + JSON body)
  - Each message is independent (request-response)

Usage:
  # Normal mode (launched by Chrome):
  ./ideograph-host.py

  # Interactive test mode (reads plain JSON lines):
  ./ideograph-host.py --test

Messages supported:
  { "action": "ping" }
    → { "status": "ok", "version": "1.0" }

  { "action": "openZathura", "filePath": "...", "searchPhrase": "...", "page": 17 }
    → { "status": "ok", "command": "..." }
    or { "status": "error", "error": "..." }

  { "action": "exec", "command": "..." }
    → { "status": "ok", "exitCode": 0 }
    or { "status": "error", "error": "..." }
"""

import sys
import json
import struct
import subprocess
import os
import shlex

HOST_VERSION = "1.1"


def read_message():
    """Read a single message from Chrome (4-byte length prefix + JSON body)."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    if len(raw_length) < 4:
        sys.exit(1)
    message_length = struct.unpack('=I', raw_length)[0]
    if message_length == 0:
        return {}
    if message_length > 10 * 1024 * 1024:  # 10 MB sanity limit
        sys.exit(1)
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)


def send_message(message):
    """Send a single message to Chrome (4-byte length prefix + JSON body)."""
    encoded = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def read_message_test():
    """Read a plain JSON line (for --test mode)."""
    line = input()
    return json.loads(line)


def send_message_test(message):
    """Send a plain JSON line (for --test mode)."""
    print(json.dumps(message, ensure_ascii=False))
    sys.stdout.flush()


def handle_open_zathura(msg):
    """Handle 'openZathura' action — launch zathura with page and search hint."""
    file_path = msg.get('filePath', '')
    search_phrase = msg.get('searchPhrase', '')
    page = msg.get('page')

    if not file_path:
        return {"status": "error", "error": "No filePath provided"}

    # Expand ~ to home directory
    file_path = os.path.expanduser(file_path)

    if not os.path.isfile(file_path):
        # Try to find the file by name in common locations
        basename = os.path.basename(file_path)
        search_dirs = [
            os.path.expanduser('~/Library'),
            os.path.expanduser('~/Documents'),
            os.path.expanduser('~/Downloads'),
            os.path.expanduser('~'),
        ]
        found = None
        for d in search_dirs:
            for root, dirs, files in os.walk(d):
                if basename in files:
                    found = os.path.join(root, basename)
                    break
            if found:
                break

        if found:
            file_path = found
        else:
            return {"status": "error", "error": f"File not found: {file_path}"}

    # Build zathura command
    # -P N = open at page number (1-based)
    # --fork = run in background (non-blocking)
    cmd = ['zathura', '--fork']

    if page:
        cmd.extend(['-P', str(page)])

    cmd.append(file_path)

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        # Give it a moment to check for immediate failure (e.g., display error)
        try:
            _, stderr = proc.communicate(timeout=2)
            if proc.returncode != 0:
                err_text = stderr.decode('utf-8', errors='replace').strip()
                # Filter out harmless zathura warnings
                err_lines = [l for l in err_text.split('\n')
                             if l and 'Unknown option' not in l and 'warning:' not in l.lower()]
                err_clean = '\n'.join(err_lines).strip()
                return {
                    "status": "error",
                    "error": f"zathura exited with code {proc.returncode}: {err_clean}" if err_clean
                             else f"zathura exited with code {proc.returncode}",
                }
        except subprocess.TimeoutExpired:
            # Process is still running — zathura launched successfully
            pass

        cmd_display = ' '.join(shlex.quote(c) for c in cmd)
        result = {"status": "ok", "command": cmd_display}

        # Include search hint if available
        if search_phrase:
            truncated = search_phrase[:200] if len(search_phrase) > 200 else search_phrase
            result["searchHint"] = f"В zathura нажмите / и введите: {truncated}"

        return result

    except FileNotFoundError:
        return {"status": "error", "error": "zathura not found. Install: sudo apt install zathura"}
    except PermissionError:
        return {"status": "error", "error": f"Permission denied for: {file_path}"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def handle_exec(msg):
    """Handle generic 'exec' action — run any shell command."""
    command = msg.get('command', '')
    if not command:
        return {"status": "error", "error": "No command provided"}

    try:
        proc = subprocess.Popen(
            command,
            shell=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        stdout, stderr = proc.communicate(timeout=10)
        return {
            "status": "ok",
            "exitCode": proc.returncode,
            "stdout": stdout.decode('utf-8', errors='replace')[:1000],
            "stderr": stderr.decode('utf-8', errors='replace')[:1000],
        }
    except subprocess.TimeoutExpired:
        proc.kill()
        return {"status": "error", "error": "Command timed out (10s)"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def dispatch(msg):
    """Dispatch message to appropriate handler."""
    action = msg.get('action', '')

    if action == 'ping':
        return {"status": "ok", "version": HOST_VERSION}
    elif action == 'openZathura':
        return handle_open_zathura(msg)
    elif action == 'exec':
        return handle_exec(msg)
    elif action == 'quit':
        return {"status": "ok", "quit": True}
    else:
        return {"status": "error", "error": f"Unknown action: {action}"}


def main_nmh():
    """Main loop for Native Messaging Host mode (binary protocol)."""
    while True:
        try:
            msg = read_message()
        except Exception:
            break

        response = dispatch(msg)
        send_message(response)

        if response.get('quit'):
            break


def main_test():
    """Interactive test mode — reads plain JSON lines from stdin."""
    print(f"Идеограф NMH v{HOST_VERSION} — test mode", file=sys.stderr)
    print("Enter JSON messages, one per line. Ctrl+D or 'quit' to exit.", file=sys.stderr)
    sys.stderr.flush()

    while True:
        try:
            line = input()
        except EOFError:
            break

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"status": "error", "error": f"Invalid JSON: {e}"}))
            sys.stdout.flush()
            continue

        response = dispatch(msg)
        print(json.dumps(response, ensure_ascii=False))
        sys.stdout.flush()

        if response.get('quit'):
            break


if __name__ == '__main__':
    if '--test' in sys.argv:
        main_test()
    else:
        main_nmh()
