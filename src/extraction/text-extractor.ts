// ============================================================
// Text extraction from PDF via PDF.js
// ============================================================

import * as pdfjsLib from 'pdfjs-dist';

// PDF.js worker setup — use inline worker for extension compatibility
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

export interface ExtractedText {
  text: string;
  hasTextLayer: boolean;
}

// Type for text content items that have a 'str' property
interface ExtractedTextItem {
  str: string;
  [key: string]: unknown;
}

/**
 * Extract text from a single PDF page.
 */
export async function extractTextFromPDFPage(
  pdfData: ArrayBuffer,
  pageNumber: number, // 1-based
): Promise<ExtractedText> {
  const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();

  const textItems = textContent.items
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((item: any) => item.str && typeof item.str === 'string')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((item: any) => item.str as string);

  const text = textItems.join(' ').replace(/\s+/g, ' ').trim();
  const hasTextLayer = textItems.length > 0 && text.length > 10;

  return { text, hasTextLayer };
}

/**
 * Extract text from a range of PDF pages.
 */
export async function extractTextFromPDFRange(
  pdfData: ArrayBuffer,
  fromPage: number,
  toPage: number,
): Promise<ExtractedText[]> {
  const results: ExtractedText[] = [];
  for (let p = fromPage; p <= toPage; p++) {
    const result = await extractTextFromPDFPage(pdfData, p);
    results.push(result);
  }
  return results;
}

/**
 * Render a PDF page to a canvas and return as base64 PNG.
 * Uses OffscreenCanvas — works in both tab context and service worker (Chrome 99+).
 */
export async function renderPDFPageToImage(
  pdfData: ArrayBuffer,
  pageNumber: number,
  scale: number = 1.5,
): Promise<string> {
  const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  const canvas = new OffscreenCanvas(viewport.width, viewport.height);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = canvas.getContext('2d') as any;

  await page.render({ canvasContext: ctx, viewport }).promise;
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToBase64(blob);
}

/**
 * Get total page count of a PDF.
 */
export async function getPDFPageCount(pdfData: ArrayBuffer): Promise<number> {
  const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
  return pdf.numPages;
}

/**
 * Convert Blob to data:image/png;base64,... string.
 * Uses ArrayBuffer + btoa — works in service worker context (no FileReader needed).
 */
function blobToBase64(blob: Blob): Promise<string> {
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
