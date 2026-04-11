// ============================================================
// TOC Extractor — extracts, parses, validates, and manages
// table-of-contents data for a book.
// ============================================================

import type { AIProvider, ChatMessage, VisionMessage } from '../background/ai-client.js';
import type { TOCEntry } from '../db/schema.js';
import {
  EXTRACT_TOC_SYSTEM, extractTocUserText, extractTocUserVision,
  SUMMARIZE_CHAPTER_SYSTEM, summarizeChapterUser, chapterContextBlock,
} from './prompts/toc-prompts.js';
import { buildVisionMessage } from './vlm-extractor.js';
import { OCR_TO_MARKDOWN_SYSTEM, ocrPageUserPrompt } from './prompts/ocr-to-markdown.js';
import { db } from '../db/index.js';
import { extractTextFromPDFPage, renderPDFPageToImage } from './text-extractor.js';

// ============================================================
// Public API
// ============================================================

export interface TOCExtractionOptions {
  bookId: string;
  tocPages: [number, number];  // range of TOC pages
  mode: 'text' | 'ocr' | 'vlm';
  pdfData: ArrayBuffer;
  provider: AIProvider;
  model: string;          // text model
  ocrModel?: string;      // vision model for OCR
  vlmModel?: string;      // vision model for VLM
  fallbackModels?: string[];
  onProgress?: (msg: string, pct: number) => void;
}

/**
 * Full TOC extraction pipeline:
 * 1. Get text/images from TOC pages
 * 2. Send to LLM with TOC prompt
 * 3. Parse and validate response
 * 4. Compute page ranges
 * 5. Save to book.tableOfContents
 */
