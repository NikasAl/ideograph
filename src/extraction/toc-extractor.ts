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
import { extractTextFromPDFPage, renderPDFPageToImage, extractPDFOutline } from './text-extractor.js';
import type { PDFOutlineItem } from './text-extractor.js';

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
  format: 'pdf' | 'djvu';     // book format for correct renderer
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
  const { bookId, tocPages, mode, format, pdfData, provider, model, onProgress, requestDelayMs } = opts;
  const ocrModel = opts.ocrModel || model;
  const vlmModel = opts.vlmModel || model;
  const fallbackModels = opts.fallbackModels;

  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Книга ${bookId} не найдена`);

  const totalPagesCount = tocPages[1] - tocPages[0] + 1;

  if (mode === 'text') {
    return await extractTOCText({ bookId, tocPages, totalPagesCount, format, pdfData, provider, model, fallbackModels, requestDelayMs, onProgress, book });
  } else if (mode === 'ocr') {
    return await extractTOCOcr({ bookId, tocPages, totalPagesCount, format, pdfData, provider, model, ocrModel, fallbackModels, requestDelayMs, onProgress, book });
  } else {
    return await extractTOCVlm({ bookId, tocPages, totalPagesCount, format, pdfData, provider, vlmModel, fallbackModels, requestDelayMs, onProgress, book });
  }
}

// ============================================================
// Mode: OUTLINE — extract TOC from PDF built-in bookmarks
// ============================================================

export interface OutlineExtractionOptions {
  bookId: string;
  pdfData: ArrayBuffer;
  format?: 'pdf' | 'djvu';
  onProgress?: (msg: string, pct: number) => void;
}

/**
 * Extract TOC from PDF's built-in outline (bookmarks).
 * No LLM required — reads the document's embedded table-of-contents.
 *
 * Outline items have document page numbers. The function converts them
 * to book page numbers using the stored pageOffset.
 *
 * Returns null if the PDF has no outline.
 */
export async function extractTOCFromOutline(opts: OutlineExtractionOptions): Promise<TOCEntry[] | null> {
  const { bookId, pdfData, format, onProgress } = opts;

  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Книга ${bookId} не найдена`);

  const offset = book.pageOffset || 0;
  const isDJVU = format === 'djvu';

  onProgress?.(isDJVU ? 'Чтение bookmarks из DJVU...' : 'Чтение bookmarks из PDF...', 10);

  let entries: TOCEntry[];

  if (isDJVU) {
    // DJVU: use DjVu.js to read NAVM bookmarks
    const { extractDJVUBookmarks } = await import('./djvu-extractor.js');
    const bookmarks = extractDJVUBookmarks(pdfData);
    if (!bookmarks || bookmarks.length === 0) {
      return null;
    }
    onProgress?.(`Найдено ${bookmarks.length} элементов в bookmarks`, 40);
    const flatItems = flattenDJVUBookmarks(bookmarks);
    entries = buildEntriesFromOutline(flatItems, bookId, book.totalPages, offset);
  } else {
    // PDF: use pdfjsLib to read outline
    const outlineItems = await extractPDFOutline(pdfData);
    if (!outlineItems || outlineItems.length === 0) {
      return null;
    }
    onProgress?.(`Найдено ${outlineItems.length} элементов в bookmarks`, 40);
    entries = buildEntriesFromOutline(outlineItems, bookId, book.totalPages, offset);
  }

  onProgress?.('Вычисление диапазонов страниц...', 70);
  computePageRanges(entries, book.totalPages);

  onProgress?.(`Оглавление из bookmarks: ${entries.length} элементов`, 90);

  await db.books.update(bookId, { tableOfContents: entries, updatedAt: Date.now() });
  onProgress?.(`Готово! ${entries.length} элементов.`, 100);
  return entries;
}

/**
 * Convert PDF outline items to TOCEntry[] with proper parentId hierarchy.
 * Outline items arrive in DFS order; we build parent-child relationships
 * by tracking the nesting stack.
 */
function buildEntriesFromOutline(
  items: PDFOutlineItem[],
  bookId: string,
  totalPages: number,
  pageOffset: number,
): TOCEntry[] {
  const entries: TOCEntry[] = [];

  // Stack of (entryId, level) for tracking nesting
  const stack: Array<{ id: string; level: number }> = [];
  let counter = 0;

  for (const item of items) {
    // Convert document page → book page
    const bookPage = Math.max(1, Math.min(item.page - pageOffset, totalPages));

    const id = `${bookId}_toc_outline_${counter++}`;
    const level = Math.max(1, Math.min(item.level, 3));

    // Find parent: pop stack until we find an entry with a lower level
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    const parentId = stack.length > 0 ? stack[stack.length - 1].id : undefined;

    entries.push({
      id,
      title: item.title.trim(),
      page: bookPage,
      level,
      parentId,
    });

    // Push current entry onto stack (only if it has children or could be a parent)
    if (item.childCount > 0 || level < 3) {
      stack.push({ id, level });
    }
  }

  // Validate: remove entries with invalid parentId
  const validIds = new Set(entries.map(e => e.id));
  for (const entry of entries) {
    if (entry.parentId && !validIds.has(entry.parentId)) {
      entry.parentId = undefined;
    }
  }

  return entries;
}

