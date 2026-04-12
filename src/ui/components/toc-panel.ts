// ============================================================
// TOC Panel — Table of Contents UI
// ============================================================

import { db } from '../../db/index.js';
import type { TOCEntry, Book } from '../../db/schema.js';
import { getSettings } from '../../db/index.js';
import { createProvider } from '../../background/ai-client.js';
import { extractTOC, summarizeTOCChapters, computePageRanges } from '../../extraction/toc-extractor.js';
import { ensureFileAccess, reconnectFileHandleWithCheck, readFileAsArrayBuffer } from '../utils/file-store.js';
import '../../ui/styles/components/toc-panel.css';

export class TOCPanel {
  private container: HTMLElement;
  private bookId: string;
  private toc: TOCEntry[] = [];
  private isExtracting = false;
  private editingEntryId: string | null = null;

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  async render(): Promise<void> {
    const book = await db.books.get(this.bookId);
    if (!book) {
      this.container.innerHTML = '<div class="empty-state"><p>Книга не найдена</p></div>';
      return;
    }
    this.toc = book.tableOfContents || [];

    this.container.innerHTML = `
      <div class="toc-panel">
        ${this.renderHeader()}
        ${this.renderInputSection(book)}
        ${this.renderTree(book)}
      </div>
    `;

    this.bindEvents(book);
  }

  // ---- Render sections ----

  private renderHeader(): string {
    const chapters = this.toc.filter(e => e.level === 1);
    return `
      <div class="toc-header">
        <div class="toc-header-left">
          <h2>📑 Оглавление</h2>
          ${this.toc.length > 0 ? `<span class="toc-chapter-count">${chapters.length} глав</span>` : ''}
        </div>
        <div class="toc-header-actions">
          ${this.toc.length > 0 ? `
            <button class="secondary-btn" id="toc-summarize-all">📋 Суммаризировать главы</button>
            <button class="secondary-btn" id="toc-clear">🗑️ Очистить</button>
          ` : ''}
        </div>
      </div>
    `;
  }

  private renderInputSection(book: Book): string {
    const hasTOC = this.toc.length > 0;
    return `
      <div class="toc-input-section" id="toc-input-section">
        ${!hasTOC ? '<p style="margin:0 0 12px;color:var(--text-secondary);font-size:0.9rem;">Укажите страницы, где напечатано оглавление книги:</p>' : ''}
        <div class="toc-input-row">
          <label>Страницы:</label>
          <input type="number" class="toc-page-input" id="toc-from" value="${!hasTOC ? 1 : ''}" min="1" max="${book.totalPages}" placeholder="от">
          <span class="toc-page-separator">—</span>
          <input type="number" class="toc-page-input" id="toc-to" value="${!hasTOC ? 5 : ''}" min="1" max="${book.totalPages}" placeholder="до">
          <button class="primary-btn" id="toc-extract-btn" ${this.isExtracting ? 'disabled' : ''}>
            ${this.isExtracting ? '⏳ Распознаём...' : '🔍 Распознать оглавление'}
          </button>
        </div>
        <div class="toc-progress" id="toc-progress" style="display:none;">
          <div class="toc-progress-bar"><div class="toc-progress-fill" id="toc-progress-fill"></div></div>
          <div class="toc-progress-text" id="toc-progress-text"></div>
        </div>
        <div class="toc-error" id="toc-error" style="display:none;"></div>
      </div>
    `;
  }

  private renderTree(book: Book): string {
    if (this.toc.length === 0) {
      return `
        <div class="toc-tree-container">
          <div class="toc-empty">
            <div class="toc-empty-icon">📑</div>
            <p class="toc-empty-hint">
              Оглавление ещё не извлечено.<br>
              Укажите диапазон страниц с оглавлением и нажмите «Распознать».
            </p>
          </div>
        </div>
      `;
    }

    return `
      <div class="toc-tree-container" id="toc-tree">
        ${this.toc.map(entry => this.renderEntry(entry, book)).join('')}
      </div>
      <div class="toc-add-section">
        <button class="toc-add-btn" id="toc-add-entry">+ Добавить раздел</button>
      </div>
    `;
  }

