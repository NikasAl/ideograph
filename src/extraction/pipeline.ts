// ============================================================
// Extraction Pipeline — orchestrates idea extraction
// Supports 3 modes: text | ocr | vlm
//
// Architecture: pipeline runs in the NEW TAB page context.
// pdfData (ArrayBuffer) is passed from the caller (analysis-panel),
// which reads the file via File System Access API.
// ============================================================

import { db } from '../db/index.js';
import type { Idea, LLMExtractedIdea, ExtractionMode } from '../db/schema.js';
import type { AIProvider, ChatMessage } from '../background/ai-client.js';
import { evaluateTextLayer } from './mode-detector.js';
import { extractTextFromPDFRange, renderPDFPageToImage, extractTextFromPDFPage } from './text-extractor.js';
import { buildVisionMessage } from './vlm-extractor.js';
import { EXTRACT_IDEAS_SYSTEM, extractIdeasUserText, extractIdeasUserVision, DETAIL_INSTRUCTIONS } from './prompts/extract-ideas.js';
import { BUILD_RELATIONS_SYSTEM, buildRelationsUser } from './prompts/build-relations.js';
import { OCR_TO_MARKDOWN_SYSTEM, ocrPageUserPrompt } from './prompts/ocr-to-markdown.js';

export interface PipelineOptions {
  bookId: string;
  pageFrom: number;
  pageTo: number;
  mode: ExtractionMode;
  pdfData: ArrayBuffer;       // file content — caller is responsible for reading
  format: 'pdf' | 'djvu';     // book format for quality evaluation
  provider: AIProvider;
  model: string;               // text model for idea extraction
  ocrModel?: string;           // vision model for OCR phase
  vlmModel?: string;           // vision model for full VLM analysis
  fallbackModels?: string[];   // fallback models on rate-limit / errors
  detail: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  onProgress?: (message: string, percent: number) => void;
  /** Last successfully completed page (for resume support) */
  resumeFromPage?: number;
}

export interface PipelineResult {
  ideas: Idea[];
  relations: Array<{ source: string; target: string; type: string; description?: string }>;
  mode: ExtractionMode;
  pagesProcessed: number;
  textLayerReport?: { score: number; suggestedMode: ExtractionMode; reason: string };
}

/**
 * Run the full extraction pipeline.
 *
 * IMPORTANT: This function runs in the new tab page context.
 * It does NOT access the file system — pdfData must be provided by the caller.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const {
    bookId, pageFrom, pageTo, mode, pdfData, format,
    provider, model, detail, signal, onProgress,
  } = options;
  const ocrModel = options.ocrModel || model;
  const vlmModel = options.vlmModel || model;
  const fallbackModels = options.fallbackModels;

  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Книга ${bookId} не найдена`);

  const detailInstruction = DETAIL_INSTRUCTIONS[detail];

  // === Phase 0: Evaluate text layer quality for caching and logging ===
  onProgress?.('Оценка текстового слоя...', 5);
  let firstPageText;
  let qualityReport: ReturnType<typeof evaluateTextLayer>;
  try {
    firstPageText = await extractTextFromPDFPage(pdfData, pageFrom);
    qualityReport = evaluateTextLayer(firstPageText.text, format);
    // Cache text layer info
    await cacheTextLayer(bookId, pageFrom, firstPageText.text, firstPageText.hasTextLayer, qualityReport.score);
  } catch {
    qualityReport = { score: 0, issues: ['Не удалось извлечь текст'], suggestedMode: mode, reason: '', sampledPages: [], pageDetails: [] };
  }

  // Respect user's chosen mode — the UI already evaluated multiple pages and
  // recommended a mode. Do NOT override it based on a single-page re-evaluation.
  const effectiveMode = mode;

  onProgress?.(`Режим: ${effectiveMode.toUpperCase()}`, 8);

  try {
    // === MODE: TEXT ===
    if (effectiveMode === 'text') {
      return await runTextPipeline({ bookId, pageFrom, pageTo, provider, model, detailInstruction, pdfData, signal, onProgress, qualityReport, fallbackModels });
    }

    // === MODE: OCR ===
    if (effectiveMode === 'ocr') {
      return await runOcrPipeline({ bookId, pageFrom, pageTo, provider, model, ocrModel, detailInstruction, pdfData, signal, onProgress, qualityReport, fallbackModels });
    }

    // === MODE: VLM ===
    return await runVlmPipeline({ bookId, pageFrom, pageTo, provider, vlmModel, detailInstruction, pdfData, signal, onProgress, qualityReport, fallbackModels });
  } catch (err) {
    // Log error analysis for debugging and resume support
    await logAnalysisError(bookId, pageFrom, pageTo, effectiveMode, provider, model, err);
    throw err;
  }
}

/** Log a failed analysis so user can see what happened and resume from where stopped */
async function logAnalysisError(
  bookId: string, pageFrom: number, pageTo: number, mode: ExtractionMode,
  provider: AIProvider, model: string, err: unknown,
): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  await db.analysisLog.add({
    bookId,
    pageFrom,
    pageTo,
    mode,
    provider: provider.name,
    model,
    ideasCount: 0,
    relationsCount: 0,
    startedAt: Date.now(),
    completedAt: Date.now(),
    status: 'error',
    error: errMsg.length > 500 ? errMsg.slice(0, 500) : errMsg,
  });
}