export async function extractTOC(opts: TOCExtractionOptions): Promise<TOCEntry[]> {
  const { bookId, tocPages, mode, pdfData, provider, model, onProgress } = opts;
  const ocrModel = opts.ocrModel || model;
  const vlmModel = opts.vlmModel || model;
  const fallbackModels = opts.fallbackModels;

  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Книга ${bookId} не найдена`);

  onProgress?.('Извлечение страниц оглавления...', 10);

  let tocText: string;

  if (mode === 'text') {
    // Text mode: extract text from pages, concatenate
    const texts: string[] = [];
    for (let p = tocPages[0]; p <= tocPages[1]; p++) {
      const pageText = await extractTextFromPDFPage(pdfData, p);
      texts.push(pageText.text);
    }
    tocText = texts.join('\n\n');

    onProgress?.('Распознавание оглавления через LLM...', 40);
    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACT_TOC_SYSTEM },
      { role: 'user', content: extractTocUserText(tocText, tocPages) },
    ];
    const response = await provider.chat(messages, { model, fallbackModels, jsonMode: true });
    tocText = response.content;

  } else if (mode === 'ocr') {
    // OCR mode: render → vision LLM → markdown → text LLM
    const markdowns: string[] = [];
    for (let p = tocPages[0]; p <= tocPages[1]; p++) {
      onProgress?.(`OCR страницы ${p} оглавления...`, 10 + Math.round(((p - tocPages[0]) / (tocPages[1] - tocPages[0] + 1)) * 30));
      const imageBase64 = await renderPDFPageToImage(pdfData, p);
      const visionMsg = buildVisionMessage({ pageNumber: p, imageBase64 }, ocrPageUserPrompt(p));
      const ocrResponse = await provider.chatVision(
        [{ role: 'system', content: OCR_TO_MARKDOWN_SYSTEM }, visionMsg],
        { model: ocrModel, fallbackModels },
      );
      markdowns.push(ocrResponse.content.trim());
    }

    onProgress?.('Распознавание оглавления через LLM...', 50);
    const combinedMarkdown = markdowns.join('\n\n---\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACT_TOC_SYSTEM },
      { role: 'user', content: extractTocUserText(combinedMarkdown, tocPages) },
    ];
    const response = await provider.chat(messages, { model, fallbackModels, jsonMode: true });
    tocText = response.content;

  } else {
    // VLM mode: render → vision LLM directly
    const pageNumbers: number[] = [];
    const visionMessages: VisionMessage[] = [
      { role: 'system', content: EXTRACT_TOC_SYSTEM },
    ];

    for (let p = tocPages[0]; p <= tocPages[1]; p++) {
      onProgress?.(`Анализ страницы ${p} оглавления через VLM...`, 10 + Math.round(((p - tocPages[0]) / (tocPages[1] - tocPages[0] + 1)) * 30));
      const imageBase64 = await renderPDFPageToImage(pdfData, p);
      pageNumbers.push(p);
      if (p === tocPages[0]) {
        // First page — create user message
        const visionMsg = buildVisionMessage({ pageNumber: p, imageBase64 }, extractTocUserVision(pageNumbers));
        visionMessages.push(visionMsg);
      } else {
        // Additional pages — append images to existing user message
        // For multi-page TOC, we send each page separately to avoid token limits
        const singlePageMsgs: VisionMessage[] = [
          { role: 'system', content: EXTRACT_TOC_SYSTEM },
          buildVisionMessage({ pageNumber: p, imageBase64 }, extractTocUserVision([p])),
        ];
        const response = await provider.chatVision(singlePageMsgs, { model: vlmModel, fallbackModels, jsonMode: true });
        const partial = parseRawTOCResponse(response.content);
        if (partial.length > 0) {
          // Store partial results
          if (!_partialEntries) _partialEntries = [];
          _partialEntries.push(...partial);
        }
        continue;
      }
    }

    if (visionMessages.length > 1) {
      // Process first page result
      const response = await provider.chatVision(visionMessages, { model: vlmModel, fallbackModels, jsonMode: true });
      tocText = response.content;
    } else {
      tocText = '[]';
    }

    // Merge with partial entries from subsequent pages
    const mainEntries = parseRawTOCResponse(tocText);
    const partialEntries = _partialEntries || [];
    // Combine and deduplicate
    const allRaw = [...mainEntries, ...partialEntries];
    _partialEntries = undefined;

    onProgress?.('Обработка результатов...', 70);
    const entries = buildTOCEntries(allRaw, bookId, book.totalPages);
    computePageRanges(entries, book.totalPages);

    await db.books.update(bookId, { tableOfContents: entries, updatedAt: Date.now() });
    onProgress?.('Оглавление извлечено!', 100);
    return entries;
  }

  // For text and OCR modes — parse the single response
  onProgress?.('Обработка результатов...', 70);
  const rawEntries = parseRawTOCResponse(tocText);
  const entries = buildTOCEntries(rawEntries, bookId, book.totalPages);
  computePageRanges(entries, book.totalPages);

  await db.books.update(bookId, { tableOfContents: entries, updatedAt: Date.now() });
  onProgress?.('Оглавление извлечено!', 100);
  return entries;
}

// Temporary storage for multi-page VLM partial results
let _partialEntries: RawTOCItem[] | undefined;

// ============================================================
// Summarization
// ============================================================

export interface SummarizeOptions {
  bookId: string;
  provider: AIProvider;
  model: string;
  fallbackModels?: string[];
  onProgress?: (msg: string, pct: number) => void;
}

/**
 * Generate summaries for all TOC entries that don't have one yet.
 * Processes chapters (level 1) only for cost efficiency.
 */
export async function summarizeTOCChapters(opts: SummarizeOptions): Promise<void> {
  const { bookId, provider, model, fallbackModels, onProgress } = opts;
  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Книга ${bookId} не найдена`);

  const toc = book.tableOfContents;
  const chapters = toc.filter(e => e.level === 1 && !e.summary);
  if (chapters.length === 0) {
    onProgress?.('Все главы уже имеют описания', 100);
    return;
  }

  for (let i = 0; i < chapters.length; i++) {
    const pct = Math.round(((i + 1) / chapters.length) * 100);
    onProgress?.(`Суммаризация главы ${i + 1}/${chapters.length}: ${chapters[i].title}...`, pct);

    const messages: ChatMessage[] = [
      { role: 'system', content: SUMMARIZE_CHAPTER_SYSTEM },
      { role: 'user', content: summarizeChapterUser(chapters[i].title) },
    ];

    try {
      const response = await provider.chat(messages, { model, fallbackModels });
      const summary = response.content.trim();
      chapters[i].summary = summary;
    } catch {
      chapters[i].summary = '(ошибка генерации)';
    }
  }

  // Merge updated chapters back into TOC
  const updatedTOC = toc.map(entry => {
    const updated = chapters.find(c => c.id === entry.id);
    return updated ? { ...entry, summary: updated.summary } : entry;
  });

  await db.books.update(bookId, { tableOfContents: updatedTOC, updatedAt: Date.now() });
  onProgress?.('Суммаризация завершена!', 100);
}

// ============================================================
// Page Range Computation
// ============================================================

