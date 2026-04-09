// ============================================================
// Mode detector — determines text vs VLM extraction mode
// ============================================================

export type ExtractionMode = 'text' | 'vlm';

export interface ModeDetectionResult {
  mode: ExtractionMode;
  confidence: number; // 0-1
  reason: string;
}

/**
 * Analyze extracted text to determine if it's readable or garbage OCR.
 */
export function detectMode(text: string, source: 'pdf' | 'djvu'): ModeDetectionResult {
  if (!text || text.trim().length === 0) {
    return {
      mode: 'vlm',
      confidence: 0.95,
      reason: 'Текст полностью отсутствует',
    };
  }

  const totalChars = text.length;
  const whitespace = text.replace(/\S/g, '').length;
  const whitespaceRatio = totalChars > 0 ? whitespace / totalChars : 1;

  // Count readable characters (letters, numbers, CJK, Cyrillic)
  const readableMatch = text.match(/[\p{L}\p{N}]/gu);
  const readableChars = readableMatch ? readableMatch.length : 0;
  const readableRatio = totalChars > 0 ? readableChars / totalChars : 0;

  // Count garbage indicators (lots of special chars, isolated letters)
  const garbageMatch = text.match(/[^\p{L}\p{N}\s.,;:!?'"()\-–—/\\+=*&^%$#@~`[\]{}|<>]/gu);
  const garbageChars = garbageMatch ? garbageMatch.length : 0;
  const garbageRatio = totalChars > 0 ? garbageChars / totalChars : 0;

  // DJVU often has worse text layer than PDF
  const djvuThreshold = 0.4;
  const pdfThreshold = 0.25;

  const threshold = source === 'djvu' ? djvuThreshold : pdfThreshold;

  if (readableRatio < threshold && totalChars > 50) {
    return {
      mode: 'vlm',
      confidence: Math.min(0.9, (threshold - readableRatio) / threshold),
      reason: `Низкая доля читаемых символов: ${(readableRatio * 100).toFixed(1)}% (порог: ${threshold * 100}%)`,
    };
  }

  if (garbageRatio > 0.15) {
    return {
      mode: 'vlm',
      confidence: 0.7,
      reason: `Много нечитаемых символов: ${(garbageRatio * 100).toFixed(1)}%`,
    };
  }

  if (whitespaceRatio > 0.85) {
    return {
      mode: 'vlm',
      confidence: 0.8,
      reason: 'Текст почти полностью из пробелов',
    };
  }

  if (readableChars < 50) {
    return {
      mode: 'vlm',
      confidence: 0.85,
      reason: `Слишком мало читаемых символов: ${readableChars}`,
    };
  }

  return {
    mode: 'text',
    confidence: Math.min(0.95, readableRatio),
    reason: `Текстовый слой достаточного качества: ${(readableRatio * 100).toFixed(1)}% читаемых символов`,
  };
}