/**
 * Flatten DJVU bookmarks (NAVM) tree into a PDFOutlineItem[] compatible list.
 * DJVU bookmarks have { description, url, children } structure.
 * URLs are like "#N" (page number) or "#id" (named reference).
 */
function flattenDJVUBookmarks(
  bookmarks: Array<{ description: string; url: string; children?: Array<{ description: string; url: string; children?: unknown[] }> }>,
): PDFOutlineItem[] {
  const items: PDFOutlineItem[] = [];

  function walk(nodes: typeof bookmarks, level: number): void {
    if (level > 3) return;
    for (const node of nodes) {
      const title = (node.description || '').trim();
      if (!title) continue;

      // Parse page from URL — format is "#N" or "#id"
      let page = 0;
      if (node.url && node.url.startsWith('#')) {
        const ref = node.url.slice(1);
        const num = Math.round(Number(ref));
        if (num >= 1) page = num;
      }

      const children = node.children || [];
      if (page > 0) {
        items.push({ title, page, level, childCount: children.length });
      }

      // Recurse into children
      if (children.length > 0) {
        walk(children as typeof bookmarks, level + 1);
      }
    }
  }

  walk(bookmarks, 1);
  return items;
}

// ============================================================
// Mode: TEXT — extract text, batch, send to LLM
// ============================================================

