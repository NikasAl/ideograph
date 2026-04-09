// ============================================================
// Analysis Panel — page range selector, mode preview, progress
//
// Runs the extraction pipeline directly in the tab context.
// File is read via File System Access API (file-store).
// ============================================================

import { db, getSettings } from '../../db/index.js';
import type { Book, ExtractionMode } from '../../db/schema.js';
import { EXTRACTION_MODES } from '../../db/schema.js';
import { evaluateTextLayer, evaluateTextLayerMultiple, getTextPreview } from '../../extraction/mode-detector.js';
import { extractTextFromPDFPage, renderPDFPageToImage } from '../../extraction/text-extractor.js';
import { createProvider, parseFallbackModels } from '../../background/ai-client.js';
import { runPipeline } from '../../extraction/pipeline.js';
import { getFileHandle, verifyFileHandle, reconnectFileHandle, readFileAsArrayBuffer } from '../utils/file-store.js';

export class AnalysisPanel {
  private container: HTMLElement;
  private bookId: string;
  private selectedMode: ExtractionMode = 'text';
  private abortController: AbortController | null = null;
  private pdfData: ArrayBuffer | null = null;

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  async render(): Promise<void> {
    const book = await db.books.get(this.bookId);
    if (!book) return;

    const defaultFrom = Math.max(1, book.lastAnalyzedPage + 1);
    const defaultTo = Math.min(book.totalPages, Math.max(1, book.lastAnalyzedPage + 10));

    // Try to read file for preview
    let previewHtml = '<p class="preview-unavailable">Нет доступа к файлу для предпросмотра</p>';
    let qualityReport: ReturnType<typeof evaluateTextLayer> | null = null;

    const handle = getFileHandle(this.bookId);
    if (handle) {
      try {
        const hasPermission = await verifyFileHandle(this.bookId);
        if (!hasPermission) {
          try {
            const granted = await (handle as unknown as { requestPermission: (opts: { mode: string }) => Promise<string> }).requestPermission({ mode: 'read' });
            if (granted !== 'granted') {
              previewHtml = '<p class="preview-unavailable">Разрешение истекло. Нажмите «Переподключить файл».</p>';
            }
          } catch { /* try anyway */ }
        }
      } catch { /* Permission check failed — try anyway */ }
    }

    // Try to load PDF data for preview
    if (handle) {
      try {
        const file = await handle.getFile();
        this.pdfData = await file.arrayBuffer();
        // Extract text from the default range for multi-page evaluation
        const pagesText: Array<{ page: number; text: string }> = [];
        const maxSamples = 5;
        const range = defaultTo - defaultFrom + 1;
        const step = Math.max(1, Math.floor(range / maxSamples));

        for (let p = defaultFrom; p <= defaultTo; p += step) {
          try {
            const textResult = await extractTextFromPDFPage(this.pdfData, p);
            pagesText.push({ page: p, text: textResult.text });
          } catch { /* skip page */ }
        }

        // Also extract last page in range if not already included
        if (pagesText.length > 0 && pagesText[pagesText.length - 1].page !== defaultTo) {
          try {
            const textResult = await extractTextFromPDFPage(this.pdfData, defaultTo);
            pagesText.push({ page: defaultTo, text: textResult.text });
          } catch { /* skip */ }
        }

        if (pagesText.length > 0) {
          qualityReport = evaluateTextLayerMultiple(pagesText, book.format);

          // Find first page with actual text for preview
          const pageWithText = pagesText.find((p) => p.text.trim().length > 20);
          const previewPage = pageWithText || pagesText[0];
          const preview = getTextPreview(previewPage.text, 800);

          previewHtml = `
            <div class="text-preview-section">
              <div class="preview-header">
                <span class="preview-label">Предпросмотр (стр. ${previewPage.page}):</span>
                <span class="quality-score ${this.qualityClass(qualityReport.score)}">
                  Качество: ${(qualityReport.score * 100).toFixed(0)}%
                </span>
              </div>
              ${qualityReport.sampledPages.length > 1 ? `
                <div class="quality-pages">
                  Проверены: ${qualityReport.sampledPages.map((p) => {
                    const detail = qualityReport!.pageDetails.find((d) => d.page === p);
                    const cls = detail ? this.qualityClass(detail.score) : '';
                    return `<span class="${cls}">стр. ${p} (${detail ? (detail.score * 100).toFixed(0) : '?'}%)</span>`;
                  }).join(', ')}
                </div>
              ` : ''}
              <pre class="text-preview-content">${this.esc(preview)}</pre>
              ${qualityReport.issues.length > 0 ? `
                <div class="quality-issues">
                  <strong>Обнаруженные проблемы:</strong>
                  <ul>${qualityReport.issues.map((i) => `<li>${i}</li>`).join('')}</ul>
                </div>
              ` : ''}
              <p class="quality-suggestion">
                <strong>Рекомендация:</strong> ${qualityReport.reason}
              </p>
            </div>
          `;
        } else {
          previewHtml = '<p class="preview-unavailable">Не удалось извлечь текст ни с одной страницы</p>';
        }
      } catch (err) {
        previewHtml = `<p class="preview-unavailable">Не удалось извлечь текст: ${(err as Error).message}</p>`;
      }
    }

    const modeRadio = (m: typeof EXTRACTION_MODES[0]) => `
      <label class="mode-option ${m.mode === this.selectedMode ? 'selected' : ''}">
        <input type="radio" name="extraction-mode" value="${m.mode}" ${m.mode === this.selectedMode ? 'checked' : ''} />
        <span class="mode-option-header">
          <span class="mode-radio"></span>
          <strong>${m.label}</strong>
        </span>
        <span class="mode-option-desc">${m.description}</span>
      </label>
    `;

    const existing = this.container.querySelector('.idea-list-view');
    const panel = document.createElement('div');
    panel.className = 'analysis-panel';
    panel.innerHTML = `
      <div class="analysis-card">
        <h3>🔍 Анализ идей</h3>
        ${previewHtml}
        <div class="mode-selection">
          <h4>Режим экстракции:</h4>
          <div class="mode-options">
            ${EXTRACTION_MODES.map(modeRadio).join('')}
          </div>
        </div>
        <div class="range-inputs">
          <label>С страницы: <input type="number" id="page-from" min="1" max="${book.totalPages}" value="${defaultFrom}" /></label>
          <label>По страницу: <input type="number" id="page-to" min="1" max="${book.totalPages}" value="${defaultTo}" /></label>
          <button class="secondary-btn" id="btn-repreview" title="Перепроверить текстовый слой для нового диапазона">🔄 Перепроверить</button>
        </div>
        <div class="analysis-options">
          <label>Детализация:
            <select id="detail-level">
              <option value="low">Низкая</option>
              <option value="medium" selected>Средняя</option>
              <option value="high">Высокая</option>
            </select>
          </label>
        </div>
        <div class="analysis-actions">
          ${!handle ? '<button class="secondary-btn" id="btn-reconnect">🔗 Переподключить файл</button>' : ''}
          <button class="primary-btn" id="btn-start">▶ Запустить</button>
          <button class="secondary-btn" id="btn-cancel" style="display:none">⏹ Отменить</button>
          <button class="secondary-btn" id="btn-close">✕ Закрыть</button>
        </div>
        <div id="analysis-progress" class="analysis-progress" style="display:none">
          <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
          <p class="progress-text" id="progress-text">Подготовка...</p>
        </div>
      </div>
    `;

    if (existing) existing.before(panel);
    else this.container.appendChild(panel);

    // Set recommended mode from quality report
    if (qualityReport) {
      this.selectedMode = qualityReport.suggestedMode;
      const radio = panel.querySelector(`input[name="extraction-mode"][value="${qualityReport.suggestedMode}"]`) as HTMLInputElement;
      if (radio) radio.checked = true;
      panel.querySelectorAll('.mode-option').forEach((opt) => {
        opt.classList.toggle('selected', (opt.querySelector('input') as HTMLInputElement)?.checked);
      });
    }

    this.bindEvents(panel);
  }

