// ============================================================
// TOC Panel — Table of Contents UI
// ============================================================

import { db } from '../../db/index.js';
import type { TOCEntry, Book } from '../../db/schema.js';
import { getSettings } from '../../db/index.js';
import { createProvider } from '../../background/ai-client.js';
import { extractTOC, summarizeTOCChapters, computePageRanges } from '../../extraction/toc-extractor.js';
import { ensureFileAccess, reconnectFileHandleWithCheck, readFileAsArrayBuffer } from '../utils/file-store.js';
import { openInZathura } from '../utils/native-messaging.js';
import '../../ui/styles/components/toc-panel.css';

export class TOCPanel {
  private container: HTMLElement;
  private bookId: string;
  private book: Book | null = null;
  private toc: TOCEntry[] = [];
  private isExtracting = false;
  private editingEntryId: string | null = null;

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  async render(): Promise<void> {
    this.book = (await db.books.get(this.bookId)) ?? null;
    if (!this.book) {
      this.container.innerHTML = '<div class="empty-state"><p>Книга не найдена</p></div>';
      return;
    }
    this.toc = this.book.tableOfContents || [];

    this.container.innerHTML = `
      <div class="toc-panel">
        ${this.buildHeaderHtml()}
        ${this.buildInputSectionHtml()}
        ${this.buildTreeHtml()}
      </div>
    `;

    this.bindEvents();
  }

  // ---- Build HTML sections (used in initial render) ----

  private buildHeaderHtml(): string {
    const chapters = this.toc.filter(e => e.level === 1);
    return `
      <div class="toc-header">
        <div class="toc-header-left">
          <h2>≡ Оглавление</h2>
          ${this.toc.length > 0 ? `<span class="toc-chapter-count">${chapters.length} глав</span>` : ''}
        </div>
        <div class="toc-header-actions">
          ${this.toc.length > 0 ? `
            <button class="secondary-btn" id="toc-summarize-all">≡ Суммаризировать</button>
            <button class="secondary-btn" id="toc-clear">x Очистить</button>
          ` : ''}
        </div>
      </div>
    `;
  }

  private buildInputSectionHtml(): string {
    const book = this.book!;
    const hasTOC = this.toc.length > 0;
    const offset = book.pageOffset || 0;
    return `
      <div class="toc-input-section" id="toc-input-section">
        ${!hasTOC ? '<p style="margin:0 0 12px;color:var(--text-secondary);font-size:0.9rem;">Укажите страницы, где напечатано оглавление книги:</p>' : ''}
        <div class="toc-input-row">
          <label>Страницы:</label>
          <input type="number" class="toc-page-input" id="toc-from" value="${!hasTOC ? 1 : ''}" min="1" max="${book.totalPages}" placeholder="от">
          <span class="toc-page-separator">—</span>
          <input type="number" class="toc-page-input" id="toc-to" value="${!hasTOC ? 5 : ''}" min="1" max="${book.totalPages}" placeholder="до">
          <button class="primary-btn" id="toc-extract-btn" ${this.isExtracting ? 'disabled' : ''}>
            ${this.isExtracting ? '... Распознаём...' : 'Распознать'}
          </button>
        </div>
        ${hasTOC ? `
        <div class="toc-offset-row">
          <label class="toc-offset-label">Сдвиг страниц (книга→PDF):</label>
          <input type="number" class="toc-page-input toc-offset-input" id="toc-offset" value="${offset}" title="Если страница в книге N открывается в PDF на странице M, сдвиг = M - N">
          <button class="secondary-btn" id="toc-apply-offset">Применить</button>
          <button class="secondary-btn" id="toc-calibrate-offset" title="По одной известной странице вычислить сдвиг">/ Калибровать</button>
        </div>
        ` : ''}
        <div class="toc-progress" id="toc-progress">
          <div class="toc-progress-bar"><div class="toc-progress-fill" id="toc-progress-fill"></div></div>
          <div class="toc-progress-text" id="toc-progress-text"></div>
        </div>
        <div class="toc-error" id="toc-error"></div>
      </div>
    `;
  }

