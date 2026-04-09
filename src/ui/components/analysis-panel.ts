// ============================================================
// Analysis Panel — page range selector + progress
// ============================================================

import { db, getSettings } from '../../db/index.js';

export class AnalysisPanel {
  private container: HTMLElement;
  private bookId: string;

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  async render(): Promise<void> {
    const book = await db.books.get(this.bookId);
    if (!book) return;

    const existing = this.container.querySelector('.idea-list-view');
    const panel = document.createElement('div');
    panel.className = 'analysis-panel';

    panel.innerHTML = `
      <div class="analysis-card">
        <h3>🔍 Анализ идей</h3>
        <p>Режим: <strong>${book.extractionMode === 'text' ? 'текстовый' : 'визуальный (VLM)'}</strong></p>
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
      </div>`;

    if (existing) existing.before(panel);
    else this.container.appendChild(panel);

    this.bindEvents(panel);
  }

  private bindEvents(panel: HTMLElement): void {
    panel.querySelector('#btn-close')?.addEventListener('click', () => panel.remove());
    panel.querySelector('#btn-start')?.addEventListener('click', () => this.startAnalysis(panel));
  }

  private async startAnalysis(panel: HTMLElement): Promise<void> {
    const pageFrom = Number((panel.querySelector('#page-from') as HTMLInputElement)?.value || 1);
    const pageTo = Number((panel.querySelector('#page-to') as HTMLInputElement)?.value || 1);

    if (pageFrom > pageTo) { alert('Начальная страница больше конечной'); return; }

    const settings = await getSettings();
    const apiKey = settings.providerKeys[settings.activeProvider];
    if (!apiKey) { alert(`API ключ для ${settings.activeProvider} не настроен`); return; }

    (panel.querySelector('#analysis-progress') as HTMLElement).style.display = 'block';
    (panel.querySelector('#btn-start') as HTMLElement).style.display = 'none';
    (panel.querySelector('#btn-cancel') as HTMLElement).style.display = 'inline-block';

    const pText = panel.querySelector('#progress-text') as HTMLElement;

    try {
      pText.textContent = 'Отправка запроса...';
      const response = await chrome.runtime.sendMessage({
        type: 'start-analysis',
        data: { bookId: this.bookId, pageFrom, pageTo, mode: 'auto' },
      });
      if (response?.error) throw new Error(response.error);
      (panel.querySelector('#progress-fill') as HTMLElement).style.width = '100%';
      pText.textContent = 'Анализ завершён!';
      setTimeout(() => panel.remove(), 1500);
    } catch (err) {
      pText.textContent = `Ошибка: ${(err as Error).message}`;
      (panel.querySelector('#btn-cancel') as HTMLElement).style.display = 'none';
      (panel.querySelector('#btn-start') as HTMLElement).style.display = 'inline-block';
    }
  }
}