/**
 * Compute pageEnd for each TOCEntry based on the next entry at the same or higher level.
 */
export function computePageRanges(entries: TOCEntry[], totalPages: number): void {
  const sorted = [...entries].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return a.level - b.level;
  });

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    let nextEntry: TOCEntry | undefined;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].level <= entry.level) {
        nextEntry = sorted[j];
        break;
      }
    }
    entry.pageEnd = nextEntry ? nextEntry.page - 1 : totalPages;
  }
}

// ============================================================
// Chapter Resolution
// ============================================================

/**
 * Find the top-level chapter (level 1) that contains the given page.
 */
export function findChapterForPage(page: number, toc: TOCEntry[]): TOCEntry | undefined {
  return toc
    .filter(e => e.level === 1 && e.pageEnd !== undefined)
    .find(e => page >= e.page && page <= e.pageEnd!);
}

/**
 * Get the chapter context string for injection into idea extraction prompts.
 */
export function getChapterContext(pageFrom: number, toc: TOCEntry[]): string | null {
  const chapter = findChapterForPage(pageFrom, toc);
  if (!chapter) return null;

  return chapterContextBlock(chapter.title, chapter.page, chapter.pageEnd!, chapter.summary);
}

// ============================================================
// Raw LLM Response Parsing
// ============================================================

interface RawTOCItem {
  title?: string;
  page?: number;
  level?: number;
  parentTitle?: string;
}

function parseRawTOCResponse(content: string): RawTOCItem[] {
  try {
    const json = JSON.parse(content);
    const items = Array.isArray(json) ? json : (json.entries || json.toc || []);
    if (!Array.isArray(items)) return [];
    return items.map((raw: Record<string, unknown>) => ({
      title: String(raw.title || ''),
      page: Number(raw.page) || 0,
      level: clampLevel(Number(raw.level) || 1),
      parentTitle: raw.parentTitle ? String(raw.parentTitle) : undefined,
    })).filter(item => item.title.length > 0 && item.page > 0);
  } catch {
    // Try to extract JSON from markdown code block
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        const items = Array.isArray(json) ? json : (json.entries || json.toc || []);
        if (!Array.isArray(items)) return [];
        return items.map((raw: Record<string, unknown>) => ({
          title: String(raw.title || ''),
          page: Number(raw.page) || 0,
          level: clampLevel(Number(raw.level) || 1),
          parentTitle: raw.parentTitle ? String(raw.parentTitle) : undefined,
        })).filter(item => item.title.length > 0 && item.page > 0);
      } catch { /* fall through */ }
    }
    return [];
  }
}

// ============================================================
// Build Validated TOCEntry[]
// ============================================================

function buildTOCEntries(rawItems: RawTOCItem[], bookId: string, totalPages: number): TOCEntry[] {
  // Step 1: Create entries with IDs
  const entries: TOCEntry[] = rawItems.map((item, idx) => ({
    id: `${bookId}_toc_${idx}`,
    title: (item.title || '').trim(),
    page: Math.max(1, Math.min(item.page ?? 1, totalPages)),
    level: item.level ?? 1,
    parentId: undefined as string | undefined,
  }));

  // Step 2: Resolve parentId from parentTitle
  // Build title → id map for matching
  const titleToId = new Map<string, string>();
  for (const entry of entries) {
    titleToId.set(entry.title.toLowerCase().trim(), entry.id);
  }

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    if (item?.parentTitle && item.level && item.level > 1) {
      const parentId = titleToId.get(item.parentTitle.toLowerCase().trim());
      if (parentId && parentId !== entries[i].id) {
        entries[i].parentId = parentId;
      }
    }
  }

  // Step 3: If parentId resolution failed, try positional fallback
  // For level > 1 entries without parentId, find closest preceding level-1 entry
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].level > 1 && !entries[i].parentId) {
      for (let j = i - 1; j >= 0; j--) {
        if (entries[j].level < entries[i].level) {
          entries[i].parentId = entries[j].id;
          break;
        }
      }
    }
  }

  // Step 4: Validate hierarchy (remove entries with invalid parentId)
  const validIds = new Set(entries.map(e => e.id));
  for (const entry of entries) {
    if (entry.parentId && !validIds.has(entry.parentId)) {
      entry.parentId = undefined;
    }
  }

  return entries;
}

function clampLevel(level: number): number {
  if (level < 1) return 1;
  if (level > 3) return 3;
  return level;
}