  private buildTreeHtml(): string {
    if (this.toc.length === 0) {
      return `
        <div class="toc-tree-container" id="toc-tree">
          <div class="toc-empty">
            <div class="toc-empty-icon">≡</div>
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
        ${this.toc.map(entry => this.buildEntryHtml(entry)).join('')}
      </div>
      <div class="toc-add-section" id="toc-add-section">
        <button class="toc-add-btn" id="toc-add-entry">+ Добавить раздел</button>
      </div>
    `;
  }

  private buildEntryHtml(entry: TOCEntry): string {
    const book = this.book!;
    const isEditing = this.editingEntryId === entry.id;
    const offset = book.pageOffset || 0;
    const docPage = entry.page + offset;
    const docPageEnd = entry.pageEnd ? entry.pageEnd + offset : docPage;
    const pageStr = entry.pageEnd ? `${entry.page}–${entry.pageEnd}` : `${entry.page}`;
    const docPageStr = entry.pageEnd ? `${docPage}–${docPageEnd}` : `${docPage}`;
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
              <button class="toc-edit-save" data-save-id="${entry.id}">Сохранить</button>
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
            <span class="toc-page-range" title="Номера в книге">${pageStr}</span>
            ${offset !== 0 ? `<span class="toc-doc-page" title="Номера в PDF">PDF ${docPageStr}</span>` : ''}
            <span>${pageCount} стр.</span>
            <span class="toc-ideas-badge ${!entry.ideasCount ? 'empty' : ''}">
              ✦${entry.ideasCount ?? 0}
            </span>
          </div>
          ${entry.summary ? `<div class="toc-summary">${this.escapeHtml(entry.summary)}</div>` : ''}
        </div>
        <div class="toc-entry-actions">
          <button class="toc-btn-sm btn-zathura" data-page="${docPage}" title="Открыть в zathura на стр. ${docPage}">▸ zathura</button>
          <button class="toc-btn-sm btn-analyze" data-analyze-id="${entry.id}" title="Анализировать">▶ Анализ</button>
          <button class="toc-btn-sm" data-edit-id="${entry.id}" title="Редактировать">✏️</button>
          <button class="toc-btn-sm btn-delete" data-delete-id="${entry.id}" title="Удалить">✕</button>
        </div>
      </div>
    `;
  }

  // ---- Refresh tree DOM without full re-render ----

  private refreshTree(): void {
    const treeEl = this.container.querySelector('#toc-tree');
    const addEl = this.container.querySelector('#toc-add-section');
    const book = this.book!;

    if (treeEl) {
      treeEl.innerHTML = this.toc.length === 0
        ? `<div class="toc-empty">
            <div class="toc-empty-icon">≡</div>
            <p class="toc-empty-hint">Оглавление пусто.</p>
          </div>`
        : this.toc.map(entry => this.buildEntryHtml(entry)).join('');
    }

    if (addEl) {
      addEl.innerHTML = '<button class="toc-add-btn" id="toc-add-entry">+ Добавить раздел</button>';
    }

    // Re-bind tree events
    this.bindTreeEvents();

    // Update header counts
    const chapters = this.toc.filter(e => e.level === 1);
    const countEl = this.container.querySelector('.toc-chapter-count');
    if (countEl) {
      countEl.textContent = `${chapters.length} глав`;
      if (this.toc.length === 0) countEl.remove();
    }
  }

  // ---- Event binding ----

  private bindEvents(): void {
    // Extract TOC button
    this.container.querySelector('#toc-extract-btn')?.addEventListener('click', () => this.handleExtract());

    // Summarize all
    this.container.querySelector('#toc-summarize-all')?.addEventListener('click', () => this.handleSummarizeAll());

    // Clear TOC
    this.container.querySelector('#toc-clear')?.addEventListener('click', () => this.handleClear());

    // Add entry
    this.container.querySelector('#toc-add-entry')?.addEventListener('click', () => this.handleAddEntry());

    // Page offset
    this.container.querySelector('#toc-apply-offset')?.addEventListener('click', () => this.handleApplyOffset());
    this.container.querySelector('#toc-calibrate-offset')?.addEventListener('click', () => this.handleCalibrateOffset());

    // Tree events
    this.bindTreeEvents();

    // Enter/Escape in edit inputs
    this.container.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.editingEntryId) {
        this.handleSaveEntry(this.editingEntryId);
      } else if (e.key === 'Escape' && this.editingEntryId) {
        this.editingEntryId = null;
        this.refreshTree();
      }
    });
  }

  private bindTreeEvents(): void {
    const tree = this.container.querySelector('#toc-tree');
    if (!tree) return;

    // Remove old listener by cloning (event delegation via a single handler)
    const newTree = tree.cloneNode(true) as HTMLElement;
    tree.parentNode?.replaceChild(newTree, tree);

    newTree.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const zathuraBtn = target.closest('.btn-zathura') as HTMLElement;
      const analyzeBtn = target.closest('[data-analyze-id]') as HTMLElement;
      const editBtn = target.closest('[data-edit-id]') as HTMLElement;
      const deleteBtn = target.closest('[data-delete-id]') as HTMLElement;
      const saveBtn = target.closest('[data-save-id]') as HTMLElement;
      const cancelBtn = target.closest('[data-cancel-id]') as HTMLElement;

      if (zathuraBtn) {
        this.handleOpenZathura(zathuraBtn);
      } else if (analyzeBtn) {
        this.handleAnalyzeChapter(analyzeBtn.dataset.analyzeId!);
      } else if (editBtn) {
        this.editingEntryId = editBtn.dataset.editId!;
        this.refreshTree();
        this.focusEditInput(this.editingEntryId);
      } else if (deleteBtn) {
        this.handleDeleteEntry(deleteBtn.dataset.deleteId!);
      } else if (saveBtn) {
        this.handleSaveEntry(saveBtn.dataset.saveId!);
      } else if (cancelBtn) {
        this.editingEntryId = null;
        this.refreshTree();
      }
    });

    // Add entry button (in case tree was refreshed)
    this.container.querySelector('#toc-add-entry')?.addEventListener('click', () => this.handleAddEntry());
  }

  private focusEditInput(entryId: string): void {
    const el = this.container.querySelector(`#edit-title-${entryId}`) as HTMLInputElement;
    if (el) el.focus();
  }

  // ---- Handlers ----

  private async handleExtract(): Promise<void> {
    if (this.isExtracting) return;
    const book = this.book!;

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

    // Immediately update button in DOM
    const extractBtn = this.container.querySelector('#toc-extract-btn') as HTMLButtonElement;
    if (extractBtn) {
      extractBtn.disabled = true;
      extractBtn.textContent = '... Распознаём';
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

      const access = await ensureFileAccess(this.bookId);
      if (access === null) {
        const handle = await reconnectFileHandleWithCheck(this.bookId, book.filePath);
        if (!handle) {
          this.showError('Не выбран файл. Нажмите «⟷ Подключить файл» в списке книг.');
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
      const btn = this.container.querySelector('#toc-extract-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Распознать';
      }
    }
  }

  private async handleSummarizeAll(): Promise<void> {
    try {
      const settings = await getSettings();
      const apiKey = settings.providerKeys[settings.activeProvider];
      if (!apiKey) { this.showError('API ключ не настроен'); return; }
      const provider = createProvider(settings.activeProvider, apiKey, { zaiBaseUrl: settings.zaiBaseUrl });

      await summarizeTOCChapters({
        bookId: this.bookId,
        provider,
        model: settings.activeModel,
        fallbackModels: settings.fallbackModels.split(',').filter(Boolean),
        requestDelayMs: settings.requestDelayMs,
        onProgress: (msg, pct) => this.updateProgress(msg, pct),
      });

      const updatedBook = await db.books.get(this.bookId);
      if (updatedBook) {
        this.book = updatedBook;
        this.toc = updatedBook.tableOfContents || [];
        await this.render();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showError(`Ошибка: ${msg}`);
    }
  }

  private async handleClear(): Promise<void> {
    if (!confirm('Удалить оглавление? Связи идей с главами будут потеряны.')) return;
    await db.books.update(this.bookId, { tableOfContents: [], updatedAt: Date.now() });
    this.toc = [];
    await this.render();
  }

  private async handleAddEntry(): Promise<void> {
    const book = this.book!;
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
    this.refreshTree();
    this.focusEditInput(newEntry.id);
    // Select title text
    const el = this.container.querySelector(`#edit-title-${newEntry.id}`) as HTMLInputElement;
    if (el) el.select();
  }

  private async handleAnalyzeChapter(entryId: string): Promise<void> {
    const entry = this.toc.find(e => e.id === entryId);
    if (!entry) return;

    // Compute page range in BOOK numbering — if no pageEnd, estimate
    const pageFromBook = entry.page;
    let pageToBook = entry.pageEnd;
    if (!pageToBook) {
      // Try to find the next entry at the same or higher level
      const sorted = [...this.toc].sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        return a.level - b.level;
      });
      const idx = sorted.findIndex(e => e.id === entryId);
      if (idx >= 0) {
        for (let j = idx + 1; j < sorted.length; j++) {
          if (sorted[j].level <= entry.level) {
            pageToBook = sorted[j].page - 1;
            break;
          }
        }
      }
      // Fallback: estimate ~10 pages
      if (!pageToBook) {
        pageToBook = Math.min(entry.page + 9, this.book!.totalPages);
      }
    }

    // Convert book pages → document pages using offset
    const offset = this.book!.pageOffset || 0;
    const pageFrom = pageFromBook + offset;
    const pageTo = pageToBook + offset;

    document.dispatchEvent(new CustomEvent('analyze-chapter', {
      detail: {
        bookId: this.bookId,
        pageFrom,
        pageTo,
        chapterTitle: entry.title,
        chapterId: entry.id,
      },
    }));
  }

  private async handleDeleteEntry(entryId: string): Promise<void> {
    const book = this.book!;
    const toRemove = new Set<string>();
    toRemove.add(entryId);
    const findChildren = (parentId: string) => {
      for (const e of this.toc) {
        if (e.parentId === parentId) { toRemove.add(e.id); findChildren(e.id); }
      }
    };
    findChildren(entryId);

    this.toc = this.toc.filter(e => !toRemove.has(e.id));
    computePageRanges(this.toc, book.totalPages);
    await db.books.update(this.bookId, { tableOfContents: this.toc, updatedAt: Date.now() });
    this.refreshTree();
  }

  private async handleSaveEntry(entryId: string): Promise<void> {
    const book = this.book!;
    const titleInput = this.container.querySelector(`#edit-title-${entryId}`) as HTMLInputElement;
    const pageInput = this.container.querySelector(`#edit-page-${entryId}`) as HTMLInputElement;
    const levelSelect = this.container.querySelector(`#edit-level-${entryId}`) as HTMLSelectElement;

    if (!titleInput || !pageInput || !levelSelect) return;

    const entry = this.toc.find(e => e.id === entryId);
    if (!entry) return;

    entry.title = titleInput.value.trim() || 'Без названия';
    entry.page = Math.max(1, Math.min(parseInt(pageInput.value) || 1, book.totalPages));
    entry.level = parseInt(levelSelect.value) || 1;

    if (entry.level === 1) {
      entry.parentId = undefined;
    }

    computePageRanges(this.toc, book.totalPages);
    await db.books.update(this.bookId, { tableOfContents: this.toc, updatedAt: Date.now() });
    this.editingEntryId = null;
    this.refreshTree();
  }

  // ---- Zathura ----

  private async handleOpenZathura(btn: HTMLElement): Promise<void> {
    const book = this.book!;
    if (!book.filePath) return;

    const page = parseInt(btn.dataset.page || '1', 10);
    const original = btn.textContent;
    btn.textContent = '...';
    btn.classList.add('btn-zathura-loading');

    try {
      const result = await openInZathura(book.filePath, page);
      if (result.launched) {
        btn.textContent = '[ok]';
      } else {
        btn.textContent = '[копия]';
      }
    } catch {
      btn.textContent = '[!]';
    }

    btn.classList.remove('btn-zathura-loading');
    setTimeout(() => { btn.textContent = original; }, 2000);
  }

  // ---- Page Offset ----

  private async handleApplyOffset(): Promise<void> {
    const book = this.book!;
    const offsetInput = this.container.querySelector('#toc-offset') as HTMLInputElement;
    if (!offsetInput) return;

    const offset = parseInt(offsetInput.value) || 0;
    await db.books.update(this.bookId, { pageOffset: offset, updatedAt: Date.now() });
    book.pageOffset = offset;

    // Refresh tree to show updated document pages
    this.refreshTree();
  }

  private async handleCalibrateOffset(): Promise<void> {
    const book = this.book!;
    if (this.toc.length === 0) return;

    // Pick first level-1 entry as the reference
    const refEntry = this.toc.find(e => e.level === 1);
    if (!refEntry) return;

    const bookPage = refEntry.page;
    const docPageStr = prompt(
      `Калибровка сдвига страниц\n\n` +
      `Раздел «${refEntry.title}» в книге: страница ${bookPage}\n` +
      `Откройте эту страницу в zathura и введите фактический номер страницы в PDF:\n\n` +
      `Если PDF совпадает с книгой — введите ${bookPage} (сдвиг = 0)`,
      String(bookPage),
    );

    if (docPageStr === null) return; // cancelled

    const docPage = parseInt(docPageStr);
    if (isNaN(docPage) || docPage < 1) {
      this.showError('Некорректный номер страницы');
      return;
    }

    const offset = docPage - bookPage;
    await db.books.update(this.bookId, { pageOffset: offset, updatedAt: Date.now() });
    book.pageOffset = offset;

    // Update the offset input
    const offsetInput = this.container.querySelector('#toc-offset') as HTMLInputElement;
    if (offsetInput) offsetInput.value = String(offset);

    // Refresh tree to show updated document pages
    this.refreshTree();
  }

  // ---- UI helpers ----

  private updateProgress(msg: string, pct: number): void {
    const progress = this.container.querySelector('#toc-progress') as HTMLElement;
    const fill = this.container.querySelector('#toc-progress-fill') as HTMLElement;
    const text = this.container.querySelector('#toc-progress-text') as HTMLElement;

    if (progress && fill && text) {
      progress.style.display = 'block';
      fill.style.width = `${pct}%`;
      text.textContent = msg;
    }
  }

  private showError(msg: string): void {
    const errEl = this.container.querySelector('#toc-error') as HTMLElement;
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
  }

  private hideError(): void {
    const errEl = this.container.querySelector('#toc-error') as HTMLElement;
    if (errEl) errEl.style.display = 'none';

    const progress = this.container.querySelector('#toc-progress') as HTMLElement;
    if (progress) progress.style.display = 'none';
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