// ============================================================
// Mode: TEXT — use text layer directly
// ============================================================

async function runTextPipeline(opts: {
  bookId: string; pageFrom: number; pageTo: number;
  provider: AIProvider; model: string; detailInstruction: string;
  pdfData: ArrayBuffer; signal?: AbortSignal;
  onProgress?: (msg: string, pct: number) => void;
  qualityReport: { score: number; suggestedMode: ExtractionMode; reason: string };
  fallbackModels?: string[];
}): Promise<PipelineResult> {
  const { bookId, pageFrom, pageTo, provider, model, detailInstruction, pdfData, signal, onProgress, qualityReport, fallbackModels } = opts;

  onProgress?.('Извлечение текста из страниц...', 10);
  const pagesText = await extractTextFromPDFRange(pdfData, pageFrom, pageTo);

  // Cache all pages text
  for (let i = 0; i < pagesText.length; i++) {
    await cacheTextLayer(bookId, pageFrom + i, pagesText[i].text, pagesText[i].hasTextLayer, 0.5);
  }

  onProgress?.('Анализ идей через LLM...', 30);
  const chunks = buildTextChunks(pagesText, pageFrom);
  const allExtractedIdeas: LLMExtractedIdea[] = [];
  let lastCompletedChunkPage = pageFrom - 1;

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const pct = 30 + Math.round((i / chunks.length) * 50);
    onProgress?.(`Анализ чанка ${i + 1}/${chunks.length}...`, pct);

    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: EXTRACT_IDEAS_SYSTEM + '\n\n' + detailInstruction },
        { role: 'user', content: extractIdeasUserText(chunks[i].text, chunks[i].pageRange) },
      ];

      const response = await provider.chat(messages, { model, fallbackModels, jsonMode: true });
      const parsed = parseIdeasResponse(response.content, chunks[i].pageRange);
      allExtractedIdeas.push(...parsed);
      lastCompletedChunkPage = chunks[i].pageRange[1];
    } catch (err) {
      // Save partial progress: update lastAnalyzedPage to last completed chunk's end page
      await updateLastAnalyzedPage(bookId, lastCompletedChunkPage);
      if (allExtractedIdeas.length > 0) {
        await savePartialIdeas(bookId, allExtractedIdeas, provider, model, pageFrom, lastCompletedChunkPage);
      }
      throw err;
    }
  }

  return finalizeIdeas({ bookId, allExtractedIdeas, provider, model, pageFrom, pageTo, onProgress, qualityReport, fallbackModels });
}

