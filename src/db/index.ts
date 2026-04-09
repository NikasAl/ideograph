import Dexie, { type Table } from 'dexie';
import type {
  Book,
  Idea,
  Settings,
  PageTextCache,
  AnalysisLog,
} from './schema.js';

class IdeographDB extends Dexie {
  books!: Table<Book, string>;
  ideas!: Table<Idea, string>;
  settings!: Table<Settings, number>;
  pageCache!: Table<PageTextCache, number>;
  analysisLog!: Table<AnalysisLog, number>;

  constructor() {
    super('IdeographDB');

    this.version(1).stores({
      books: 'id, title, author, format, createdAt, updatedAt',
      ideas: 'id, bookId, chapterId, type, depth, familiarity, status, *pages, extractedAt',
      settings: '++id',
      pageCache: '++id, [bookId+pageNumber], bookId',
      analysisLog: '++id, bookId, startedAt',
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
