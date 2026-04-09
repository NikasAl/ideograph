// ============================================================
// Extraction Pipeline — orchestrates the full idea extraction
// ============================================================

import { db } from '../db/index.js';
import type { Idea, LLMExtractedIdea, LLMRelation, Book } from '../db/schema.js';
import type { AIProvider, ChatMessage, VisionMessage } from '../background/ai-client.js';
import { detectMode } from './mode-detector.js';
import { extractTextFromPDFRange, renderPDFPageToImage, getPDFPageCount, extractTextFromPDFPage } from './text-extractor.js';
import { buildVisionMessage } from './vlm-extractor.js';
import { EXTRACT_IDEAS_SYSTEM, extractIdeasUserText, extractIdeasUserVision, DETAIL_INSTRUCTIONS } from './prompts/extract-ideas.js';
import { BUILD_RELATIONS_SYSTEM, buildRelationsUser } from './prompts/build-relations.js';

export interface PipelineOptions {
  bookId: string;
  pageFrom: number;
  pageTo: number;
  provider: AIProvider;
  model: string;
  detail: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface PipelineResult {
  ideas: Idea[];
  relations: Array<{ source: string; target: string; type: string; description?: string }>;
  mode: 'text' | 'vlm';
  pagesProcessed: number;
}

/**
 * Run the full extraction pipeline:
 * 1. Detect mode (text vs VLM)
 * 2. Pass 1: Extract ideas from each chunk
 * 3. Deduplicate ideas
 * 4. Pass 2: Build relations between ideas
 * 5. Save to IndexedDB
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { bookId, pageFrom, pageTo, provider, model, detail, signal } = options;

  const book = await db.books.get(bookId);
  if (!book) throw new Error(`Книга ${bookId} не найдена`);

  // Step 1: Get file data
  const fileHandle = await getFileHandleFromBook(book);
  if (!fileHandle) throw new Error('Нет доступа к файлу книги');

  const file = await fileHandle.getFile();
  const pdfData = await file.arrayBuffer();

  // Step 2: Detect mode from first page
  const firstPageText = await extractTextFromPDFPage(pdfData, pageFrom);
  const detection = detectMode(firstPageText.text, book.format);
  const mode = detection.mode;

  // Step 3: Pass 1 — Extract ideas
  const allExtractedIdeas: LLMExtractedIdea[] = [];
  const detailInstruction = DETAIL_INSTRUCTIONS[detail];

  if (mode === 'text') {
    // Text mode: extract text, chunk, send to LLM
    const pagesText = await extractTextFromPDFRange(pdfData, pageFrom, pageTo);
    const chunks = buildTextChunks(pagesText, pageFrom);

    for (const chunk of chunks) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const messages: ChatMessage[] = [
        { role: 'system', content: EXTRACT_IDEAS_SYSTEM + '\n\n' + detailInstruction },
        { role: 'user', content: extractIdeasUserText(chunk.text, chunk.pageRange) },
      ];

      const response = await provider.chat(messages, { model, jsonMode: true });
      const parsed = parseIdeasResponse(response.content);
      allExtractedIdeas.push(...parsed);
    }
  } else {
    // VLM mode: render pages, send to vision LLM
    for (let p = pageFrom; p <= pageTo; p++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const imageBase64 = await renderPDFPageToImage(pdfData, p);
      const visionMsg = buildVisionMessage(
        { pageNumber: p, imageBase64 },
        extractIdeasUserVision(p),
      );

      const response = await provider.chatVision(
        [{ role: 'system', content: EXTRACT_IDEAS_SYSTEM + '\n\n' + detailInstruction }, visionMsg],
        { model, jsonMode: true },
      );

      const parsed = parseIdeasResponse(response.content);
      allExtractedIdeas.push(...parsed);
    }
  }

  // Step 4: Deduplicate
  const uniqueIdeas = deduplicateIdeas(allExtractedIdeas);

  // Step 5: Convert to Idea objects
  const ideas: Idea[] = uniqueIdeas.map((extracted, idx) => ({
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
    relations: [],
  }));

  // Step 6: Pass 2 — Build relations
  let relations: PipelineResult['relations'] = [];
  if (ideas.length >= 2) {
    const ideasJson = JSON.stringify(ideas.map((i) => ({
      id: i.id,
      title: i.title,
      summary: i.summary,
      type: i.type,
      pages: i.pages,
    })));

    const relMessages: ChatMessage[] = [
      { role: 'system', content: BUILD_RELATIONS_SYSTEM },
      { role: 'user', content: buildRelationsUser(ideasJson) },
    ];

    const relResponse = await provider.chat(relMessages, { model, jsonMode: true });
    relations = parseRelationsResponse(relResponse.content, ideas.map((i) => i.id));

    // Merge relations into ideas
    for (const rel of relations) {
      const sourceIdea = ideas.find((i) => i.id === rel.source);
      if (sourceIdea) {
        sourceIdea.relations.push({
          targetId: rel.target,
          type: rel.type as Idea['relations'][0]['type'],
          description: rel.description,
        });
      }
    }
  }

  // Step 7: Save to DB
  await db.ideas.bulkPut(ideas);
  await db.books.update(bookId, { lastAnalyzedPage: Math.max(book.lastAnalyzedPage, pageTo) });

  return { ideas, relations, mode, pagesProcessed: pageTo - pageFrom + 1 };
}

// ============================================================
// Helpers
// ============================================================

interface TextChunk {
  text: string;
  pageRange: [number, number];
}

function buildTextChunks(
  pages: Array<{ text: string }>,
  startPage: number,
): TextChunk[] {
  // Simple chunking: concatenate pages until ~4000 chars, then split
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

function parseIdeasResponse(content: string): LLMExtractedIdea[] {
  try {
    const json = JSON.parse(content);
    const ideas = json.ideas || json;
    if (!Array.isArray(ideas)) return [];
    return ideas.map(normalizeExtractedIdea);
  } catch {
    // Try to extract JSON from markdown code blocks
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        const ideas = json.ideas || json;
        if (Array.isArray(ideas)) return ideas.map(normalizeExtractedIdea);
      } catch { /* fall through */ }
    }
    return [];
  }
}

function normalizeExtractedIdea(raw: Record<string, unknown>): LLMExtractedIdea {
  return {
    title: String(raw.title || 'Без названия'),
    summary: String(raw.summary || ''),
    type: validateEnum(raw.type, ['definition', 'method', 'theorem', 'insight', 'example', 'analogy'], 'insight'),
    depth: validateEnum(raw.depth, ['basic', 'medium', 'advanced'], 'medium'),
    importance: clamp(Number(raw.importance) || 3, 1, 5) as LLMExtractedIdea['importance'],
    pages: Array.isArray(raw.pages) ? raw.pages.map(Number) : [],
    quote: raw.quote ? String(raw.quote) : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    requires: Array.isArray(raw.requires) ? raw.requires.map(String) : [],
  };
}

function parseRelationsResponse(
  content: string,
  validIds: string[],
): PipelineResult['relations'] {
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

async function getFileHandleFromBook(book: Book): Promise<FileSystemFileHandle | undefined> {
  // The file handle is stored in-memory by background service worker
  const response = await chrome.runtime.sendMessage({ type: 'get-file-handle', data: { bookId: book.id } });
  return response?.handle;
}
