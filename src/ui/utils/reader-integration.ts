// ============================================================
// Reader Integration — open book in external reader (zathura)
//
// Uses Native Messaging Host to execute zathura directly.
// Falls back to clipboard copy if NMH is not installed.
//
// Zathura CLI options:
//   -P N, --page N    Open at page number N (1-based)
//   --fork            Run in background (non-blocking)
//   -f, --fork        Alias for --fork (boolean, NO argument)
//
// Note: Standard zathura has no CLI search option.
// In zathura, press / to start search, type phrase, Enter.
// ============================================================

import { db } from '../../db/index.js';
import { openInZathura } from './native-messaging.js';

export async function buildReaderCommand(
  bookId: string,
  page: number,
  searchPhrase?: string,
  reader: 'zathura' | 'okular' | 'evince' = 'zathura',
): Promise<string> {
  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Книга ${bookId} не найдена`);

  const filePath = book.filePath || book.title;
  const quoted = filePath.includes("'") ? `"${filePath}"` : `'${filePath}'`;

  switch (reader) {
    case 'zathura':
      // -P N = page number, --fork = background
      return `zathura -P ${page} --fork ${quoted}`;
    case 'okular':
      return `okular --page=${page} ${quoted}`;
    case 'evince':
      return `evince ${quoted}`;
  }
}

/**
 * Open book in external reader via Native Messaging Host.
 * Falls back to clipboard copy if NMH is not installed.
 */
export async function openInReader(
  bookId: string,
  page: number,
  searchPhrase?: string,
): Promise<{ launched: boolean; command: string; searchHint?: string; error?: string }> {
  const book = await db.books.get(bookId);
  if (!book) {
    return { launched: false, command: '', error: `Книга ${bookId} не найдена` };
  }

  const filePath = book.filePath;
  if (!filePath) {
    return { launched: false, command: '', error: 'Путь к файлу не указан' };
  }

  return openInZathura(filePath, page, searchPhrase);
}
