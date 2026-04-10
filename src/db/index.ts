import Dexie, { type Table } from 'dexie';
import type {
  Book,
  Idea,
  Settings,
  PageTextCache,
  AnalysisLog,
  FileHandleRecord,
} from './schema.js';

class IdeographDB extends Dexie {
  books!: Table<Book, string>;
  ideas!: Table<Idea, string>;
  settings!: Table<Settings, number>;
  pageCache!: Table<PageTextCache, number>;
  analysisLog!: Table<AnalysisLog, number>;
  fileHandles!: Table<FileHandleRecord, number>;

  constructor() {
    super('IdeographDB');

    this.version(1).stores({
      books: 'id, title, author, format, createdAt, updatedAt',
      ideas: 'id, bookId, chapterId, type, depth, familiarity, status, *pages, extractedAt',
      settings: '++id',
      pageCache: '++id, [bookId+pageNumber], bookId',
      analysisLog: '++id, bookId, startedAt',
    });

    // v2: add fileHandles table for persisting FileSystemFileHandle
    this.version(2).stores({
      fileHandles: '++id, bookId',
    });
  }
}

export const db = new IdeographDB();

// ---- Settings helpers (single-record table) ----

const DEFAULT_SETTINGS: Settings = {
  activeProvider: 'openrouter',
  providerKeys: {},
  activeModel: 'anthropic/claude-sonnet-4',
  ocrModel: 'google/gemini-2.0-flash-001',
  vlmModel: 'anthropic/claude-sonnet-4',
  fallbackModels: 'google/gemma-4-26b-a4b-it:free,openai/gpt-4o-mini,meta-llama/llama-3.1-70b-instruct',
  theme: 'system',
  language: 'ru',
  extractionDetail: 'medium',
};

export async function getSettings(): Promise<Settings> {
  const row = await db.settings.toCollection().first();
  if (row) return row;
  // Insert default
  await db.settings.add(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS };
}

export async function updateSettings(partial: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await db.settings.update(current.id!, partial);
}

// ---- File handle persistence helpers ----

export async function saveFileHandle(bookId: string, handle: FileSystemFileHandle): Promise<void> {
  const existing = await db.fileHandles.where('bookId').equals(bookId).first();
  if (existing) {
    await db.fileHandles.update(existing.id!, { handle: handle as unknown, savedAt: Date.now() });
  } else {
    await db.fileHandles.add({ bookId, handle: handle as unknown, savedAt: Date.now() });
  }
}

export async function loadFileHandle(bookId: string): Promise<FileSystemFileHandle | null> {
  const record = await db.fileHandles.where('bookId').equals(bookId).first();
  if (!record) return null;
  return record.handle as FileSystemFileHandle;
}

export async function removeFileHandle(bookId: string): Promise<void> {
  await db.fileHandles.where('bookId').equals(bookId).delete();
}