  private renderEntry(entry: TOCEntry, book: Book): string {
    const isEditing = this.editingEntryId === entry.id;
    const pageStr = entry.pageEnd ? `${entry.page}–${entry.pageEnd}` : `${entry.page}`;
    const pageCount = entry.pageEnd ? entry.pageEnd - entry.page + 1 : 1;
    const indent = entry.level > 1 ? '│   '.repeat(entry.level - 1) : '';
    const connector = entry.level > 1 ? '├──' : '';

    if (isEditing) {
      return `
        <div class="toc-entry level-${entry.level} editing" data-entry-id="${entry.id}">
          <span class="toc-tree-line">${indent}${connector}</span>
          <div class="toc-entry-content">
            <input type="text" class="toc-edit-input" id="edit-title-${entry.id}" value="${this.escapeHtml(entry.title)}">
            <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
              <label style="font-size:0.8rem;color:var(--text-secondary);">Стр.:</label>
              <input type="number" class="toc-edit-input page-input" id="edit-page-${entry.id}" value="${entry.page}" min="1" max="${book.totalPages}">
              <label style="font-size:0.8rem;color:var(--text-secondary);">Уровень:</label>
              <select class="toc-edit-input" id="edit-level-${entry.id}" style="width:auto;">
                <option value="1" ${entry.level === 1 ? 'selected' : ''}>Глава</option>
                <option value="2" ${entry.level === 2 ? 'selected' : ''}>Раздел</option>
                <option value="3" ${entry.level === 3 ? 'selected' : ''}>Подраздел</option>
              </select>
            </div>
            <div class="toc-edit-actions">
              <button class="toc-edit-save" data-save-id="${entry.id}">💾 Сохранить</button>
              <button class="toc-edit-cancel" data-cancel-id="${entry.id}">Отмена</button>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="toc-entry level-${entry.level}" data-entry-id="${entry.id}">
        <span class="toc-tree-line">${indent}${connector}</span>
        <div class="toc-entry-content">
          <div class="toc-entry-title">${this.escapeHtml(entry.title)}</div>
          <div class="toc-entry-meta">
            <span class="toc-page-range">стр. ${pageStr}</span>
            <span>${pageCount} стр.</span>
            ${entry.level === 1 ? `
              <span class="toc-ideas-badge ${!entry.ideasCount ? 'empty' : ''}">
                💡${entry.ideasCount ?? 0}
              </span>
            ` : ''}
          </div>
          ${entry.summary ? `<div class="toc-summary">${this.escapeHtml(entry.summary)}</div>` : ''}
        </div>
        <div class="toc-entry-actions">
          ${entry.level === 1 ? `
            <button class="toc-btn-sm btn-analyze" data-analyze-id="${entry.id}" title="Анализировать главу">▶ Анализ</button>
          ` : ''}
          <button class="toc-btn-sm" data-edit-id="${entry.id}" title="Редактировать">✏️</button>
          <button class="toc-btn-sm btn-delete" data-delete-id="${entry.id}" title="Удалить">✕</button>
        </div>
      </div>
    `;
  }

  // ---- Event binding ----

  private bindEvents(book: Book): void {
    // Extract TOC button
    const extractBtn = this.container.querySelector('#toc-extract-btn') as HTMLButtonElement;
    if (extractBtn) {
      extractBtn.addEventListener('click', () => this.handleExtract(book));
    }

    // Summarize all
    const summarizeBtn = this.container.querySelector('#toc-summarize-all') as HTMLButtonElement;
    if (summarizeBtn) {
      summarizeBtn.addEventListener('click', () => this.handleSummarizeAll(book));
    }

    // Clear TOC
    const clearBtn = this.container.querySelector('#toc-clear') as HTMLButtonElement;
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.handleClear());
    }

    // Add entry
    const addBtn = this.container.querySelector('#toc-add-entry') as HTMLButtonElement;
    if (addBtn) {
      addBtn.addEventListener('click', () => this.handleAddEntry(book));
    }

