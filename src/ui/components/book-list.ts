// ============================================================
// Book List View — library of connected books
// ============================================================

import { db } from '../../db/index.js';
import type { Book, ExtractionMode } from '../../db/schema.js';
import { storeFileHandle, hasFileHandle, ensureFileAccess, reconnectFileHandleWithCheck, deleteStoredHandle } from '../utils/file-store.js';
import '../styles/components/book-list.css';

export class BookListView {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async render(): Promise<void> {
    const books = await db.books.toArray();
    const sortedBooks = books.sort((a, b) => b.updatedAt - a.updatedAt);

    this.container.innerHTML = `
      <div class="book-list-view">
        <div class="view-header">
          <h2>📚 Библиотека</h2>
          <div class="view-actions">
            <button class="primary-btn" id="btn-add-book">+ Добавить книгу</button>
          </div>
        </div>
        <p class="view-description">
          Подключите PDF или DJVU книгу для анализа идей. Файл остаётся на диске — расширение хранит только ссылки и извлечённые идеи.
        </p>
        <div id="books-grid" class="books-grid">
          ${sortedBooks.length === 0 ? this.renderEmpty() : ''}
          ${sortedBooks.map((b) => this.renderBookCard(b)).join('')}
        </div>
      </div>
    `;

    this.bindEvents();
  }

  private renderEmpty(): string {
    return `
      <div class="empty-state">
        <div class="empty-icon">∅</div>
        <p>Нет подключённых книг</p>
        <p class="empty-hint">Нажмите «Добавить книгу» чтобы начать</p>
      </div>
    `;
  }

