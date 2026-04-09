// ============================================================
// Идеограф — Type definitions for the knowledge base
// ============================================================

// --- Book ---

export type BookFormat = 'pdf' | 'djvu';
export type ExtractionMode = 'text' | 'vlm';

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
  // FileSystemFileHandle is not serializable — store as opaque marker
  fileHandleStored: number; // 1 = handle is available
  tableOfContents: TOCEntry[];
  lastAnalyzedPage: number;
  createdAt: number;
  updatedAt: number;
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
  id?: number; // Dexie auto-increment for single-record table
  activeProvider: 'openrouter' | 'z-ai';
  providerKeys: ProviderKeys;
  activeModel: string;
  theme: 'light' | 'dark' | 'system';
  language: 'ru';
  extractionDetail: 'low' | 'medium' | 'high';
}

// --- Page text cache ---

export interface PageTextCache {
  id?: number; // Dexie auto-increment
  bookId: string;
  pageNumber: number;
  text: string;
  hasTextLayer: boolean;
  imageBase64?: string;
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