// ============================================================
// Mode: OCR — image → vision LLM → markdown+LaTeX → text LLM → ideas
// ============================================================

async function runOcrPipeline(opts: {
  bookId: string; pageFrom: number; pageTo: number;
  provider: AIProvider; model: string; ocrModel: string; detailInstruction: string;
  pdfData: ArrayBuffer; signal?: AbortSignal;
  onProgress?: (msg: string, pct: number) => void;
  qualityReport: { score: number; suggestedMode: ExtractionMode; reason: string };
  fallbackModels?: string[];
}): Promise<PipelineResult> {
  const { bookId, pageFrom, pageTo, provider, model, ocrModel, detailInstruction, pdfData, signal, onProgress, qualityReport, fallbackModels } = opts;

  // Phase 1: OCR — convert each page image to Markdown with LaTeX formulas
  onProgress?.('Рендеринг страниц и OCR-конвертация...', 10);
  const markdownPages: Array<{ page: number; markdown: string }> = [];
  let lastCompletedPage = pageFrom - 1;

  for (let p = pageFrom; p <= pageTo; p++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const pct = 10 + Math.round(((p - pageFrom) / (pageTo - pageFrom + 1)) * 35);
    onProgress?.(`OCR страницы ${p}...`, pct);

    try {
      const imageBase64 = await renderPDFPageToImage(pdfData, p);
      const visionMsg = buildVisionMessage(
        { pageNumber: p, imageBase64 },
        ocrPageUserPrompt(p),
      );

      const ocrResponse = await provider.chatVision(
        [{ role: 'system', content: OCR_TO_MARKDOWN_SYSTEM }, visionMsg],
        { model: ocrModel, fallbackModels },
      );

      const markdown = ocrResponse.content.trim();
      markdownPages.push({ page: p, markdown });
      lastCompletedPage = p;

      // Cache OCR result
      await db.pageCache.put({
        bookId,
        pageNumber: p,
        text: markdown,
        hasTextLayer: false,
        ocrMarkdown: markdown,
        imageBase64,
        qualityScore: 0,
        cachedAt: Date.now(),
      });
    } catch (err) {
      // Save partial progress: update lastAnalyzedPage to last completed page
      await updateLastAnalyzedPage(bookId, lastCompletedPage);
      throw err;
    }
  }

  // Phase 2: Extract ideas from concatenated Markdown
  onProgress?.('Извлечение идей из OCR-текста...', 50);
  const chunks = buildMarkdownChunks(markdownPages);
  const allExtractedIdeas: LLMExtractedIdea[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const pct = 50 + Math.round((i / chunks.length) * 30);
    onProgress?.(`Анализ чанка ${i + 1}/${chunks.length}...`, pct);

    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACT_IDEAS_SYSTEM + '\n\n' + detailInstruction },
      { role: 'user', content: extractIdeasUserText(chunks[i].text, chunks[i].pageRange) },
    ];

    const response = await provider.chat(messages, { model, fallbackModels, jsonMode: true });
    const parsed = parseIdeasResponse(response.content, chunks[i].pageRange);
    allExtractedIdeas.push(...parsed);
  }

  return finalizeIdeas({ bookId, allExtractedIdeas, provider, model, pageFrom, pageTo, onProgress, qualityReport, fallbackModels });
}

// ============================================================
// Mode: VLM — vision LLM analyzes page images directly
// ============================================================

