// ============================================================
// TOC Extractor — extracts, parses, validates, and manages
// table-of-contents data for a book.
//
// Handles large TOCs by processing pages in batches.
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

/** Max tokens for TOC LLM response — needs to be high for large TOCs */
const TOC_MAX_TOKENS = 16384;

/** Pages per batch for text/OCR TOC extraction */
const TEXT_BATCH_SIZE = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  requestDelayMs?: number; // delay between API requests
  onProgress?: (msg: string, pct: number) => void;
}

/**
 * Full TOC extraction pipeline:
 * 1. Get text/images from TOC pages (in batches)
 * 2. Send to LLM with TOC prompt
 * 3. Parse, deduplicate and validate response
 * 4. Compute page ranges
 * 5. Save to book.tableOfContents
 */
export async function extractTOC(opts: TOCExtractionOptions): Promise<TOCEntry[]> {
  const { bookId, tocPages, mode, pdfData, provider, model, onProgress, requestDelayMs } = opts;
  const ocrModel = opts.ocrModel || model;
  const vlmModel = opts.vlmModel || model;
  const fallbackModels = opts.fallbackModels;

  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Книга ${bookId} не найдена`);

  const totalPagesCount = tocPages[1] - tocPages[0] + 1;

  if (mode === 'text') {
    return await extractTOCText({ bookId, tocPages, totalPagesCount, pdfData, provider, model, fallbackModels, requestDelayMs, onProgress, book });
  } else if (mode === 'ocr') {
    return await extractTOCOcr({ bookId, tocPages, totalPagesCount, pdfData, provider, model, ocrModel, fallbackModels, requestDelayMs, onProgress, book });
  } else {
    return await extractTOCVlm({ bookId, tocPages, totalPagesCount, pdfData, provider, vlmModel, fallbackModels, requestDelayMs, onProgress, book });
  }
}

// ============================================================
// Mode: TEXT — extract text, batch, send to LLM
// ============================================================

async function extractTOCText(opts: {
  bookId: string; tocPages: [number, number]; totalPagesCount: number;
  pdfData: ArrayBuffer; provider: AIProvider; model: string;
  fallbackModels?: string[]; requestDelayMs?: number;
  onProgress?: (msg: string, pct: number) => void;
  book: { totalPages: number };
}): Promise<TOCEntry[]> {
  const { bookId, tocPages, totalPagesCount, pdfData, provider, model, fallbackModels, requestDelayMs, onProgress, book } = opts;

  // Step 1: Extract text from all TOC pages
  const pageTexts: Array<{ page: number; text: string }> = [];
  for (let p = tocPages[0]; p <= tocPages[1]; p++) {
    const pct = 5 + Math.round(((p - tocPages[0]) / totalPagesCount) * 15);
    onProgress?.(`Извлечение текста страницы ${p}...`, pct);
    try {
      const pageText = await extractTextFromPDFPage(pdfData, p);
      pageTexts.push({ page: p, text: pageText.text });
    } catch (err) {
      console.warn(`[TOC] Failed to extract text from page ${p}:`, err);
      pageTexts.push({ page: p, text: '' });
    }
  }

  // Step 2: Split into batches
  const batches = splitIntoBatches(pageTexts, TEXT_BATCH_SIZE);

  // Step 3: Process each batch
  const allRawItems: RawTOCItem[] = [];
  for (let b = 0; b < batches.length; b++) {
    if (b > 0 && requestDelayMs) await sleep(requestDelayMs);

    const batch = batches[b];
    const batchRange = [batch[0].page, batch[batch.length - 1].page] as [number, number];
    const batchText = batch.map(p => p.text).join('\n\n');
    const pct = 25 + Math.round((b / batches.length) * 50);
    onProgress?.(`Распознавание (часть ${b + 1}/${batches.length}, стр. ${batchRange[0]}–${batchRange[1]})...`, pct);

    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACT_TOC_SYSTEM },
      { role: 'user', content: extractTocUserText(batchText, batchRange) },
    ];

    try {
      const response = await provider.chat(messages, { model, fallbackModels, jsonMode: true, maxTokens: TOC_MAX_TOKENS });
      const partial = parseRawTOCResponse(response.content);
      allRawItems.push(...partial);
    } catch (err) {
      console.warn(`[TOC] Batch ${b + 1} failed:`, err);
      // Continue with other batches rather than failing completely
    }
  }

  if (allRawItems.length === 0) {
    throw new Error('Не удалось извлечь ни одного элемента оглавления. Проверьте диапазон страниц и режим экстракции.');
  }

  // Step 4: Deduplicate and build entries
  return finalizeExtraction(allRawItems, bookId, book.totalPages, onProgress);
}

// ============================================================
// Mode: OCR — render pages, OCR each, batch text, send to LLM
// ============================================================

async function extractTOCOcr(opts: {
  bookId: string; tocPages: [number, number]; totalPagesCount: number;
  pdfData: ArrayBuffer; provider: AIProvider; model: string; ocrModel: string;
  fallbackModels?: string[]; requestDelayMs?: number;
  onProgress?: (msg: string, pct: number) => void;
  book: { totalPages: number };
}): Promise<TOCEntry[]> {
  const { bookId, tocPages, totalPagesCount, pdfData, provider, model, ocrModel, fallbackModels, requestDelayMs, onProgress, book } = opts;

  // Phase 1: OCR each page to markdown
  const pageMarkdowns: Array<{ page: number; markdown: string }> = [];
  for (let p = tocPages[0]; p <= tocPages[1]; p++) {
    const pct = 5 + Math.round(((p - tocPages[0]) / totalPagesCount) * 25);
    onProgress?.(`OCR страницы ${p} оглавления...`, pct);

    if (p > tocPages[0] && requestDelayMs) await sleep(requestDelayMs);

    try {
      const imageBase64 = await renderPDFPageToImage(pdfData, p);
      const visionMsg = buildVisionMessage({ pageNumber: p, imageBase64 }, ocrPageUserPrompt(p));
      const ocrResponse = await provider.chatVision(
        [{ role: 'system', content: OCR_TO_MARKDOWN_SYSTEM }, visionMsg],
        { model: ocrModel, fallbackModels },
      );
      pageMarkdowns.push({ page: p, markdown: ocrResponse.content.trim() });
    } catch (err) {
      console.warn(`[TOC] OCR page ${p} failed:`, err);
      pageMarkdowns.push({ page: p, markdown: '' });
    }
  }

  // Phase 2: Batch OCR results and extract TOC structure
  const batches = splitIntoBatches(pageMarkdowns, TEXT_BATCH_SIZE);
  const allRawItems: RawTOCItem[] = [];

  for (let b = 0; b < batches.length; b++) {
    if (requestDelayMs) await sleep(requestDelayMs);

    const batch = batches[b];
    const batchRange = [batch[0].page, batch[batch.length - 1].page] as [number, number];
    const batchText = batch.map(p => p.markdown).join('\n\n---\n\n');
    const pct = 35 + Math.round((b / batches.length) * 45);
    onProgress?.(`Распознавание структуры (часть ${b + 1}/${batches.length})...`, pct);

    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACT_TOC_SYSTEM },
      { role: 'user', content: extractTocUserText(batchText, batchRange) },
    ];

    try {
      const response = await provider.chat(messages, { model, fallbackModels, jsonMode: true, maxTokens: TOC_MAX_TOKENS });
      const partial = parseRawTOCResponse(response.content);
      allRawItems.push(...partial);
    } catch (err) {
      console.warn(`[TOC] Batch ${b + 1} failed:`, err);
    }
  }

  if (allRawItems.length === 0) {
    throw new Error('Не удалось извлечь ни одного элемента оглавления. Проверьте диапазон страниц и режим экстракции.');
  }

  return finalizeExtraction(allRawItems, bookId, book.totalPages, onProgress);
}

// ============================================================
// Mode: VLM — vision LLM analyzes page images directly
// ============================================================

async function extractTOCVlm(opts: {
  bookId: string; tocPages: [number, number]; totalPagesCount: number;
  pdfData: ArrayBuffer; provider: AIProvider; vlmModel: string;
  fallbackModels?: string[]; requestDelayMs?: number;
  onProgress?: (msg: string, pct: number) => void;
  book: { totalPages: number };
}): Promise<TOCEntry[]> {
  const { bookId, tocPages, totalPagesCount, pdfData, provider, vlmModel, fallbackModels, requestDelayMs, onProgress, book } = opts;

  const allRawItems: RawTOCItem[] = [];

  for (let p = tocPages[0]; p <= tocPages[1]; p++) {
    const pct = 10 + Math.round(((p - tocPages[0]) / totalPagesCount) * 70);
    onProgress?.(`Анализ страницы ${p} через VLM...`, pct);

    if (p > tocPages[0] && requestDelayMs) await sleep(requestDelayMs);

    try {
      const imageBase64 = await renderPDFPageToImage(pdfData, p);
      const visionMsgs: VisionMessage[] = [
        { role: 'system', content: EXTRACT_TOC_SYSTEM },
        buildVisionMessage({ pageNumber: p, imageBase64 }, extractTocUserVision([p])),
      ];
      const response = await provider.chatVision(visionMsgs, { model: vlmModel, fallbackModels, jsonMode: true, maxTokens: TOC_MAX_TOKENS });
      const partial = parseRawTOCResponse(response.content);
      allRawItems.push(...partial);
    } catch (err) {
      console.warn(`[TOC] VLM page ${p} failed:`, err);
    }
  }

  if (allRawItems.length === 0) {
    throw new Error('Не удалось извлечь ни одного элемента оглавления. Проверьте диапазон страниц и режим экстракции.');
  }

  return finalizeExtraction(allRawItems, bookId, book.totalPages, onProgress);
}

// ============================================================
// Common: deduplicate, build entries, compute ranges, save
// ============================================================

async function finalizeExtraction(
  rawItems: RawTOCItem[],
  bookId: string,
  totalPages: number,
  onProgress?: (msg: string, pct: number) => void,
): Promise<TOCEntry[]> {
  // Deduplicate by title+page
  const seen = new Set<string>();
  const uniqueItems = rawItems.filter(item => {
    const key = `${(item.title || '').toLowerCase().trim()}_${item.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  onProgress?.('Обработка результатов...', 85);
  const entries = buildTOCEntries(uniqueItems, bookId, totalPages);
  computePageRanges(entries, totalPages);

  await db.books.update(bookId, { tableOfContents: entries, updatedAt: Date.now() });
  onProgress?.(`Оглавление извлечено! ${entries.length} элементов.`, 100);
  return entries;
}

/** Split an array into chunks of at most `size` elements */
function splitIntoBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// ============================================================
// Summarization
// ============================================================

export interface SummarizeOptions {
  bookId: string;
  provider: AIProvider;
  model: string;
  fallbackModels?: string[];
  requestDelayMs?: number;
  onProgress?: (msg: string, pct: number) => void;
}

/**
 * Generate summaries for all TOC entries that don't have one yet.
 * Processes chapters (level 1) only for cost efficiency.
 */
export async function summarizeTOCChapters(opts: SummarizeOptions): Promise<void> {
  const { bookId, provider, model, fallbackModels, requestDelayMs, onProgress } = opts;
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

    if (i > 0 && requestDelayMs) await sleep(requestDelayMs);

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
 * @param page — book page number (NOT document page)
 */
export function findChapterForPage(page: number, toc: TOCEntry[]): TOCEntry | undefined {
  return toc
    .filter(e => e.level === 1 && e.pageEnd !== undefined)
    .find(e => page >= e.page && page <= e.pageEnd!);
}

/**
 * Re-assign chapterId to ideas based on their pages and the book's pageOffset.
 * Converts document page numbers to book page numbers before matching.
 */
export function assignChapterIds(ideas: Array<{ id: string; pages: number[]; chapterId?: string }>, toc: TOCEntry[], pageOffset: number): void {
  if (toc.length === 0) return;
  const chapters = toc.filter(e => e.level === 1 && e.pageEnd !== undefined);
  for (const idea of ideas) {
    const bookPage = (idea.pages[0] || 1) - pageOffset;
    const chapter = chapters.find(e => bookPage >= e.page && bookPage <= e.pageEnd!);
    idea.chapterId = chapter?.id;
  }
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

  // Step 3: Positional fallback — for entries without parentId, find closest preceding higher-level entry
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
