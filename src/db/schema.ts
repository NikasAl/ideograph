// ============================================================
// Идеограф — Type definitions for the knowledge base
// ============================================================

// --- Book ---

export type BookFormat = 'pdf' | 'djvu';
export type ExtractionMode = 'text' | 'ocr' | 'vlm';

export interface ExtractionModeInfo {
  mode: ExtractionMode;
  label: string;
  description: string;
}

export const EXTRACTION_MODES: ExtractionModeInfo[] = [
  {
    mode: 'text',
    label: 'Текстовый',
    description: 'Использует текстовый слой PDF напрямую. Быстро и дёшево. Подходит если текст читаемый и формулы корректны.',
  },
  {
    mode: 'ocr',
    label: 'OCR + Текстовый анализ',
    description: 'Страница → изображение → Vision LLM конвертирует в Markdown с LaTeX формулами → Text LLM извлекает идеи. Два вызова, но формулы распознаются корректно.',
  },
  {
    mode: 'vlm',
    label: 'Полный визуальный анализ',
    description: 'Vision LLM анализирует страницу целиком (изображение). Один вызов, но дороже. Необходим для книг с чертежами, графиками, геометрией.',
  },
];

export interface TOCEntry {
  title: string;
  page: number;
  level: number; // 1=chapter, 2=section, 3=subsection
  parentId?: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  totalPages: number;
  format: BookFormat;
  extractionMode: ExtractionMode;
  filePath?: string;
  tableOfContents: TOCEntry[];
  lastAnalyzedPage: number;
  createdAt: number;
  updatedAt: number;
}

// --- File handle persistence ---
// FileSystemFileHandle IS structured-cloneable (Chrome 86+).
// Stored in IndexedDB to survive extension reloads and tab closures.

export interface FileHandleRecord {
  id?: number;
  bookId: string;
  handle: unknown; // FileSystemFileHandle (structured clone)
  savedAt: number;
}

// --- Ideas ---

export type IdeaType = 'definition' | 'method' | 'theorem' | 'insight' | 'example' | 'analogy';
export type IdeaDepth = 'basic' | 'medium' | 'advanced';
export type IdeaImportance = 1 | 2 | 3 | 4 | 5;
export type Familiarity = 'unknown' | 'known' | 'heard' | 'new';
export type IdeaStatus = 'unseen' | 'in_progress' | 'mastered' | 'applied' | 'confused';
export type RelationType = 'prerequisite' | 'elaborates' | 'contradicts' | 'analogous' | 'applies';

export interface Relation {
  targetId: string;
  type: RelationType;
  description?: string;
}

export interface Idea {
  id: string;
  bookId: string;
  chapterId?: string;

  // Content
  title: string;
  summary: string;
  quote?: string;

  // Classification
  type: IdeaType;
  depth: IdeaDepth;
  importance: IdeaImportance;

  // Position in book
  pages: number[];

  // User state
  familiarity: Familiarity;
  status: IdeaStatus;

  // User content
  notes: string;
  questions: string[];
  userTags: string[];

  // AI meta
  aiModel: string;
  provider: string;
  extractedAt: number;

  // Relations (denormalized)
  relations: Relation[];
}

// --- Settings ---

export interface ProviderKeys {
  openrouter?: string;
  'z-ai'?: string;
  gigachat?: string;
  kimi?: string;
  minimax?: string;
}

export interface Settings {
  id?: number;
  activeProvider: 'openrouter' | 'z-ai';
  providerKeys: ProviderKeys;
  activeModel: string;          // основная модель для извлечения идей (text)
  ocrModel: string;            // vision модель для OCR → Markdown+LaTeX
  vlmModel: string;            // vision модель для полного визуального анализа
  fallbackModels: string;      // запятые модели-заменители при 429/ошибках (для всех режимов)
  theme: 'light' | 'dark' | 'system';
  language: 'ru';
  extractionDetail: 'low' | 'medium' | 'high';
}

// --- Page text cache ---

export interface PageTextCache {
  id?: number;
  bookId: string;
  pageNumber: number;
  text: string;                // raw text from text layer
  hasTextLayer: boolean;
  ocrMarkdown?: string;         // OCR result: markdown with LaTeX
  imageBase64?: string;         // rendered page image for VLM
  qualityScore?: number;        // 0-1 text layer quality score
  cachedAt: number;
}

// --- Analysis log ---

export interface AnalysisLog {
  id?: number;
  bookId: string;
  pageFrom: number;
  pageTo: number;
  mode: ExtractionMode;
  provider: string;
  model: string;
  ideasCount: number;
  relationsCount: number;
  tokensUsed?: number;
  startedAt: number;
  completedAt: number;
  status: 'success' | 'error' | 'cancelled';
  error?: string;
}

// LLM response wrapper

export interface LLMExtractedIdea {
  title: string;
  summary: string;
  type: IdeaType;
  depth: IdeaDepth;
  importance: IdeaImportance;
  pages: number[];
  quote?: string;
  tags?: string[];
  requires?: string[];
}

export interface LLMRelation {
  source: string;
  target: string;
  type: RelationType;
  description?: string;
}
