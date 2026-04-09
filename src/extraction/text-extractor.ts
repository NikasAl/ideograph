// ============================================================
// Text extraction from PDF via PDF.js
// ============================================================

import * as pdfjsLib from 'pdfjs-dist';
import type { PageTextCache } from '../db/schema.js';

// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

export interface ExtractedText {
  text: string;
  hasTextLayer: boolean;
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
    .filter((item): item is { str: string } => 'str' in item)
    .map((item) => item.str);

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
  const ctx = canvas.getContext('2d')!;

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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
