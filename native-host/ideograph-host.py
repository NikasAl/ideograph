#!/usr/bin/env python3
"""
Идеограф — Native Messaging Host for Chrome Extension

Receives JSON messages from the Chrome extension via stdin and executes
local commands (zathura, etc.) via subprocess.

Protocol:
  - Chrome sends a 4-byte little-endian length prefix + JSON body
  - Host responds with the same format (4-byte length + JSON body)
  - Each message is independent (request-response)

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

HOST_VERSION = "1.0"


def read_message():
    """Read a single message from Chrome (4-byte length + JSON body)."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    if len(raw_length) < 4:
        sys.exit(1)
    message_length = struct.unpack('=I', raw_length)[0]
    if message_length == 0:
        return {}
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)


def send_message(message):
    """Send a single message to Chrome (4-byte length + JSON body)."""
    encoded = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def handle_open_zathura(msg):
    """Handle 'openZathura' action — launch zathura with page and/or search."""
    file_path = msg.get('filePath', '')
    search_phrase = msg.get('searchPhrase', '')
    page = msg.get('page')

    if not file_path:
        return {"status": "error", "error": "No filePath provided"}

    if not os.path.isfile(file_path):
        # Try common paths — file might be relative or from a different mount
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
                return {
                    "status": "error",
                    "error": f"zathura exited with code {proc.returncode}: {err_text}",
                }
        except subprocess.TimeoutExpired:
            # Process is still running — that means zathura launched successfully
            pass

        cmd_display = ' '.join(shlex.quote(c) for c in cmd)
        result = {"status": "ok", "command": cmd_display}

        # Include search hint if available
        if search_phrase:
            # Truncate search phrase for display (zathura has a 256-char input buffer)
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


def main():
    """Main loop — read messages and dispatch."""
    while True:
        try:
            msg = read_message()
        except Exception:
            break

        action = msg.get('action', '')

        if action == 'ping':
            send_message({"status": "ok", "version": HOST_VERSION})

        elif action == 'openZathura':
            send_message(handle_open_zathura(msg))

        elif action == 'exec':
            send_message(handle_exec(msg))

        elif action == 'quit':
            send_message({"status": "ok"})
            break

        else:
            send_message({"status": "error", "error": f"Unknown action: {action}"})


if __name__ == '__main__':
    main()
