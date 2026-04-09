// ============================================================
// Background Service Worker — Ideograph
// ============================================================
// Handles: PDF/DJVU processing, AI calls, file access coordination

import { db, getSettings } from '../db/index.js';
import { createProvider } from './ai-client.js';

// File handle storage (not serializable — kept in memory, keyed by bookId)
const fileHandleStore = new Map<string, FileSystemFileHandle>();

// --- File Handle management ---

export async function storeFileHandle(bookId: string, handle: FileSystemFileHandle): Promise<void> {
  fileHandleStore.set(bookId, handle);
  await db.books.update(bookId, { fileHandleStored: 1, updatedAt: Date.now() });
}

export function getFileHandle(bookId: string): FileSystemFileHandle | undefined {
  return fileHandleStore.get(bookId);
}

export function hasFileHandle(bookId: string): boolean {
  return fileHandleStore.has(bookId);
}

export async function verifyFileHandle(bookId: string): Promise<boolean> {
  const handle = fileHandleStore.get(bookId);
  if (!handle) return false;
  try {
    // Check if permission is still valid
    const perm = await handle.queryPermission({ mode: 'read' });
    return perm === 'granted';
  } catch {
    return false;
  }
}

export async function reconnectFileHandle(bookId: string): Promise<FileSystemFileHandle | null> {
  try {
    const [handle] = await (window as unknown as { showOpenFilePicker: (opts?: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
      types: [
        { description: 'PDF/DJVU книги', accept: { 'application/pdf': ['.pdf'], 'image/vnd.djvu': ['.djvu', '.djv'] } },
      ],
    });
    fileHandleStore.set(bookId, handle);
    const book = await db.books.get(bookId);
    if (book) {
      await db.books.update(bookId, { filePath: handle.name, updatedAt: Date.now() });
    }
    return handle;
  } catch {
    return null;
  }
}

// --- AI Analysis ---

export interface AnalysisRequest {
  bookId: string;
  pageFrom: number;
  pageTo: number;
  mode: 'text' | 'vlm';
  signal?: AbortSignal;
}

export async function startAnalysis(request: AnalysisRequest): Promise<void> {
  const settings = await getSettings();
  const apiKey = settings.providerKeys[settings.activeProvider];
  if (!apiKey) throw new Error(`API ключ для ${settings.activeProvider} не настроен`);

  const provider = createProvider(settings.activeProvider, apiKey);

  // Log start
  const logId = await db.analysisLog.add({
    bookId: request.bookId,
    pageFrom: request.pageFrom,
    pageTo: request.pageTo,
    mode: request.mode,
    provider: settings.activeProvider,
    model: settings.activeModel,
    ideasCount: 0,
    relationsCount: 0,
    startedAt: Date.now(),
    completedAt: 0,
    status: 'success',
  });

  try {
    // TODO: implement full pipeline (phase 2)
    // For now, store log entry
    await db.analysisLog.update(logId!, { completedAt: Date.now() });
  } catch (err) {
    await db.analysisLog.update(logId!, {
      completedAt: Date.now(),
      status: 'error',
      error: String(err),
    });
    throw err;
  }
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = messageHandlers[message.type as keyof typeof messageHandlers];
  if (handler) {
    handler(message.data).then(sendResponse).catch((err) => {
      sendResponse({ error: String(err) });
    });
    return true; // async response
  }
});

const messageHandlers: Record<string, (data: unknown) => Promise<unknown>> = {
  'verify-handle': async ({ bookId }: { bookId: string }) => verifyFileHandle(bookId),
  'reconnect-handle': async ({ bookId }: { bookId: string }) => reconnectFileHandle(bookId),
  'start-analysis': async (data: AnalysisRequest) => startAnalysis(data),
};