async function extractTOCText(opts: {
  bookId: string; tocPages: [number, number]; totalPagesCount: number;
  format: 'pdf' | 'djvu';
  pdfData: ArrayBuffer; provider: AIProvider; model: string;
  fallbackModels?: string[]; requestDelayMs?: number;
  onProgress?: (msg: string, pct: number) => void;
  book: { totalPages: number };
}): Promise<TOCEntry[]> {
  const { bookId, tocPages, totalPagesCount, format, pdfData, provider, model, fallbackModels, requestDelayMs, onProgress, book } = opts;

  // Step 1: Extract text from all TOC pages
  const pageTexts: Array<{ page: number; text: string }> = [];
  for (let p = tocPages[0]; p <= tocPages[1]; p++) {
    const pct = 5 + Math.round(((p - tocPages[0]) / totalPagesCount) * 15);
    onProgress?.(`Извлечение текста страницы ${p}...`, pct);
    try {
      const pageText = format === 'djvu'
        ? await (await import('./djvu-extractor.js')).extractTextFromDJVUPage(pdfData, p)
        : await extractTextFromPDFPage(pdfData, p);
      pageTexts.push({ page: p, text: pageText.text });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[TOC] Failed to extract text from page ${p}: ${errMsg}`);
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
  format: 'pdf' | 'djvu';
  pdfData: ArrayBuffer; provider: AIProvider; model: string; ocrModel: string;
  fallbackModels?: string[]; requestDelayMs?: number;
  onProgress?: (msg: string, pct: number) => void;
  book: { totalPages: number };
}): Promise<TOCEntry[]> {
  const { bookId, tocPages, totalPagesCount, format, pdfData, provider, model, ocrModel, fallbackModels, requestDelayMs, onProgress, book } = opts;

  // Phase 1: OCR each page to markdown
  const pageMarkdowns: Array<{ page: number; markdown: string }> = [];
  for (let p = tocPages[0]; p <= tocPages[1]; p++) {
    const pct = 5 + Math.round(((p - tocPages[0]) / totalPagesCount) * 25);
    onProgress?.(`OCR страницы ${p} оглавления...`, pct);

    if (p > tocPages[0] && requestDelayMs) await sleep(requestDelayMs);

    try {
      const imageBase64 = format === 'djvu'
        ? await (await import('./djvu-extractor.js')).renderDJVUPageToImage(pdfData, p)
        : await renderPDFPageToImage(pdfData, p);
      const visionMsg = buildVisionMessage({ pageNumber: p, imageBase64 }, ocrPageUserPrompt(p));
      const ocrResponse = await provider.chatVision(
        [{ role: 'system', content: OCR_TO_MARKDOWN_SYSTEM }, visionMsg],
        { model: ocrModel, fallbackModels },
      );
      pageMarkdowns.push({ page: p, markdown: ocrResponse.content.trim() });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[TOC] OCR page ${p} failed: ${errMsg}`);
      onProgress?.(`OCR страницы ${p} — ошибка, пробуем дальше...`, pct);
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
  format: 'pdf' | 'djvu';
  pdfData: ArrayBuffer; provider: AIProvider; vlmModel: string;
  fallbackModels?: string[]; requestDelayMs?: number;
  onProgress?: (msg: string, pct: number) => void;
  book: { totalPages: number };
}): Promise<TOCEntry[]> {
  const { bookId, tocPages, totalPagesCount, format, pdfData, provider, vlmModel, fallbackModels, requestDelayMs, onProgress, book } = opts;

  const allRawItems: RawTOCItem[] = [];

  for (let p = tocPages[0]; p <= tocPages[1]; p++) {
    const pct = 10 + Math.round(((p - tocPages[0]) / totalPagesCount) * 70);
    onProgress?.(`Анализ страницы ${p} через VLM...`, pct);

    if (p > tocPages[0] && requestDelayMs) await sleep(requestDelayMs);

    try {
      const imageBase64 = format === 'djvu'
        ? await (await import('./djvu-extractor.js')).renderDJVUPageToImage(pdfData, p)
        : await renderPDFPageToImage(pdfData, p);
      const visionMsgs: VisionMessage[] = [
        { role: 'system', content: EXTRACT_TOC_SYSTEM },
        buildVisionMessage({ pageNumber: p, imageBase64 }, extractTocUserVision([p])),
      ];
      const response = await provider.chatVision(visionMsgs, { model: vlmModel, fallbackModels, jsonMode: true, maxTokens: TOC_MAX_TOKENS });
      const partial = parseRawTOCResponse(response.content);
      allRawItems.push(...partial);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[TOC] VLM page ${p} failed: ${errMsg}`);
      onProgress?.(`VLM страница ${p} — ошибка, пробуем дальше...`, pct);
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
    entry.pageEnd = nextEntry ? Math.max(entry.page, nextEntry.page - 1) : totalPages;
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
 * Compute ideasCount for every TOC entry based on actual ideas in the DB.
 *
 * Each idea is assigned to the **most specific** (deepest level) TOC entry
 * whose page range contains the idea's first book-page.
 * Parent entries get the **recursive sum** of all descendant counts.
 *
 * Returns a new TOCEntry[] array with updated ideasCount values.
 */
export function computeIdeasCounts(
  toc: TOCEntry[],
  ideas: Array<{ pages: number[] }>,
  pageOffset: number,
): TOCEntry[] {
  if (toc.length === 0 || ideas.length === 0) {
    return toc.map(e => ({ ...e, ideasCount: 0 }));
  }

  // 1. Assign each idea to the most specific TOC entry (deepest level)
  const directCount = new Map<string, number>();

  for (const idea of ideas) {
    const bookPage = (idea.pages[0] || 1) - pageOffset;

    let bestEntry: TOCEntry | undefined;
    let bestLevel = 0;

    for (const entry of toc) {
      if (
        entry.pageEnd !== undefined &&
        bookPage >= entry.page &&
        bookPage <= entry.pageEnd
      ) {
        if (entry.level > bestLevel) {
          bestEntry = entry;
          bestLevel = entry.level;
        }
      }
    }

    if (bestEntry) {
      directCount.set(bestEntry.id, (directCount.get(bestEntry.id) || 0) + 1);
    }
  }

  // 2. For each entry, compute total = direct + recursive children
  const memo = new Map<string, number>();

  function subtreeTotal(entryId: string): number {
    if (memo.has(entryId)) return memo.get(entryId)!;
    const direct = directCount.get(entryId) || 0;
    let childrenSum = 0;
    for (const e of toc) {
      if (e.parentId === entryId) {
        childrenSum += subtreeTotal(e.id);
      }
    }
    const total = direct + childrenSum;
    memo.set(entryId, total);
    return total;
  }

  return toc.map(entry => ({
    ...entry,
    ideasCount: subtreeTotal(entry.id),
  }));
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
  // Step 0: If all items are level 1 (flat), try to infer hierarchy from § numbers
  // and chapter markers (ГЛАВА, ЧАСТЬ, etc.)
  const allLevel1 = rawItems.length > 0 && rawItems.every(item => (item.level ?? 1) <= 1);
  let items = rawItems;
  if (allLevel1 && rawItems.length > 5) {
    items = inferHierarchyFromFlat(rawItems);
  }

  // Step 1: Create entries with IDs
  const entries: TOCEntry[] = items.map((item, idx) => ({
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

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
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

/**
 * Infer hierarchy from a flat list of TOC items.
 * Detects chapters by:
 * 1. § numbered items → always level 2
 * 2. Items that look like chapter titles (short, no §, not preceded by §) → level 1
 *
 * Strategy:
 * - Group consecutive § items under a preceding non-§ item (chapter)
 * - If there's a non-§ item that looks like a chapter header (ГЛАВА, ЧАСТЬ, etc.) → level 1
 * - Otherwise, group § items into chapters by detecting gaps in § numbering
 */
function inferHierarchyFromFlat(items: RawTOCItem[]): RawTOCItem[] {
  const result: RawTOCItem[] = [...items];

  // Pattern: detect chapter markers in titles
  const chapterPattern = /^(глава|часть|раздел|chapter|part)\s/i;
  // Pattern: detect § markers
  const sectionPattern = /^§\s*\d+/i;

  // First pass: mark items with their detected type
  const types: Array<'chapter' | 'section' | 'unknown'> = result.map(item => {
    const title = (item.title || '').trim();
    if (chapterPattern.test(title)) return 'chapter';
    if (sectionPattern.test(title)) return 'section';
    return 'unknown';
  });

  // Count detected chapters
  const chapterCount = types.filter(t => t === 'chapter').length;

  if (chapterCount >= 2) {
    // We found chapter markers — use them as level 1
    // Everything between two chapters that has § → level 2, non-§ → level 2 too
    for (let i = 0; i < result.length; i++) {
      if (types[i] === 'chapter') {
        result[i].level = 1;
        result[i].parentTitle = undefined;
      } else {
        result[i].level = 2;
        // Find the preceding chapter as parent
        for (let j = i - 1; j >= 0; j--) {
          if (types[j] === 'chapter') {
            result[i].parentTitle = result[j].title;
            break;
          }
        }
      }
    }
  } else {
    // No explicit chapter markers — detect chapters by § number gaps
    // § numbering often restarts at each chapter (e.g., §1-8, then §9-17, etc.)
    // Group items where § numbers are consecutive into chapters

    // Find all § items and extract their numbers
    const sectionIndices: number[] = [];
    const sectionNumbers: number[] = [];

    for (let i = 0; i < result.length; i++) {
      const match = (result[i].title || '').match(/^§\s*(\d+)/i);
      if (match) {
        sectionIndices.push(i);
        sectionNumbers.push(parseInt(match[1]));
      }
    }

    // Detect chapter boundaries: gaps in § numbering > 1
    const chapterStarts = new Set<number>();
    chapterStarts.add(0); // First item starts a chapter
    for (let i = 1; i < sectionNumbers.length; i++) {
      // If § number doesn't follow previous (gap > 1), new chapter starts
      if (sectionNumbers[i] !== sectionNumbers[i - 1] + 1) {
        chapterStarts.add(sectionIndices[i]);
      }
    }

    // Create synthetic chapter entries from the items at chapter boundaries
    // (non-§ items before the first § in each group become chapters)
    const syntheticChapters: RawTOCItem[] = [];
    const chapterRanges: Array<{ start: number; end: number; chapterIdx: number }> = [];

    let currentChapterStart = 0;
    for (const start of chapterStarts) {
      if (start === currentChapterStart) continue;
      chapterRanges.push({ start: currentChapterStart, end: start - 1, chapterIdx: syntheticChapters.length });
      currentChapterStart = start;
    }
    chapterRanges.push({ start: currentChapterStart, end: result.length - 1, chapterIdx: syntheticChapters.length });

    // For each chapter range, find the first non-§ item as chapter title,
    // or use the first § item's general topic
    for (const range of chapterRanges) {
      let chapterTitle: string | undefined;

      // Look for a non-§ item at the start of this range (potential chapter title)
      for (let i = range.start; i <= Math.min(range.end, range.start + 2); i++) {
        if (!sectionPattern.test(result[i].title || '')) {
          chapterTitle = result[i].title;
          break;
        }
      }

      if (chapterTitle) {
        syntheticChapters.push({
          title: chapterTitle,
          page: result[range.start].page,
          level: 1,
        });
      } else {
        // No clear chapter title — create one from the first §
        const firstSection = result[range.start];
        const title = (firstSection.title || '').replace(/^§\s*\d+\.?\s*/i, '').split('.')[0].trim();
        syntheticChapters.push({
          title: title || `Глава ${range.chapterIdx + 1}`,
          page: firstSection.page,
          level: 1,
        });
      }
    }

    // Build final result: chapters + sections with parentTitle
    const finalResult: RawTOCItem[] = [];

    for (let c = 0; c < chapterRanges.length; c++) {
      const chapter = syntheticChapters[c];
      finalResult.push(chapter);

      const range = chapterRanges[c];
      for (let i = range.start; i <= range.end; i++) {
        const item = result[i];
        // Skip if this item was used as the chapter title
        if (item.title === chapter.title && item.page === chapter.page) continue;

        finalResult.push({
          ...item,
          level: 2,
          parentTitle: chapter.title,
        });
      }
    }

    return finalResult;
  }

  return result;
}

function clampLevel(level: number): number {
  if (level < 1) return 1;
  if (level > 3) return 3;
  return level;
}
