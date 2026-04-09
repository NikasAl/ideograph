// ============================================================
// Reader Integration — open book in external reader (zathura)
// ============================================================

import { db } from '../../db/index.js';

export async function buildReaderCommand(
  bookId: string,
  page: number,
  reader: 'zathura' | 'okular' | 'evince' = 'zathura',
): Promise<string> {
  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Книга ${bookId} не найдена`);

  const filePath = book.filePath || book.title;

  switch (reader) {
    case 'zathura': return `zathura -f ${page} "${filePath}"`;
    case 'okular': return `okular --page=${page} "${filePath}"`;
    case 'evince': return `evince "${filePath}"`;
  }
}

export async function openInReader(bookId: string, page: number): Promise<void> {
  const command = await buildReaderCommand(bookId, page);
  try {
    await navigator.clipboard.writeText(command);
  } catch {
    prompt('Скопируйте команду для открытия в ридере:', command);
  }
}
