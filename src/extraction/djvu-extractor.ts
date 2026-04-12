// ============================================================
// DJVU extraction — page count, text, rendering, bookmarks
// via DjVu.js (djvujs-dist)
// ============================================================

import DjVu from 'djvujs-dist/library/src/index.js';

// ============================================================
// Document loading (shared)
// ============================================================

function createDocument(data: ArrayBuffer): InstanceType<typeof DjVu.Document> {
  // DjVu.js may detach/consume the buffer, so always pass a copy
  const copy = data.slice(0);
  return new DjVu.Document(copy);
}

// ============================================================
// Page count
// ============================================================

/**
 * Get total page count of a DJVU document.
 */
export function getDJVUPageCount(data: ArrayBuffer): number {
  try {
    const doc = createDocument(data);
    return doc.getPagesQuantity();
  } catch {
    return 0;
  }
}

// ============================================================
// Text extraction
// ============================================================

export interface DJVUExtractedText {
  text: string;
  hasTextLayer: boolean;
}

/**
 * Extract text from a single DJVU page.
 */
export async function extractTextFromDJVUPage(
  data: ArrayBuffer,
  pageNumber: number, // 1-based
): Promise<DJVUExtractedText> {
  const doc = createDocument(data);
  const page = await doc.getPage(pageNumber);
  const text = page.getText() || '';
  const hasTextLayer = text.length > 10;
  return { text, hasTextLayer };
}

/**
 * Extract text from a range of DJVU pages.
 */
export async function extractTextFromDJVURange(
  data: ArrayBuffer,
  fromPage: number,
  toPage: number,
): Promise<DJVUExtractedText[]> {
  const doc = createDocument(data);
  const results: DJVUExtractedText[] = [];
  for (let p = fromPage; p <= toPage; p++) {
    const page = await doc.getPage(p);
    const text = page.getText() || '';
    results.push({ text, hasTextLayer: text.length > 10 });
  }
  return results;
}

// ============================================================
// Page rendering
// ============================================================

/**
 * Render a DJVU page to a base64 PNG string.
 * Uses getImageData() + OffscreenCanvas (same approach as PDF renderer).
 */
export async function renderDJVUPageToImage(
  data: ArrayBuffer,
  pageNumber: number, // 1-based
  scale: number = 1.5,
): Promise<string> {
  const doc = createDocument(data);
  const page = await doc.getPage(pageNumber);

  // Get base image dimensions and apply scale
  const baseWidth = page.getWidth();
  const baseHeight = page.getHeight();
  const width = Math.round(baseWidth * scale);
  const height = Math.round(baseHeight * scale);

  const imageData = page.getImageData();

  // Scale using OffscreenCanvas
  const canvas = new OffscreenCanvas(width, height);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = canvas.getContext('2d') as any;

  // Draw the original ImageData, then scale
  const tempCanvas = new OffscreenCanvas(baseWidth, baseHeight);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tempCtx = tempCanvas.getContext('2d') as any;
  tempCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(tempCanvas, 0, 0, width, height);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return imageDataToBase64(blob);
}

// ============================================================
// Bookmarks / TOC (NAVM chunk)
// ============================================================

/** A bookmark item from DJVU NAVM chunk */
export interface DJVUBookmark {
  description: string;
  url: string;
  children?: DJVUBookmark[];
}

/**
 * Extract bookmarks (table of contents) from a DJVU document.
 * Returns null if the document has no bookmarks.
 *
 * Bookmark URLs are in the form "#N" (page number) or "#id" (named reference).
 */
export function extractDJVUBookmarks(data: ArrayBuffer): DJVUBookmark[] | null {
  try {
    const doc = createDocument(data);
    const contents = doc.getContents();
    if (!contents || contents.length === 0) return null;
    return contents as DJVUBookmark[];
  } catch {
    return null;
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Convert Blob to data:image/png;base64,... string.
 * Uses ArrayBuffer + btoa — same approach as text-extractor.ts
 */
function imageDataToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return `data:${blob.type};base64,${btoa(binary)}`;
  });
}
