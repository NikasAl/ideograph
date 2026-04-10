// ============================================================
// Native Messaging — communicate with ideograph-host.py
//
// The native host (ideograph-host.py) allows the Chrome extension
// to execute local commands like zathura. If the host is not
// installed, functions gracefully fall back to clipboard copy.
//
// Install: bash native-host/install.sh
// ============================================================

const HOST_NAME = 'com.ideograph.host';

/** Response from native host */
export interface NativeHostResponse {
  status: 'ok' | 'error';
  version?: string;
  command?: string;
  searchHint?: string;
  error?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** Whether native messaging is available (host installed) */
let hostAvailable: boolean | null = null;

/**
 * Check if the native messaging host is installed and responsive.
 * Caches the result for subsequent calls.
 */
export async function isNativeHostAvailable(): Promise<boolean> {
  if (hostAvailable !== null) return hostAvailable;

  try {
    const response = await sendNativeMessage({ action: 'ping' });
    hostAvailable = response.status === 'ok';
    return hostAvailable;
  } catch {
    hostAvailable = false;
    return false;
  }
}

/**
 * Reset the cached availability state (e.g., after install).
 */
export function resetHostAvailability(): void {
  hostAvailable = null;
}

/**
 * Get the cached NMH status (for display purposes).
 */
export function getHostStatus(): boolean | null {
  return hostAvailable;
}

/**
 * Send a message to the native messaging host.
 * Returns the parsed JSON response.
 * Throws if the host is not available or communication fails.
 */
async function sendNativeMessage(message: Record<string, unknown>): Promise<NativeHostResponse> {
  return new Promise((resolve, reject) => {
    // In a newtab Chrome extension, chrome.runtime is available
    const runtime = (window as any).chrome?.runtime;
    if (!runtime?.sendNativeMessage) {
      reject(new Error('chrome.runtime.sendNativeMessage not available'));
      return;
    }

    runtime.sendNativeMessage(
      HOST_NAME,
      message,
      (response: NativeHostResponse) => {
        if (runtime.lastError) {
          reject(new Error(runtime.lastError.message));
        } else {
          resolve(response);
        }
      },
    );
  });
}

/**
 * Open a PDF file in zathura at a specific page.
 * Falls back to clipboard copy if native host is not available.
 *
 * @param filePath - Absolute path to the PDF file
 * @param page - Page number to open (1-based)
 * @param searchPhrase - Optional: phrase to search for in zathura
 * @returns Result object with status and info
 */
export async function openInZathura(
  filePath: string,
  page: number,
  searchPhrase?: string,
): Promise<{ launched: boolean; command: string; searchHint?: string; error?: string }> {
  const available = await isNativeHostAvailable();

  if (!available) {
    // Fallback: copy command to clipboard with NMH install hint
    const cmd = buildZathuraCommand(filePath, page, searchPhrase);
    await copyToClipboard(cmd);
    let hint = 'NMH не установлен. Команда скопирована в буфер обмена.';
    hint += '\nУстановка: cd native-host && bash install.sh YOUR_EXTENSION_ID';
    if (searchPhrase) {
      hint += `\nПоиск в zathura: /${searchPhrase.slice(0, 80)}`;
    }
    return {
      launched: false,
      command: cmd,
      searchHint: hint,
    };
  }

  try {
    const response = await sendNativeMessage({
      action: 'openZathura',
      filePath,
      page,
      searchPhrase: searchPhrase || '',
    });

    if (response.status === 'ok') {
      return {
        launched: true,
        command: response.command || buildZathuraCommand(filePath, page, searchPhrase),
        searchHint: response.searchHint,
      };
    } else {
      // Host returned an error — fall back to clipboard
      const cmd = buildZathuraCommand(filePath, page, searchPhrase);
      await copyToClipboard(cmd);
      return {
        launched: false,
        command: cmd,
        error: response.error || 'Unknown error from native host',
        searchHint: `Ошибка: ${response.error}. Команда скопирована в буфер обмена.`,
      };
    }
  } catch (err) {
    // Communication failed — fall back to clipboard
    const cmd = buildZathuraCommand(filePath, page, searchPhrase);
    try { await copyToClipboard(cmd); } catch { /* ignore */ }
    return {
      launched: false,
      command: cmd,
      error: (err as Error).message,
    };
  }
}

/**
 * Execute an arbitrary shell command via the native host.
 * Falls back to clipboard copy if host is not available.
 */
export async function execCommand(command: string): Promise<NativeHostResponse & { clipboard?: boolean }> {
  const available = await isNativeHostAvailable();

  if (!available) {
    try { await copyToClipboard(command); } catch { /* ignore */ }
    return { status: 'ok', clipboard: true };
  }

  try {
    return await sendNativeMessage({ action: 'exec', command });
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}

/**
 * Build a zathura command string.
 *
 * Uses -P for page number (standard zathura).
 * The search phrase is provided as a hint (user presses / in zathura).
 *
 * If the user's zathura supports `-f 'search phrase'` syntax
 * (non-standard / patched version), they can set the search
 * phrase in the command by enabling searchInCommand below.
 */
function buildZathuraCommand(
  filePath: string,
  page: number,
  searchPhrase?: string,
): string {
  const quoted = filePath.includes("'") ? `"${filePath}"` : `'${filePath}'`;

  // Standard: -P page --fork file
  // If your zathura supports -f for search (non-standard), uncomment:
  // if (searchPhrase) return `zathura -f '${searchPhrase.slice(0, 200)}' ${quoted}`;
  return `zathura -P ${page} --fork ${quoted}`;
}

/**
 * Copy text to clipboard.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback: create temporary textarea
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}