  private bindEvents(panel: HTMLElement): void {
    panel.querySelector('#btn-close')?.addEventListener('click', () => {
      this.abortController?.abort();
      this.pdfData = null;
      panel.remove();
    });

    // Mode selection
    panel.querySelectorAll('input[name="extraction-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        this.selectedMode = (radio as HTMLInputElement).value as ExtractionMode;
        panel.querySelectorAll('.mode-option').forEach((opt) => {
          opt.classList.toggle('selected', (opt.querySelector('input') as HTMLInputElement)?.checked);
        });
      });
    });

    // Re-preview button
    panel.querySelector('#btn-repreview')?.addEventListener('click', () => this.repreview(panel));

    // Reconnect file button
    panel.querySelector('#btn-reconnect')?.addEventListener('click', async () => {
      const handle = await reconnectFileHandle(this.bookId);
      if (handle) {
        panel.remove();
        this.render();
      }
    });

    // Cancel button
    panel.querySelector('#btn-cancel')?.addEventListener('click', () => {
      this.abortController?.abort();
      (panel.querySelector('#btn-cancel') as HTMLElement).style.display = 'none';
      (panel.querySelector('#btn-start') as HTMLElement).style.display = 'inline-block';
    });

    panel.querySelector('#btn-start')?.addEventListener('click', () => this.startAnalysis(panel));
  }

  /** Re-evaluate text layer when page range changes */
  private async repreview(panel: HTMLElement): Promise<void> {
    const book = await db.books.get(this.bookId);
    if (!book || !this.pdfData) return;

    const pageFrom = Number((panel.querySelector('#page-from') as HTMLInputElement)?.value || 1);
    const pageTo = Number((panel.querySelector('#page-to') as HTMLInputElement)?.value || 1);
    if (pageFrom > pageTo) return;

    const previewSection = panel.querySelector('.text-preview-section');
    if (!previewSection) return;

    previewSection.innerHTML = '<p class="preview-unavailable">⏳ Проверка текстового слоя...</p>';

    try {
      const pagesText: Array<{ page: number; text: string }> = [];
      const maxSamples = 5;
      const range = pageTo - pageFrom + 1;
      const step = Math.max(1, Math.floor(range / maxSamples));

      for (let p = pageFrom; p <= pageTo; p += step) {
        try {
          const textResult = await extractTextFromPDFPage(this.pdfData, p);
          pagesText.push({ page: p, text: textResult.text });
        } catch { /* skip */ }
      }
      if (pagesText.length > 0 && pagesText[pagesText.length - 1].page !== pageTo) {
        try {
          const textResult = await extractTextFromPDFPage(this.pdfData, pageTo);
          pagesText.push({ page: pageTo, text: textResult.text });
        } catch { /* skip */ }
      }

      if (pagesText.length === 0) {
        previewSection.innerHTML = '<p class="preview-unavailable">Не удалось извлечь текст</p>';
        return;
      }

      const qualityReport = evaluateTextLayerMultiple(pagesText, book.format);
      const pageWithText = pagesText.find((p) => p.text.trim().length > 20);
      const previewPage = pageWithText || pagesText[0];
      const preview = getTextPreview(previewPage.text, 800);

      previewSection.innerHTML = `
        <div class="preview-header">
          <span class="preview-label">Предпросмотр (стр. ${previewPage.page}):</span>
          <span class="quality-score ${this.qualityClass(qualityReport.score)}">
            Качество: ${(qualityReport.score * 100).toFixed(0)}%
          </span>
        </div>
        ${qualityReport.sampledPages.length > 1 ? `
          <div class="quality-pages">
            Проверены: ${qualityReport.sampledPages.map((p) => {
              const detail = qualityReport.pageDetails.find((d) => d.page === p);
              const cls = detail ? this.qualityClass(detail.score) : '';
              return `<span class="${cls}">стр. ${p} (${detail ? (detail.score * 100).toFixed(0) : '?'}%)</span>`;
            }).join(', ')}
          </div>
        ` : ''}
        <pre class="text-preview-content">${this.esc(preview)}</pre>
        ${qualityReport.issues.length > 0 ? `
          <div class="quality-issues">
            <strong>Обнаруженные проблемы:</strong>
            <ul>${qualityReport.issues.map((i) => `<li>${i}</li>`).join('')}</ul>
          </div>
        ` : ''}
        <p class="quality-suggestion">
          <strong>Рекомендация:</strong> ${qualityReport.reason}
        </p>
      `;

      // Update recommended mode
      this.selectedMode = qualityReport.suggestedMode;
      const radio = panel.querySelector(`input[name="extraction-mode"][value="${qualityReport.suggestedMode}"]`) as HTMLInputElement;
      if (radio) radio.checked = true;
      panel.querySelectorAll('.mode-option').forEach((opt) => {
        opt.classList.toggle('selected', (opt.querySelector('input') as HTMLInputElement)?.checked);
      });
    } catch (err) {
      previewSection.innerHTML = `<p class="preview-unavailable">Ошибка: ${(err as Error).message}</p>`;
    }
  }

  private async startAnalysis(panel: HTMLElement): Promise<void> {
    const pageFrom = Number((panel.querySelector('#page-from') as HTMLInputElement)?.value || 1);
    const pageTo = Number((panel.querySelector('#page-to') as HTMLInputElement)?.value || 1);
    const detail = (panel.querySelector('#detail-level') as HTMLSelectElement)?.value as 'low' | 'medium' | 'high';

    if (pageFrom > pageTo) { alert('Начальная страница больше конечной'); return; }

    // Check file access
    const handle = getFileHandle(this.bookId);
    if (!handle) {
      alert('Нет доступа к файлу. Переподключите файл.');
      return;
    }

    // Verify permission
    const hasPermission = await verifyFileHandle(this.bookId);
    if (!hasPermission) {
      try {
        const granted = await (handle as any).requestPermission?.({ mode: 'read' });
        if (granted !== 'granted') {
          alert('Нет разрешения на чтение файла. Переподключите файл.');
          return;
        }
      } catch {
        alert('Не удалось получить разрешение. Переподключите файл.');
        return;
      }
    }

    // Get settings and create AI provider
    const settings = await getSettings();
    const apiKey = settings.providerKeys[settings.activeProvider];
    if (!apiKey) { alert(`API ключ для ${settings.activeProvider} не настроен. Откройте настройки.`); return; }

    const provider = createProvider(settings.activeProvider, apiKey);
    const fallbackModels = parseFallbackModels(settings.fallbackModels);

    // Show progress UI
    (panel.querySelector('#analysis-progress') as HTMLElement).style.display = 'block';
    (panel.querySelector('#btn-start') as HTMLElement).style.display = 'none';
    (panel.querySelector('#btn-cancel') as HTMLElement).style.display = 'inline-block';

    const progressFill = panel.querySelector('#progress-fill') as HTMLElement;
    const progressText = panel.querySelector('#progress-text') as HTMLElement;

    const modeLabel = EXTRACTION_MODES.find((m) => m.mode === this.selectedMode)?.label || this.selectedMode;
    progressText.textContent = `Режим: ${modeLabel}. Чтение файла...`;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      // Read file (reuse cached data if available, otherwise re-read)
      let pdfData = this.pdfData;
      if (!pdfData) {
        pdfData = await readFileAsArrayBuffer(this.bookId);
      }

      const book = await db.books.get(this.bookId);
      if (!book) throw new Error('Книга не найдена');

      const result = await runPipeline({
        bookId: this.bookId,
        pageFrom,
        pageTo,
        mode: this.selectedMode,
        pdfData,
        format: book.format,
        provider,
        model: settings.activeModel,
        ocrModel: settings.ocrModel,
        vlmModel: settings.vlmModel,
        fallbackModels,
        detail,
        signal,
        onProgress: (msg, pct) => {
          progressFill.style.width = `${pct}%`;
          progressText.textContent = msg;
        },
      });

      progressFill.style.width = '100%';
      const effectiveMode = EXTRACTION_MODES.find((m) => m.mode === result.mode)?.label || result.mode;
      progressText.textContent = `Готово! ${result.ideas.length} идей, ${result.relations.length} связей. Режим: ${effectiveMode}`;

      setTimeout(() => {
        document.dispatchEvent(new CustomEvent('ideas-updated'));
        this.pdfData = null;
        panel.remove();
      }, 1500);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        progressText.textContent = 'Отменено.';
      } else {
        progressText.textContent = `Ошибка: ${(err as Error).message}`;
        console.error('Analysis failed:', err);
      }
      (panel.querySelector('#btn-cancel') as HTMLElement).style.display = 'none';
      (panel.querySelector('#btn-start') as HTMLElement).style.display = 'inline-block';
    }
  }

  private qualityClass(score: number): string {
    if (score >= 0.7) return 'quality-good';
    if (score >= 0.4) return 'quality-medium';
    return 'quality-bad';
  }

  private esc(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
}
