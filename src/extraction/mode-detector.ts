// ============================================================
// Mode detector — evaluates text layer quality, suggests mode
// ============================================================

import type { ExtractionMode } from '../db/schema.js';

export interface QualityReport {
  score: number;           // 0-1, quality of text layer
  issues: string[];        // list of detected problems
  suggestedMode: ExtractionMode;
  reason: string;
}

/**
 * Analyze extracted text to evaluate text layer quality.
 * Returns detailed report with suggestion.
 */
export function evaluateTextLayer(text: string, source: 'pdf' | 'djvu'): QualityReport {
  const issues: string[] = [];

  if (!text || text.trim().length === 0) {
    return {
      score: 0,
      issues: ['Текст полностью отсутствует'],
      suggestedMode: 'vlm',
      reason: 'Нет текстового слоя — нужен визуальный анализ',
    };
  }

  const totalChars = text.length;

  // 1. Readable characters ratio
  const readableMatch = text.match(/[\p{L}\p{N}]/gu);
  const readableChars = readableMatch ? readableMatch.length : 0;
  const readableRatio = totalChars > 0 ? readableChars / totalChars : 0;

  if (readableRatio < 0.3) {
    issues.push(`Низкая доля читаемых символов: ${(readableRatio * 100).toFixed(1)}%`);
  }

  // 2. Garbage characters (lots of special/non-letter symbols)
  const garbageMatch = text.match(/[^\p{L}\p{N}\s.,;:!?'"()\-\u2013\u2014/\\+=*&^%$#@~`[\]{}|<>]/gu);
  const garbageChars = garbageMatch ? garbageMatch.length : 0;
  const garbageRatio = totalChars > 0 ? garbageChars / totalChars : 0;

  if (garbageRatio > 0.1) {
    issues.push(`Много нечитаемых символов: ${(garbageRatio * 100).toFixed(1)}%`);
  }

  // 3. Whitespace dominance
  const whitespace = text.replace(/\S/g, '').length;
  const whitespaceRatio = totalChars > 0 ? whitespace / totalChars : 1;

  if (whitespaceRatio > 0.85) {
    issues.push('Текст почти полностью из пробелов');
  }

  // 4. Broken words detection (many isolated single letters)
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const singleLetters = words.filter((w) => w.length === 1 && /\p{L}/u.test(w));
  const singleLetterRatio = words.length > 0 ? singleLetters.length / words.length : 0;

  if (singleLetterRatio > 0.3) {
    issues.push('Много обрывков слов (одиночные буквы) — возможно повреждённый OCR');
  }

  // 5. Formula indicators: are there fragments that look like broken math?
  // LaTeX-like patterns that are NOT in proper LaTeX
  const brokenMath = text.match(/[\u2200-\u22FF]{2,}/gu);
  const brokenMathCount = brokenMath ? brokenMath.length : 0;

  if (brokenMathCount > 3 && readableRatio > 0.5) {
    issues.push('Обнаружены математические символы вне формул — возможны повреждённые формулы');
  }

  // 6. Very short meaningful content (few words per page)
  if (words.length < 10 && totalChars < 100) {
    issues.push('Слишком мало текста на странице');
  }

  // --- Score calculation ---
  let score = readableRatio; // base score

  // Penalize for issues
  if (garbageRatio > 0.1) score -= garbageRatio * 0.5;
  if (singleLetterRatio > 0.3) score -= 0.3;
  if (whitespaceRatio > 0.85) score -= 0.3;
  if (brokenMathCount > 3 && readableRatio > 0.5) score -= 0.15;
  if (words.length < 10) score -= 0.2;

  score = Math.max(0, Math.min(1, score));

  // --- Mode suggestion ---
  const djvuPenalty = source === 'djvu' ? 0.15 : 0;

  let suggestedMode: ExtractionMode;
  let reason: string;

  if (score < 0.3 || words.length < 10) {
    suggestedMode = 'vlm';
    reason = 'Текстовый слой непригоден — нужен полный визуальный анализ (VLM)';
  } else if (score < 0.65 || issues.length >= 2 || brokenMathCount > 0) {
    suggestedMode = 'ocr';
    reason = 'Текстовый слой частично повреждён — рекомендуется OCR с распознаванием формул';
  } else if (brokenMathCount > 3) {
    suggestedMode = 'ocr';
    reason = 'Обнаружены формулы в текстовом слое — OCR обеспечит корректное распознавание LaTeX';
  } else {
    suggestedMode = 'text';
    reason = 'Текстовый слой хорошего качества — можно использовать напрямую';
  }

  // DJVU files have worse text layers on average
  if (suggestedMode === 'text' && source === 'djvu' && score < 0.8) {
    suggestedMode = 'ocr';
    reason += ' (DJVU файлы часто имеют проблемы с текстовым слоем)';
  }

  return { score, issues, suggestedMode, reason };
}

/**
 * Quick check: is text layer usable at all?
 */
export function hasUsableTextLayer(text: string): boolean {
  if (!text || text.trim().length < 50) return false;
  const readableMatch = text.match(/[\p{L}\p{N}]/gu);
  const readableChars = readableMatch ? readableMatch.length : 0;
  return readableChars / text.length > 0.4;
}

/**
 * Get first N characters of text for preview.
 */
export function getTextPreview(text: string, maxChars: number = 500): string {
  if (!text) return '(нет текста)';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars) + '...';
}
