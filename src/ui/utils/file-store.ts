// ============================================================
// File Handle Store — in-memory store for FileSystemFileHandle
//
// IMPORTANT: File System Access API handles are NOT serializable.
// They can only be stored in memory, not in IndexedDB.
// This store lives in the NEW TAB page context.
// Handles are lost on page close — user must reconnect.
// ============================================================

const fileHandleStore = new Map<string, FileSystemFileHandle>();

/**
 * Store a file handle for a book.
 */
export function storeFileHandle(bookId: string, handle: FileSystemFileHandle): void {
  fileHandleStore.set(bookId, handle);
}

/**
 * Get a file handle for a book.
 */
export function getFileHandle(bookId: string): FileSystemFileHandle | undefined {
  return fileHandleStore.get(bookId);
}

/**
 * Check if we have a handle for a book.
 */
export function hasFileHandle(bookId: string): boolean {
  return fileHandleStore.has(bookId);
}

/**
 * Verify that a stored handle still has read permission.
 */
export async function verifyFileHandle(bookId: string): Promise<boolean> {
  const handle = fileHandleStore.get(bookId);
  if (!handle) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perm = await (handle as any).queryPermission({ mode: 'read' });
    return perm === 'granted';
  } catch {
    return false;
  }
}

/**
 * Request permission for an existing handle.
 */
export async function requestFilePermission(bookId: string): Promise<boolean> {
  const handle = fileHandleStore.get(bookId);
  if (!handle) return false;
  try {
    const perm = await (handle as any).requestPermission({ mode: 'read' });
    return perm === 'granted';
  } catch {
    return false;
  }
}

/**
 * Prompt user to pick a new file and store the handle.
 * Returns the new handle or null if cancelled.
 */
export async function reconnectFileHandle(bookId: string): Promise<FileSystemFileHandle | null> {
  try {
    const [handle] = await (window as unknown as { showOpenFilePicker: (opts?: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
      types: [
        { description: 'PDF/DJVU книги', accept: { 'application/pdf': ['.pdf'], 'image/vnd.djvu': ['.djvu', '.djv'] } },
      ],
    });
    fileHandleStore.set(bookId, handle);
    return handle;
  } catch {
    return null;
  }
}

/**
 * Read file content as ArrayBuffer using stored handle.
 */
export async function readFileAsArrayBuffer(bookId: string): Promise<ArrayBuffer> {
  const handle = fileHandleStore.get(bookId);
  if (!handle) throw new Error('Нет доступа к файлу. Переподключите файл.');
  const file = await handle.getFile();
  return file.arrayBuffer();
}