async function runVlmPipeline(opts: {
  bookId: string; pageFrom: number; pageTo: number;
  provider: AIProvider; vlmModel: string; detailInstruction: string;
  pdfData: ArrayBuffer; signal?: AbortSignal;
  onProgress?: (msg: string, pct: number) => void;
  qualityReport: { score: number; suggestedMode: ExtractionMode; reason: string };
  fallbackModels?: string[];
}): Promise<PipelineResult> {
  const { bookId, pageFrom, pageTo, provider, vlmModel, detailInstruction, pdfData, signal, onProgress, qualityReport, fallbackModels } = opts;

  onProgress?.('Визуальный анализ страниц...', 10);
  const allExtractedIdeas: LLMExtractedIdea[] = [];
  let lastCompletedPage = pageFrom - 1;

  for (let p = pageFrom; p <= pageTo; p++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const pct = 10 + Math.round(((p - pageFrom) / (pageTo - pageFrom + 1)) * 70);
    onProgress?.(`Анализ страницы ${p} через vision LLM...`, pct);

    try {
      const imageBase64 = await renderPDFPageToImage(pdfData, p);
      const visionMsg = buildVisionMessage(
        { pageNumber: p, imageBase64 },
        extractIdeasUserVision(p),
      );

      const response = await provider.chatVision(
        [{ role: 'system', content: EXTRACT_IDEAS_SYSTEM + '\n\n' + detailInstruction }, visionMsg],
        { model: vlmModel, fallbackModels, jsonMode: true },
      );

      const parsed = parseIdeasResponse(response.content, [p, p]);
      allExtractedIdeas.push(...parsed);
      lastCompletedPage = p;
    } catch (err) {
      // Save partial progress: update lastAnalyzedPage to last completed page
      await updateLastAnalyzedPage(bookId, lastCompletedPage);
      // If we have partial ideas, save them
      if (allExtractedIdeas.length > 0) {
        await savePartialIdeas(bookId, allExtractedIdeas, provider, vlmModel, pageFrom, lastCompletedPage);
      }
      throw err;
    }
  }

  return finalizeIdeas({ bookId, allExtractedIdeas, provider, model: vlmModel, pageFrom, pageTo, onProgress, qualityReport, fallbackModels });
}

// ============================================================
// Common: deduplicate, build relations, save
// ============================================================

async function finalizeIdeas(opts: {
  bookId: string; allExtractedIdeas: LLMExtractedIdea[];
  provider: AIProvider; model: string; pageFrom: number; pageTo: number;
  onProgress?: (msg: string, pct: number) => void;
  qualityReport: { score: number; suggestedMode: ExtractionMode; reason: string };
  fallbackModels?: string[];
}): Promise<PipelineResult> {
  const { bookId, allExtractedIdeas, provider, model, pageFrom, pageTo, onProgress, qualityReport, fallbackModels } = opts;

  onProgress?.('Дедупликация идей...', 85);
  const uniqueIdeas = deduplicateIdeas(allExtractedIdeas);

  onProgress?.('Построение связей...', 90);
  const ideas = uniqueIdeas.map((extracted, idx) => ({
    id: `${bookId}_p${pageFrom}-${pageTo}_${idx}`,
    bookId,
    title: extracted.title,
    summary: extracted.summary,
    quote: extracted.quote,
    type: extracted.type,
    depth: extracted.depth,
    importance: extracted.importance,
    pages: extracted.pages,
    familiarity: 'unknown' as const,
    status: 'unseen' as const,
    notes: '',
    questions: [],
    userTags: extracted.tags || [],
    aiModel: model,
    provider: provider.name,
    extractedAt: Date.now(),
    relations: [] as import('../db/schema.js').Relation[],
  }));

  // === Pass 2: Build relations between ideas ===
  let relations: PipelineResult['relations'] = [];
  if (ideas.length >= 2) {
    const ideasJson = JSON.stringify(ideas.map((i) => ({
      id: i.id, title: i.title, summary: i.summary, type: i.type, pages: i.pages,
    })));

    const relMessages: ChatMessage[] = [
      { role: 'system', content: BUILD_RELATIONS_SYSTEM },
      { role: 'user', content: buildRelationsUser(ideasJson) },
    ];

    const relResponse = await provider.chat(relMessages, { model, fallbackModels, jsonMode: true });
    relations = parseRelationsResponse(relResponse.content, ideas.map((i) => i.id));

    for (const rel of relations) {
      const sourceIdea = ideas.find((i) => i.id === rel.source);
      if (sourceIdea) {
        sourceIdea.relations.push({
          targetId: rel.target,
          type: rel.type as 'prerequisite',
          description: rel.description,
        });
      }
    }
  }

  // === Save to DB ===
  onProgress?.('Сохранение...', 95);
  await db.ideas.bulkPut(ideas);
  const book = await db.books.get(bookId);
  if (book) {
    await db.books.update(bookId, {
      lastAnalyzedPage: Math.max(book.lastAnalyzedPage, pageTo),
      extractionMode: qualityReport.suggestedMode,
      updatedAt: Date.now(),
    });
  }

  // === Log analysis ===
  await db.analysisLog.add({
    bookId,
    pageFrom,
    pageTo,
    mode: qualityReport.suggestedMode,
    provider: provider.name,
    model,
    ideasCount: ideas.length,
    relationsCount: relations.length,
    startedAt: Date.now(),
    completedAt: Date.now(),
    status: 'success',
  });

  onProgress?.('Готово!', 100);
  return { ideas, relations, mode: qualityReport.suggestedMode, pagesProcessed: pageTo - pageFrom + 1, textLayerReport: qualityReport };
}