    // Tree actions (delegation)
    const tree = this.container.querySelector('#toc-tree');
    if (tree) {
      tree.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;

        const analyzeBtn = target.closest('[data-analyze-id]') as HTMLElement;
        const editBtn = target.closest('[data-edit-id]') as HTMLElement;
        const deleteBtn = target.closest('[data-delete-id]') as HTMLElement;
        const saveBtn = target.closest('[data-save-id]') as HTMLElement;
        const cancelBtn = target.closest('[data-cancel-id]') as HTMLElement;

        if (analyzeBtn) {
          const entryId = analyzeBtn.dataset.analyzeId!;
          this.handleAnalyzeChapter(entryId, book);
        } else if (editBtn) {
          this.editingEntryId = editBtn.dataset.editId!;
          this.renderTree(book);
          // Re-select after re-render
          const editTitle = this.container.querySelector(`#edit-title-${this.editingEntryId}`) as HTMLInputElement;
          if (editTitle) editTitle.focus();
        } else if (deleteBtn) {
          const entryId = deleteBtn.dataset.deleteId!;
          this.handleDeleteEntry(entryId, book);
        } else if (saveBtn) {
          const entryId = saveBtn.dataset.saveId!;
          this.handleSaveEntry(entryId, book);
        } else if (cancelBtn) {
          this.editingEntryId = null;
          this.renderTree(book);
        }
      });
    }

    // Enter key in edit inputs
    this.container.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.editingEntryId) {
        this.handleSaveEntry(this.editingEntryId, book);
      } else if (e.key === 'Escape' && this.editingEntryId) {
        this.editingEntryId = null;
        this.renderTree(book);
      }
    });
  }

  // ---- Handlers ----

  private async handleExtract(book: Book): Promise<void> {
    if (this.isExtracting) return;

    const fromInput = this.container.querySelector('#toc-from') as HTMLInputElement;
    const toInput = this.container.querySelector('#toc-to') as HTMLInputElement;
    const from = parseInt(fromInput.value);
    const to = parseInt(toInput.value);

    if (!from || !to || from > to || from < 1 || to > book.totalPages) {
      this.showError('Укажите корректный диапазон страниц');
      return;
    }

    this.isExtracting = true;
    this.hideError();

    // Immediately update button and progress in DOM (no full re-render)
    const extractBtn = this.container.querySelector('#toc-extract-btn') as HTMLButtonElement;
    if (extractBtn) {
      extractBtn.disabled = true;
      extractBtn.textContent = '⏳ Распознаём...';
    }
    this.updateProgress('Подготовка...', 5);

    try {
      const settings = await getSettings();
      const apiKey = settings.providerKeys[settings.activeProvider];
      if (!apiKey) {
        this.showError('API ключ не настроен');
        return;
      }
      const provider = createProvider(settings.activeProvider, apiKey, { zaiBaseUrl: settings.zaiBaseUrl });

      // Read PDF file data (same pattern as analysis-panel)
      const access = await ensureFileAccess(this.bookId);
      if (access === null) {
        const handle = await reconnectFileHandleWithCheck(this.bookId, book.filePath);
        if (!handle) {
          this.showError('Не выбран файл. Нажмите «🔗 Подключить файл» в списке книг.');
          return;
        }
      } else if (access === 'denied') {
        this.showError('Доступ к файлу запрещён. Подключите файл заново.');
        return;
      }

      const pdfData = await readFileAsArrayBuffer(this.bookId);

      const entries = await extractTOC({
        bookId: this.bookId,
        tocPages: [from, to],
        mode: book.extractionMode,
        pdfData,
        provider,
        model: settings.activeModel,
        ocrModel: settings.ocrModel,
        vlmModel: settings.vlmModel,
        fallbackModels: settings.fallbackModels.split(',').filter(Boolean),
        requestDelayMs: settings.requestDelayMs,
        onProgress: (msg, pct) => this.updateProgress(msg, pct),
      });

      this.toc = entries;
      await this.render();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showError(`Ошибка: ${msg}`);
    } finally {
      this.isExtracting = false;
      // Restore button state without full re-render
      const btn = this.container.querySelector('#toc-extract-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔍 Распознать оглавление';
      }
    }
  }

  private async handleSummarizeAll(book: Book): Promise<void> {
    try {
      const settings = await getSettings();
      const apiKey = settings.providerKeys[settings.activeProvider];
      if (!apiKey) {
        this.showError('API ключ не настроен');
        return;
      }
      const provider = createProvider(settings.activeProvider, apiKey, { zaiBaseUrl: settings.zaiBaseUrl });

      await summarizeTOCChapters({
        bookId: this.bookId,
        provider,
        model: settings.activeModel,
        fallbackModels: settings.fallbackModels.split(',').filter(Boolean),
        requestDelayMs: settings.requestDelayMs,
        onProgress: (msg, pct) => this.updateProgress(msg, pct),
      });

      // Reload TOC
      const updatedBook = await db.books.get(this.bookId);
      if (updatedBook) {
        this.toc = updatedBook.tableOfContents || [];
        await this.render();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showError(`Ошибка суммаризации: ${msg}`);
    }
  }

  private async handleClear(): Promise<void> {
    if (!confirm('Удалить оглавление? Связи идей с главами будут потеряны.')) return;
    await db.books.update(this.bookId, { tableOfContents: [], updatedAt: Date.now() });
    this.toc = [];
    await this.render();
  }

  private async handleAddEntry(book: Book): Promise<void> {
    const newEntry: TOCEntry = {
      id: `${this.bookId}_toc_${Date.now()}`,
      title: 'Новый раздел',
      page: 1,
      level: 1,
    };
    this.toc.push(newEntry);
    computePageRanges(this.toc, book.totalPages);
    await db.books.update(this.bookId, { tableOfContents: this.toc, updatedAt: Date.now() });
    this.editingEntryId = newEntry.id;
    this.renderTree(book);
    const editTitle = this.container.querySelector(`#edit-title-${newEntry.id}`) as HTMLInputElement;
    if (editTitle) {
      editTitle.focus();
      editTitle.select();
    }
  }

  private async handleAnalyzeChapter(entryId: string, book: Book): Promise<void> {
    const entry = this.toc.find(e => e.id === entryId);
    if (!entry || !entry.pageEnd) return;

    // Fire a custom event that the analysis panel can listen to
    document.dispatchEvent(new CustomEvent('analyze-chapter', {
      detail: {
        bookId: this.bookId,
        pageFrom: entry.page,
        pageTo: entry.pageEnd,
        chapterTitle: entry.title,
      },
    }));
  }

  private async handleDeleteEntry(entryId: string, book: Book): Promise<void> {
    // Remove entry and all children
    const toRemove = new Set<string>();
    toRemove.add(entryId);
    // Find children recursively
    const findChildren = (parentId: string) => {
      for (const e of this.toc) {
        if (e.parentId === parentId) {
          toRemove.add(e.id);
          findChildren(e.id);
        }
      }
    };
    findChildren(entryId);

    this.toc = this.toc.filter(e => !toRemove.has(e.id));
    computePageRanges(this.toc, book.totalPages);
    await db.books.update(this.bookId, { tableOfContents: this.toc, updatedAt: Date.now() });
    await this.render();
  }

  private async handleSaveEntry(entryId: string, book: Book): Promise<void> {
    const titleInput = this.container.querySelector(`#edit-title-${entryId}`) as HTMLInputElement;
    const pageInput = this.container.querySelector(`#edit-page-${entryId}`) as HTMLInputElement;
    const levelSelect = this.container.querySelector(`#edit-level-${entryId}`) as HTMLSelectElement;

    if (!titleInput || !pageInput || !levelSelect) return;

    const entry = this.toc.find(e => e.id === entryId);
    if (!entry) return;

    entry.title = titleInput.value.trim() || 'Без названия';
    entry.page = Math.max(1, Math.min(parseInt(pageInput.value) || 1, book.totalPages));
    entry.level = parseInt(levelSelect.value) || 1;

    // Recompute hierarchy — clear parentId if level changed to 1
    if (entry.level === 1) {
      entry.parentId = undefined;
    }

    computePageRanges(this.toc, book.totalPages);
    await db.books.update(this.bookId, { tableOfContents: this.toc, updatedAt: Date.now() });
    this.editingEntryId = null;
    this.renderTree(book);
  }

  // ---- UI helpers ----

  private updateProgress(msg: string, pct: number): void {
    const progress = this.container.querySelector('#toc-progress');
    const fill = this.container.querySelector('#toc-progress-fill') as HTMLElement;
    const text = this.container.querySelector('#toc-progress-text');

    if (progress && fill && text) {
      progress.setAttribute('style', 'display:block;');
      fill.style.width = `${pct}%`;
      text.textContent = msg;
    }
  }

  private showError(msg: string): void {
    const errEl = this.container.querySelector('#toc-error');
    if (errEl) {
      errEl.textContent = msg;
      errEl.setAttribute('style', 'display:block;');
    }
  }

  private hideError(): void {
    const errEl = this.container.querySelector('#toc-error');
    if (errEl) {
      errEl.setAttribute('style', 'display:none;');
    }
    const progress = this.container.querySelector('#toc-progress');
    if (progress) {
      progress.setAttribute('style', 'display:none;');
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