  private renderBookCard(book: Book): string {
    const formatBadge = book.format === 'pdf' ? 'PDF' : 'DJVU';
    const MODE_LABELS: Record<ExtractionMode, string> = { text: 'Текст', ocr: 'OCR', vlm: 'VLM' };
    const modeBadge = MODE_LABELS[book.extractionMode] || book.extractionMode;
    const isDisconnected = !hasFileHandle(book.id);

    return `
      <div class="book-card ${isDisconnected ? 'book-card-disconnected' : ''}" data-book-id="${book.id}">
        <div class="book-card-header">
          <span class="format-badge ${book.format}">${formatBadge}</span>
          <span class="mode-badge">${modeBadge}</span>
          ${isDisconnected ? '<span class="disconnected-badge" title="Файл не подключён">⚠️ Подключите файл</span>' : ''}
        </div>
        <h3 class="book-title">${this.esc(book.title || 'Без названия')}</h3>
        <p class="book-author">${this.esc(book.author || 'Неизвестный автор')}</p>
        <div class="book-meta">
          <span>${book.totalPages} стр.</span>
          ${book.tableOfContents && book.tableOfContents.length > 0
            ? `<span class="toc-badge" title="Оглавление извлечено">≡ ${book.tableOfContents.filter(e => e.level === 1).length} глав</span>`
            : '<span class="toc-badge toc-empty" title="Оглавление не указано">≡ —</span>'
          }
        </div>
        <div class="book-actions">
          <button class="secondary-btn btn-select-book" data-book-id="${book.id}">Открыть идеи</button>
          <button class="secondary-btn btn-open-toc" data-book-id="${book.id}" title="Оглавление">≡ Оглавление</button>
          ${isDisconnected ? `<button class="secondary-btn btn-reconnect-book" data-book-id="${book.id}" data-file-name="${this.esc(book.filePath || '')}" title="Выберите PDF/DJVU файл">🔗 Подключить файл</button>` : ''}
          <button class="icon-btn btn-open-reader" data-book-id="${book.id}" data-page="1" title="Открыть в ридере">↗</button>
          <button class="icon-btn btn-remove-book" data-book-id="${book.id}" title="Удалить">🗑️</button>
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    document.getElementById('btn-add-book')?.addEventListener('click', () => this.addBook());

    this.container.querySelectorAll('.btn-select-book').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const bookId = (btn as HTMLElement).dataset.bookId;
        if (!bookId) return;

        // Ensure file access: restore from IndexedDB if needed, request permission if prompted
        const access = await ensureFileAccess(bookId);
        if (access === null) {
          // No handle at all — prompt user to pick the file
          const book = await db.books.get(bookId);
          const handle = await reconnectFileHandleWithCheck(bookId, book?.filePath);
          if (!handle) return; // User cancelled
        } else if (access === 'denied') {
          alert('Доступ к файлу запрещён. Переподключите через кнопку «🔗 Подключить файл».');
          return;
        }

        document.dispatchEvent(new CustomEvent('book-selected', { detail: { bookId } }));
      });
    });

    // Open TOC buttons
    this.container.querySelectorAll('.btn-open-toc').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bookId = (btn as HTMLElement).dataset.bookId;
        if (!bookId) return;
        document.dispatchEvent(new CustomEvent('open-toc', { detail: { bookId } }));
      });
    });

    // Reconnect buttons on book cards
    this.container.querySelectorAll('.btn-reconnect-book').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const bookId = (btn as HTMLElement).dataset.bookId;
        const expectedName = (btn as HTMLElement).dataset.fileName;
        if (!bookId) return;

        const handle = await reconnectFileHandleWithCheck(bookId, expectedName || undefined);
        if (handle) {
          this.render(); // Re-render to update card state
        }
      });
    });

    this.container.querySelectorAll('.btn-open-reader').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bookId = (btn as HTMLElement).dataset.bookId;
        const page = (btn as HTMLElement).dataset.page || '1';
        this.openInReader(bookId!, Number(page));
      });
    });

    this.container.querySelectorAll('.btn-remove-book').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const bookId = (btn as HTMLElement).dataset.bookId;
        if (bookId && confirm('Удалить книгу и все её идеи?')) {
          await db.ideas.where('bookId').equals(bookId).delete();
          await db.books.delete(bookId);
          await deleteStoredHandle(bookId);
          this.render();
        }
      });
    });
  }

  private async addBook(): Promise<void> {
    try {
      const [handle] = await (window as unknown as { showOpenFilePicker: (opts?: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
        types: [{
          description: 'Книги (PDF, DJVU)',
          accept: { 'application/pdf': ['.pdf'], 'image/vnd.djvu': ['.djvu', '.djv'] },
        }],
        multiple: false,
      });

      const file = await handle.getFile();
      const name = file.name.toLowerCase();
      const format = name.endsWith('.djvu') || name.endsWith('.djv') ? 'djvu' : 'pdf';

      let totalPages = 0;
      let extractionMode: ExtractionMode = 'text';

      if (format === 'pdf') {
        const { getPDFPageCount, extractTextFromPDFPage } = await import('../../extraction/text-extractor.js');
        const buffer = await file.arrayBuffer();
        totalPages = await getPDFPageCount(buffer);
        if (totalPages > 0) {
          const { text } = await extractTextFromPDFPage(buffer, 1);
          const { evaluateTextLayer } = await import('../../extraction/mode-detector.js');
          extractionMode = evaluateTextLayer(text, 'pdf').suggestedMode;
        }
      } else {
        extractionMode = 'vlm';
      }

      const book: Book = {
        id: crypto.randomUUID(),
        title: file.name.replace(/\.(pdf|djvu|djv)$/i, ''),
        author: '',
        totalPages,
        format: format as 'pdf' | 'djvu',
        extractionMode,
        filePath: file.name,
        pageOffset: 0,
        tableOfContents: [],
        lastAnalyzedPage: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await db.books.add(book);

      // Store file handle in memory AND IndexedDB (persists across reloads)
      await storeFileHandle(book.id, handle);

      this.render();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        alert(`Ошибка: ${(err as Error).message}`);
      }
    }
  }

  private async openInReader(bookId: string, page: number): Promise<void> {
    const book = await db.books.get(bookId);
    if (!book) return;
    const cmd = `zathura -f ${page} "${book.filePath || book.title}"`;
    try { await navigator.clipboard.writeText(cmd); } catch { /* noop */ }
    alert(`Команда скопирована:\n\n${cmd}`);
  }

  private esc(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}