// ============================================================
// Helpers
// ============================================================

interface TextChunk {
  text: string;
  pageRange: [number, number];
}

function buildTextChunks(pages: Array<{ text: string }>, startPage: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  let current = '';
  let chunkStart = startPage;

  for (let i = 0; i < pages.length; i++) {
    const pageText = pages[i].text;
    if (current.length + pageText.length > 4000 && current.length > 0) {
      chunks.push({ text: current.trim(), pageRange: [chunkStart, startPage + i - 1] });
      current = pageText + '\n\n';
      chunkStart = startPage + i;
    } else {
      current += pageText + '\n\n';
    }
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), pageRange: [chunkStart, startPage + pages.length - 1] });
  }
  return chunks;
}

function buildMarkdownChunks(pages: Array<{ page: number; markdown: string }>): TextChunk[] {
  const chunks: TextChunk[] = [];
  let current = '';
  let chunkStart = pages[0]?.page || 0;
  let chunkEnd = chunkStart;

  for (const p of pages) {
    const md = p.markdown + '\n\n---\n\n';
    if (current.length + md.length > 5000 && current.length > 0) {
      chunks.push({ text: current.trim(), pageRange: [chunkStart, chunkEnd] });
      current = md;
      chunkStart = p.page;
    } else {
      current += md;
    }
    chunkEnd = p.page;
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), pageRange: [chunkStart, chunkEnd] });
  }
  return chunks;
}

async function cacheTextLayer(bookId: string, pageNumber: number, text: string, hasTextLayer: boolean, qualityScore: number): Promise<void> {
  const existing = await db.pageCache.where({ bookId, pageNumber }).first();
  if (existing) {
    // Don't overwrite text if OCR already stored a good markdown version
    const updateData: Record<string, unknown> = { hasTextLayer, qualityScore, cachedAt: Date.now() };
    if (!existing.ocrMarkdown) {
      updateData.text = text;
    }
    await db.pageCache.update(existing.id!, updateData);
  } else {
    await db.pageCache.add({ bookId, pageNumber, text, hasTextLayer, qualityScore, cachedAt: Date.now() });
  }
}

/** Update lastAnalyzedPage on the book to enable resume from this page */
async function updateLastAnalyzedPage(bookId: string, page: number): Promise<void> {
  if (page < 1) return;
  const book = await db.books.get(bookId);
  if (book && page > book.lastAnalyzedPage) {
    await db.books.update(bookId, { lastAnalyzedPage: page, updatedAt: Date.now() });
  }
}

