// ============================================================
// File Handle Store — persistent FileSystemFileHandle storage
//
// FileSystemFileHandle IS structured-cloneable (Chrome 86+).
// Handles are stored in IndexedDB (via db.saveFileHandle) so they
// survive extension reloads, tab closures, and browser restarts.
//
// This module provides an in-memory cache layer backed by IndexedDB.
// ============================================================

import { db, loadFileHandle, saveFileHandle, removeFileHandle } from '../../db/index.js';

const fileHandleCache = new Map<string, FileSystemFileHandle>();

/** Store handle in both memory cache AND IndexedDB */
export async function storeFileHandle(bookId: string, handle: FileSystemFileHandle): Promise<void> {
  fileHandleCache.set(bookId, handle);
  await saveFileHandle(bookId, handle);
}

/** Get handle from memory cache */
export function getFileHandle(bookId: string): FileSystemFileHandle | undefined {
  return fileHandleCache.get(bookId);
}

/** Check if handle exists in memory cache */
export function hasFileHandle(bookId: string): boolean {
  return fileHandleCache.has(bookId);
}

/**
 * Restore all handles from IndexedDB into memory cache.
 * Call once at app startup (app.ts init).
 * Checks permissions: handles with 'granted' go directly to cache,
 * handles with 'prompt' also go to cache (requestPermission will be
 * called later when user clicks an action button).
 */
export async function restoreAllHandles(): Promise<void> {
  const records = await db.fileHandles.toArray();
  for (const record of records) {
    const handle = record.handle as FileSystemFileHandle;
    if (handle) {
      fileHandleCache.set(record.bookId, handle);
    }
  }
}

/**
 * Verify that a stored handle has active read permission.
 */
export async function verifyFileHandle(bookId: string): Promise<boolean> {
  const handle = fileHandleCache.get(bookId);
  if (!handle) return false;
  try {
    const perm = await (handle as any).queryPermission({ mode: 'read' });
    return perm === 'granted';
  } catch {
    return false;
  }
}

/**
 * Request permission for a handle already in memory.
 * Returns true if permission was granted.
 */
export async function requestFilePermission(bookId: string): Promise<boolean> {
  const handle = fileHandleCache.get(bookId);
  if (!handle) return false;
  try {
    const perm = await (handle as any).requestPermission({ mode: 'read' });
    return perm === 'granted';
  } catch {
    return false;
  }
}

/**
 * Try to ensure access: first checks permission, then requests if needed.
 * Returns 'granted' | 'prompt' | 'denied' | null (no handle).
 */
export async function ensureFileAccess(bookId: string): Promise<'granted' | 'prompt' | 'denied' | null> {
  let handle = fileHandleCache.get(bookId);

  // If not in memory, try loading from IndexedDB
  if (!handle) {
    const loaded = await loadFileHandle(bookId);
    if (loaded) {
      fileHandleCache.set(bookId, loaded);
      handle = loaded;
    }
  }

  if (!handle) return null; // No handle at all — need full reconnect

  try {
    const perm = await (handle as any).queryPermission({ mode: 'read' });
    if (perm === 'granted') return 'granted';
    if (perm === 'denied') return 'denied';

    // perm === 'prompt' — try requesting (must be triggered by user gesture)
    const result = await (handle as any).requestPermission({ mode: 'read' });
    return result; // 'granted' | 'denied'
  } catch {
    return null;
  }
}

/**
 * Prompt user to pick a new file via file picker.
 * Stores the new handle in both memory and IndexedDB.
 * Returns the new handle or null if cancelled.
 */
export async function reconnectFileHandle(bookId: string): Promise<FileSystemFileHandle | null> {
  try {
    const [handle] = await (window as unknown as { showOpenFilePicker: (opts?: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
      types: [
        { description: 'PDF/DJVU книги', accept: { 'application/pdf': ['.pdf'], 'image/vnd.djvu': ['.djvu', '.djv'] } },
      ],
    });
    await storeFileHandle(bookId, handle);
    return handle;
  } catch {
    return null;
  }
}

/**
 * Prompt user to pick a file and verify it matches the expected file name.
 * Stores the new handle in both memory and IndexedDB.
 * Returns the new handle or null if cancelled or rejected.
 */
export async function reconnectFileHandleWithCheck(
  bookId: string,
  expectedFileName?: string,
): Promise<FileSystemFileHandle | null> {
  try {
    const [handle] = await (window as unknown as { showOpenFilePicker: (opts?: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
      types: [
        { description: 'PDF/DJVU книги', accept: { 'application/pdf': ['.pdf'], 'image/vnd.djvu': ['.djvu', '.djv'] } },
      ],
    });
    const file = await handle.getFile();

    if (expectedFileName && file.name !== expectedFileName) {
      const proceed = confirm(
        `Выбран файл «${file.name}», а ожидался «${expectedFileName}».\nПодключить выбранный файл?`,
      );
      if (!proceed) return null;
    }

    await storeFileHandle(bookId, handle);
    return handle;
  } catch {
    return null;
  }
}

/** Remove handle from both memory and IndexedDB */
export async function deleteStoredHandle(bookId: string): Promise<void> {
  fileHandleCache.delete(bookId);
  await removeFileHandle(bookId);
}

/** Read file content as ArrayBuffer using stored handle */
export async function readFileAsArrayBuffer(bookId: string): Promise<ArrayBuffer> {
  const handle = fileHandleCache.get(bookId);
  if (!handle) throw new Error('Нет доступа к файлу. Переподключите файл.');
  const file = await handle.getFile();
  return file.arrayBuffer();
}
