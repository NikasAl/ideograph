// ============================================================
// Analysis Panel — page range selector, mode preview, progress
// ============================================================

import { db, getSettings } from '../../db/index.js';
import type { Book, ExtractionMode } from '../../db/schema.js';
import { EXTRACTION_MODES } from '../../db/schema.js';
import { evaluateTextLayer, getTextPreview } from '../../extraction/mode-detector.js';
import { extractTextFromPDFPage, renderPDFPageToImage } from '../../extraction/text-extractor.js';

export class AnalysisPanel {
  private container: HTMLElement;
  private bookId: string;
  private selectedMode: ExtractionMode = 'text';

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  async render(): Promise<void> {
    const book = await db.books.get(this.bookId);
    if (!book) return;

    // Try to get file handle for preview
    const fileHandle = await this.getFileHandle();
    let previewHtml = '<p class="preview-unavailable">Нет доступа к файлу для предпросмотра</p>';
    let qualityReport: ReturnType<typeof evaluateTextLayer> | null = null;

    if (fileHandle) {
      try {
        const file = await fileHandle.getFile();
        const pdfData = await file.arrayBuffer();
        const pageText = await extractTextFromPDFPage(pdfData, 1);
        qualityReport = evaluateTextLayer(pageText.text, book.format);
        const preview = getTextPreview(pageText.text, 800);

        previewHtml = `
          <div class="text-preview-section">
            <div class="preview-header">
              <span class="preview-label">Предпросмотр текстового слоя (стр. 1):</span>
              <span class="quality-score ${this.qualityClass(qualityReport.score)}">
                Качество: ${(qualityReport.score * 100).toFixed(0)}%
              </span>
            </div>
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
      } catch {
        previewHtml = '<p class="preview-unavailable">Не удалось извлечь текст для предпросмотра</p>';
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
          <label>С страницы: <input type="number" id="page-from" min="1" max="${book.totalPages}" value="${Math.max(1, book.lastAnalyzedPage + 1)}" /></label>
          <label>По страницу: <input type="number" id="page-to" min="1" max="${book.totalPages}" value="${Math.min(book.totalPages, Math.max(1, book.lastAnalyzedPage + 10))}" /></label>
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
    panel.querySelector('#btn-close')?.addEventListener('click', () => panel.remove());

    // Mode selection
    panel.querySelectorAll('input[name="extraction-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        this.selectedMode = (radio as HTMLInputElement).value as ExtractionMode;
        panel.querySelectorAll('.mode-option').forEach((opt) => {
          opt.classList.toggle('selected', (opt.querySelector('input') as HTMLInputElement)?.checked);
        });
      });
    });

    panel.querySelector('#btn-start')?.addEventListener('click', () => this.startAnalysis(panel));
  }

  private async startAnalysis(panel: HTMLElement): Promise<void> {
    const pageFrom = Number((panel.querySelector('#page-from') as HTMLInputElement)?.value || 1);
    const pageTo = Number((panel.querySelector('#page-to') as HTMLInputElement)?.value || 1);
    const detail = (panel.querySelector('#detail-level') as HTMLSelectElement)?.value as 'low' | 'medium' | 'high';

    if (pageFrom > pageTo) { alert('Начальная страница больше конечной'); return; }

    const settings = await getSettings();
    const apiKey = settings.providerKeys[settings.activeProvider];
    if (!apiKey) { alert(`API ключ для ${settings.activeProvider} не настроен`); return; }

    (panel.querySelector('#analysis-progress') as HTMLElement).style.display = 'block';
    (panel.querySelector('#btn-start') as HTMLElement).style.display = 'none';
    (panel.querySelector('#btn-cancel') as HTMLElement).style.display = 'inline-block';

    const progressFill = panel.querySelector('#progress-fill') as HTMLElement;
    const progressText = panel.querySelector('#progress-text') as HTMLElement;

    // Show mode info
    const modeLabel = EXTRACTION_MODES.find((m) => m.mode === this.selectedMode)?.label || this.selectedMode;
    progressText.textContent = `Режим: ${modeLabel}. Отправка запроса...`;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'start-analysis',
        data: { bookId: this.bookId, pageFrom, pageTo, mode: this.selectedMode, detail },
      });

      if (response?.error) throw new Error(response.error);

      progressFill.style.width = '100%';
      progressText.textContent = 'Анализ завершён!';
      setTimeout(() => panel.remove(), 1500);
    } catch (err) {
      progressText.textContent = `Ошибка: ${(err as Error).message}`;
      (panel.querySelector('#btn-cancel') as HTMLElement).style.display = 'none';
      (panel.querySelector('#btn-start') as HTMLElement).style.display = 'inline-block';
    }
  }

  private qualityClass(score: number): string {
    if (score >= 0.7) return 'quality-good';
    if (score >= 0.4) return 'quality-medium';
    return 'quality-bad';
  }

  private async getFileHandle(): Promise<FileSystemFileHandle | undefined> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'get-file-handle', data: { bookId: this.bookId },
      });
      return response?.handle;
    } catch { return undefined; }
  }

  private esc(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
}