/** Save partially extracted ideas to DB (without building relations) */
async function savePartialIdeas(
  bookId: string, ideas: LLMExtractedIdea[],
  provider: AIProvider, model: string, pageFrom: number, pageTo: number,
): Promise<void> {
  const uniqueIdeas = deduplicateIdeas(ideas);
  const ideaRecords = uniqueIdeas.map((extracted, idx) => ({
    id: `${bookId}_p${pageFrom}-${pageTo}_partial_${idx}`,
    bookId,
    title: extracted.title,
    summary: extracted.summary,
    quote: extracted.quote,
    type: extracted.type,
    depth: extracted.depth,
    importance: extracted.importance,
    pages: extracted.pages,
    familiarity: 'unknown' as const,
    status: 'unseen' as const,
    notes: '',
    questions: [],
    userTags: extracted.tags || [],
    aiModel: model,
    provider: provider.name,
    extractedAt: Date.now(),
    relations: [] as import('../db/schema.js').Relation[],
  }));

  await db.ideas.bulkPut(ideaRecords);
  console.log(`[Pipeline] Saved ${ideaRecords.length} partial ideas from pages ${pageFrom}-${pageTo}`);
}

function deduplicateIdeas(ideas: LLMExtractedIdea[]): LLMExtractedIdea[] {
  const seen = new Set<string>();
  return ideas.filter((idea) => {
    const key = idea.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseIdeasResponse(content: string, fallbackPageRange?: [number, number]): LLMExtractedIdea[] {
  try {
    const json = JSON.parse(content);
    const ideas = json.ideas || json;
    if (!Array.isArray(ideas)) return [];
    return ideas.map((raw: Record<string, unknown>) => normalizeExtractedIdea(raw, fallbackPageRange));
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        const ideas = json.ideas || json;
        if (Array.isArray(ideas)) return ideas.map((raw: Record<string, unknown>) => normalizeExtractedIdea(raw, fallbackPageRange));
      } catch { /* fall through */ }
    }
    return [];
  }
}

function normalizeExtractedIdea(raw: Record<string, unknown>, fallbackPageRange?: [number, number]): LLMExtractedIdea {
  let pages: number[] = [];
  if (Array.isArray(raw.pages)) {
    pages = raw.pages.map(Number).filter((n: number) => Number.isFinite(n));
  }
  // Fallback: if LLM didn't return pages, use the chunk's page range
  if (pages.length === 0 && fallbackPageRange) {
    const [from, to] = fallbackPageRange;
    pages = from === to ? [from] : [from, to];
  }
  return {
    title: String(raw.title || 'Без названия'),
    summary: String(raw.summary || ''),
    type: validateEnum(raw.type, ['definition', 'method', 'theorem', 'insight', 'example', 'analogy'], 'insight') as LLMExtractedIdea['type'],
    depth: validateEnum(raw.depth, ['basic', 'medium', 'advanced'], 'medium') as LLMExtractedIdea['depth'],
    importance: clamp(Number(raw.importance) || 3, 1, 5) as LLMExtractedIdea['importance'],
    pages,
    quote: raw.quote ? String(raw.quote) : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    requires: Array.isArray(raw.requires) ? raw.requires.map(String) : [],
  };
}

function parseRelationsResponse(content: string, validIds: string[]): PipelineResult['relations'] {
  try {
    const json = JSON.parse(content);
    const relations = json.relations || json;
    if (!Array.isArray(relations)) return [];
    return relations
      .filter((r: Record<string, unknown>) => validIds.includes(String(r.source)) && validIds.includes(String(r.target)))
      .map((r: Record<string, unknown>) => ({
        source: String(r.source),
        target: String(r.target),
        type: validateEnum(r.type, ['prerequisite', 'elaborates', 'contradicts', 'analogous', 'applies'], 'analogous'),
        description: r.description ? String(r.description) : undefined,
      }));
  } catch {
    return [];
  }
}

function validateEnum(value: unknown, valid: string[], fallback: string): string {
  if (typeof value === 'string' && valid.includes(value)) return value;
  return fallback;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
