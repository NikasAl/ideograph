// ============================================================
// Idea List View — cards with extracted ideas and filters
// ============================================================

import { db, getSettings, loadIdeaChat, saveIdeaChat } from '../../db/index.js';
import type { Idea, Familiarity, IdeaStatus, TOCEntry, IdeaChatMessage } from '../../db/schema.js';
import type { ChatMessage } from '../../background/ai-client.js';
import { createProvider, parseFallbackModels } from '../../background/ai-client.js';
import { assignChapterIds } from '../../extraction/toc-extractor.js';
import { AnalysisPanel } from './analysis-panel.js';
import { openInZathura, isNativeHostAvailable } from '../utils/native-messaging.js';
import katex from 'katex';
import { marked } from 'marked';
import '../styles/components/idea-list.css';
import 'katex/dist/katex.min.css';

const TYPE_ICONS: Record<string, string> = {
  definition: '', method: '\\', theorem: '/',
  insight: '✦', example: '_', analogy: '↻',
};
const DEPTH_LABELS: Record<string, string> = { basic: 'Базовый', medium: 'Средний', advanced: 'Продвинутый' };
const FAM_LABELS: Record<Familiarity, string> = { unknown: 'Не изучал', heard: 'Слышал', known: 'Знаю', new: 'Новая' };
const STAT_LABELS: Record<IdeaStatus, string> = {
  unseen: 'Не изучал', in_progress: 'В процессе', mastered: 'Освоено', applied: 'Применяю', confused: 'Не понятно',
};
const STAT_COLORS: Record<IdeaStatus, string> = {
  unseen: 'status-unseen', in_progress: 'status-progress', mastered: 'status-mastered',
  applied: 'status-applied', confused: 'status-confused',
};

export class IdeaListView {
  private container: HTMLElement;
  private bookId: string;
  private bookFilePath?: string;
  private filters = { familiarity: 'all' as Familiarity | 'all', status: 'all' as IdeaStatus | 'all', type: 'all' as Idea['type'] | 'all', chapter: 'all' as string };
  private tocEntries: TOCEntry[] = [];
  /** Per-idea chat history (user + assistant messages) */
  private chatHistories = new Map<string, IdeaChatMessage[]>();
  /** Track which ideas have chats loaded from DB */
  private chatLoaded = new Set<string>();
  /** System prompts built per idea (cached to avoid re-reading pageCache) */
  private chatSystemPrompts = new Map<string, string>();

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  async render(): Promise<void> {
    const book = await db.books.get(this.bookId);
    this.bookFilePath = book?.filePath;
    const toc = book?.tableOfContents || [];
    const pageOffset = book?.pageOffset || 0;
    const chapters = toc.filter(e => e.level === 1);
    const allIdeas = await db.ideas.where('bookId').equals(this.bookId).toArray();
    // Re-compute chapterIds with current pageOffset so chapter filter works correctly
    assignChapterIds(allIdeas, toc, pageOffset);
    // Build TOC path lookup for each idea (idea.id → [rootEntry, ..., mostSpecificEntry])
    const tocPaths = this.buildTocPaths(allIdeas, toc, pageOffset);
    const ideas = this.applyFilters(allIdeas, tocPaths);

    this.tocEntries = toc;
    // Pre-load which ideas have saved chats (for dot indicator on initial render)
    const allChatRecords = await db.ideaChats.where('ideaId').anyOf(ideas.map(i => i.id)).toArray();
    const ideasWithChats = new Set(allChatRecords.filter(r => r.messages.length > 0).map(r => r.ideaId));
    const allSections = toc.length > 0
      ? `<select id="filter-chapter" class="filter-select">
          <option value="all"${this.filters.chapter === 'all' ? ' selected' : ''}>Все разделы</option>
          ${toc.map(e => {
            const indent = '  '.repeat(e.level - 1);
            const prefix = e.level === 1 ? '' : (e.level === 2 ? '└ ' : '└ ');
            return `<option value="${e.id}"${this.filters.chapter === e.id ? ' selected' : ''}>${indent}${prefix}${this.esc(e.title)}</option>`;
          }).join('')}
        </select>`
      : '';

    this.container.innerHTML = `
      <div class="idea-list-view">
        <div class="view-header">
          <h2>✦ Идеи: ${book ? this.esc(book.title) : ''}</h2>
          <button class="primary-btn" id="btn-analyze">Анализировать</button>
        </div>
        <div class="filters-bar">
          <select id="filter-fam" class="filter-select">
            <option value="all"${this.filters.familiarity === 'all' ? ' selected' : ''}>Все уровни знакомства</option>
            <option value="unknown"${this.filters.familiarity === 'unknown' ? ' selected' : ''}>[-] Не изучал</option>
            <option value="heard"${this.filters.familiarity === 'heard' ? ' selected' : ''}>! Слышал</option>
            <option value="known"${this.filters.familiarity === 'known' ? ' selected' : ''}>+ Знаю</option>
            <option value="new"${this.filters.familiarity === 'new' ? ' selected' : ''}>new Новые</option>
          </select>
          <select id="filter-stat" class="filter-select">
            <option value="all"${this.filters.status === 'all' ? ' selected' : ''}>Все статусы</option>
            <option value="unseen"${this.filters.status === 'unseen' ? ' selected' : ''}>Не изучал</option>
            <option value="in_progress"${this.filters.status === 'in_progress' ? ' selected' : ''}>В процессе</option>
            <option value="mastered"${this.filters.status === 'mastered' ? ' selected' : ''}>Освоено</option>
            <option value="applied"${this.filters.status === 'applied' ? ' selected' : ''}>Применяю</option>
            <option value="confused"${this.filters.status === 'confused' ? ' selected' : ''}>Не понятно</option>
          </select>
          <select id="filter-type" class="filter-select">
            <option value="all"${this.filters.type === 'all' ? ' selected' : ''}>Все типы</option>
            <option value="definition"${this.filters.type === 'definition' ? ' selected' : ''}>Определение</option>
            <option value="method"${this.filters.type === 'method' ? ' selected' : ''}>Метод</option>
            <option value="theorem"${this.filters.type === 'theorem' ? ' selected' : ''}>Теорема</option>
            <option value="insight"${this.filters.type === 'insight' ? ' selected' : ''}>Инсайт</option>
            <option value="example"${this.filters.type === 'example' ? ' selected' : ''}>Пример</option>
            <option value="analogy"${this.filters.type === 'analogy' ? ' selected' : ''}>Аналогия</option>
          </select>
          ${allSections}
          <span class="idea-count">${ideas.length} / ${allIdeas.length}</span>
        </div>
        <div class="ideas-container">
          ${ideas.length === 0 ? `
            <div class="empty-state"><div class="empty-icon">◇</div>
            <p>Идеи ещё не извлечены</p><p class="empty-hint">Нажмите «Анализировать»</p></div>
          ` : ideas.map((i) => this.card(i, tocPaths.get(i.id) || null, ideasWithChats.has(i.id))).join('')}
        </div>
      </div>`;

    this.bind();
  }

  private card(i: Idea, tocPath: TOCEntry[] | null, hasChat: boolean): string {
    const tocBreadcrumb = tocPath && tocPath.length > 0
      ? `<div class="idea-toc-path">${tocPath.map(e => `<span class="toc-path-segment toc-path-level-${e.level}">${this.renderMarkdown(e.title, false)}</span>`).join(' <span class="toc-path-sep">/</span> ')}</div>`
      : '';
    return `
      <div class="idea-card ${STAT_COLORS[i.status]}" data-idea-id="${i.id}">
        <div class="idea-card-header">
          <span class="idea-type-icon">${TYPE_ICONS[i.type] || '◇'}</span>
          <span class="idea-depth-badge depth-${i.depth}">${DEPTH_LABELS[i.depth]}</span>
          <span class="idea-star-rating" data-idea-id="${i.id}">
            ${[1,2,3,4,5].map(s => `<span class="star-btn${s <= i.importance ? ' star-filled' : ''}" data-star="${s}">&#9733;</span>`).join('')}
          </span>
          <button class="btn-edit-idea" data-idea-id="${i.id}" title="Редактировать текст идеи">✎</button>
        </div>
        ${tocBreadcrumb}
        <div class="idea-content-fields" data-edit-idea-id="${i.id}">
          <h3 class="idea-title idea-editable-field" data-field="title">${this.renderMarkdown(i.title, false)}</h3>
          <p class="idea-summary idea-editable-field" data-field="summary">${this.renderMarkdown(i.summary, false)}</p>
          ${i.quote ? `<blockquote class="idea-quote idea-editable-field" data-field="quote">${this.renderMarkdown(i.quote, false)}</blockquote>` : ''}
        </div>
        <div class="idea-edit-toolbar" id="edit-toolbar-${i.id}" style="display:none">
          <button class="btn-save-edit" data-idea-id="${i.id}">✓ Сохранить</button>
          <button class="btn-cancel-edit" data-idea-id="${i.id}">✕ Отмена</button>
        </div>
        <div class="idea-meta">
          <span>стр. ${i.pages.join(', ')}</span>
            ${i.relations.length ? `<span class="relations-badge">${i.relations.length} связей</span>` : ''}
          <button class="btn-context" data-idea-id="${i.id}" data-book-id="${i.bookId}" data-pages="${i.pages.join(',')}">▽ Контекст</button>
          ${this.bookFilePath ? `
            ${i.pages.map((p, idx) => `
              <button class="btn-zathura" data-page="${p}" data-quote="${this.escAttr(i.quote || '')}" title="Открыть в zathura на стр. ${p}">
                ▸ zathura${idx === 0 && i.quote ? ' + поиск' : ''}
              </button>
            `).join('')}
          ` : ''}
          ${!this.bookFilePath ? `
            <span class="zathura-hint" title="Добавьте путь к файлу в настройках книги">zathura: путь не указан</span>
          ` : ''}
        </div>
        <div class="idea-context-container" id="context-${i.id}"></div>
        <div class="idea-card-actions">
          <div class="familiarity-group">
            <label class="group-label">Знакомство:</label>
            ${(['unknown','heard','known'] as Familiarity[]).map(f => `
              <button class="toggle-btn ${i.familiarity === f ? 'active' : ''}" data-field="familiarity" data-value="${f}">${FAM_LABELS[f]}</button>
            `).join('')}
          </div>
          <div class="status-group">
            <label class="group-label">Статус:</label>
            ${(['unseen','in_progress','mastered','applied','confused'] as IdeaStatus[]).map(s => `
              <button class="toggle-btn ${i.status === s ? 'active' : ''}" data-field="status" data-value="${s}">${STAT_LABELS[s]}</button>
            `).join('')}
          </div>
        </div>
        <div class="idea-notes" id="notes-${i.id}">
          <div class="notes-toggle" data-notes-id="${i.id}">
            <span class="notes-toggle-icon">▶</span>
            <label>_ Заметки</label>
            ${i.notes ? '<span class="notes-has-content"></span>' : ''}
          </div>
          <div class="notes-body" style="display:none">
            <textarea class="notes-textarea" data-idea-id="${i.id}" placeholder="Ваши заметки...">${this.esc(i.notes)}</textarea>
          </div>
        </div>
        <div class="idea-chat" id="chat-${i.id}">
          <div class="chat-toggle" data-chat-id="${i.id}">
            <span class="chat-toggle-icon">▶</span>
            <label>_ Чат с ИИ</label>
            ${hasChat ? '<span class="chat-has-messages"></span>' : ''}
          </div>
          <div class="chat-body" style="display:none">
            <div class="chat-messages" id="chat-messages-${i.id}"></div>
            <div class="chat-input-row">
              <textarea class="chat-input" data-chat-id="${i.id}" placeholder="Задайте вопрос об этой идее..." rows="1"></textarea>
              <button class="chat-send-btn" data-chat-id="${i.id}" title="Отправить">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
              </button>
            </div>
          </div>
        </div>
        ${i.userTags?.length ? `<div class="idea-tags">${i.userTags.map(t => `<span class="tag">${this.esc(t)}</span>`).join('')}</div>` : ''}
        <div class="idea-card-footer">
          <button class="btn-delete-idea" data-idea-id="${i.id}" title="Удалить идею">x Удалить</button>
        </div>
      </div>`;
  }

  private bind(): void {
    const rerender = () => this.render();
    document.getElementById('filter-fam')?.addEventListener('change', (e) => { this.filters.familiarity = (e.target as HTMLSelectElement).value as typeof this.filters.familiarity; rerender(); });
    document.getElementById('filter-stat')?.addEventListener('change', (e) => { this.filters.status = (e.target as HTMLSelectElement).value as typeof this.filters.status; rerender(); });
    document.getElementById('filter-type')?.addEventListener('change', (e) => { this.filters.type = (e.target as HTMLSelectElement).value as typeof this.filters.type; rerender(); });
    document.getElementById('filter-chapter')?.addEventListener('change', (e) => { this.filters.chapter = (e.target as HTMLSelectElement).value; rerender(); });

    // Star rating — click to set importance
    this.container.querySelectorAll('.idea-star-rating').forEach(rating => {
      const stars = rating.querySelectorAll('.star-btn');
      const handleStar = async (target: HTMLElement) => {
        const val = parseInt(target.dataset.star || '0', 10);
        if (val < 1 || val > 5) return;
        const ideaId = (rating as HTMLElement).dataset.ideaId;
        if (!ideaId) return;
        await db.ideas.update(ideaId, { importance: val as Idea['importance'] });
        rerender();
      };
      stars.forEach(star => {
        star.addEventListener('click', () => handleStar(star as HTMLElement));
        // Hover preview
        star.addEventListener('mouseenter', () => {
          const val = parseInt((star as HTMLElement).dataset.star || '0', 10);
          stars.forEach(s => {
            const sv = parseInt((s as HTMLElement).dataset.star || '0', 10);
            s.classList.toggle('star-hover', sv <= val);
          });
        });
      });
      rating.addEventListener('mouseleave', () => {
        stars.forEach(s => s.classList.remove('star-hover'));
      });
    });

    this.container.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn.closest('.idea-card') as HTMLElement | null)?.dataset?.ideaId;
        const field = (btn as HTMLElement).dataset.field;
        const val = (btn as HTMLElement).dataset.value;
        if (id && field && val) { await db.ideas.update(id, { [field]: val } as any); rerender(); }
      });
    });

    this.container.querySelectorAll('.notes-textarea').forEach(ta => {
      let timer: ReturnType<typeof setTimeout>;
      // Prevent any parent keydown handler from eating space/keys in textarea
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation();
      });
      ta.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const id = (ta as HTMLElement).dataset.ideaId;
          if (id) await db.ideas.update(id, { notes: (ta as HTMLTextAreaElement).value });
        }, 500);
      });
    });

    // Notes toggle — expand/collapse notes editor
    this.container.querySelectorAll('.notes-toggle').forEach(toggle => {
      toggle.addEventListener('click', () => {
        const notesId = (toggle as HTMLElement).dataset.notesId;
        const notesEl = document.getElementById(`notes-${notesId}`);
        if (!notesEl) return;
        const body = notesEl.querySelector('.notes-body') as HTMLElement | null;
        const icon = notesEl.querySelector('.notes-toggle-icon');
        if (!body) return;
        const isVisible = body.style.display !== 'none';
        body.style.display = isVisible ? 'none' : 'block';
        if (icon) icon.textContent = isVisible ? '▶' : '▼';
      });
    });

    // Chat toggle — expand/collapse chat panel
    this.container.querySelectorAll('.chat-toggle').forEach(toggle => {
      toggle.addEventListener('click', () => {
        const chatId = (toggle as HTMLElement).dataset.chatId;
        const chatEl = document.getElementById(`chat-${chatId}`);
        if (!chatEl) return;
        const body = chatEl.querySelector('.chat-body') as HTMLElement | null;
        const icon = chatEl.querySelector('.chat-toggle-icon');
        if (!body) return;
        const isVisible = body.style.display !== 'none';
        body.style.display = isVisible ? 'none' : 'block';
        if (icon) icon.textContent = isVisible ? '▶' : '▼';
        // When opening, restore messages and focus input
        if (!isVisible) {
          this.restoreChatMessages(chatId!);
          const input = body.querySelector('.chat-input') as HTMLTextAreaElement | null;
          if (input) input.focus();
        }
      });
    });

    // Chat input — Enter to send, Shift+Enter for newline
    this.container.querySelectorAll<HTMLTextAreaElement>('.chat-input').forEach(input => {
      input.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const chatId = (input as HTMLElement).dataset.chatId;
          if (chatId) this.sendChatMessage(chatId);
        }
      });
    });

    // Chat send button
    this.container.querySelectorAll('.chat-send-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const chatId = (btn as HTMLElement).dataset.chatId;
        if (chatId) this.sendChatMessage(chatId);
      });
    });

    document.getElementById('btn-analyze')?.addEventListener('click', () => {
      new AnalysisPanel(this.container, this.bookId).render();
    });

    // Zathura buttons — launch via Native Messaging Host or fallback to clipboard
    this.container.querySelectorAll('.btn-zathura').forEach(btn => {
      btn.addEventListener('click', async () => {
        const page = parseInt((btn as HTMLElement).dataset.page || '0', 10);
        const quote = (btn as HTMLElement).dataset.quote || '';
        if (!page || !this.bookFilePath) return;

        const original = btn.textContent;
        btn.textContent = '... Открываю...';
        btn.classList.add('btn-zathura-loading');

        const result = await openInZathura(this.bookFilePath, page, quote || undefined);

        if (result.launched) {
          btn.textContent = '[ok]';
          if (result.searchHint) {
            // Show search hint as a tooltip-like element
            showZathuraHint(btn, result.searchHint);
          }
        } else {
          btn.textContent = '[копия]';
          if (result.error) {
            showZathuraHint(btn, result.error);
          }
        }

        btn.classList.remove('btn-zathura-loading');
        setTimeout(() => { btn.textContent = original; }, 2500);
      });
    });

    // Context buttons — load and show page text from pageCache
    this.container.querySelectorAll('.btn-context').forEach(btn => {
      btn.addEventListener('click', async () => {
        const el = btn as HTMLElement;
        const pages = (el.dataset.pages || '').split(',').map(Number).filter(Boolean);
        const bookId = el.dataset.bookId;
        const ideaId = el.dataset.ideaId;
        if (!pages.length || !bookId || !ideaId) return;

        const container = document.getElementById(`context-${ideaId}`);
        if (!container) return;

        // Toggle: if already shown, hide
        if (container.classList.contains('context-visible')) {
          container.innerHTML = '';
          container.classList.remove('context-visible');
          el.textContent = '▽ Контекст';
          return;
        }

        el.textContent = '... Загрузка...';
        el.classList.add('btn-zathura-loading');

        try {
          const pageTexts: Array<{ page: number; text: string; source: string }> = [];
          for (const p of pages) {
            const cached = await db.pageCache.where({ bookId, pageNumber: p }).first();
            if (!cached) continue;
            // Prefer OCR markdown (OCR mode) over raw text layer.
            // Raw text layer is only useful if it has a good quality score (TEXT mode).
            if (cached.ocrMarkdown) {
              pageTexts.push({ page: p, text: cached.ocrMarkdown, source: 'OCR' });
            } else if (cached.hasTextLayer && (cached.qualityScore ?? 0) >= 0.3) {
              pageTexts.push({ page: p, text: cached.text, source: 'текстовый слой' });
            }
          }

          if (pageTexts.length === 0) {
            container.innerHTML = `<div class="context-empty">Текст страниц недоступен. Для OCR/VLM режимов контекст сохраняется автоматически. Для текстового режима запустите анализ заново.</div>`;
          } else {
            container.innerHTML = pageTexts.map(pt => `
              <details class="context-section" open>
                <summary class="context-summary">Страница ${pt.page} <span class="context-source">(${pt.source})</span></summary>
                <pre class="context-text">${this.renderMarkdown(pt.text, false)}</pre>
              </details>
            `).join('');
          }
          container.classList.add('context-visible');
          el.textContent = '▽ Скрыть контекст';
        } catch (err) {
          container.innerHTML = `<div class="context-empty">Ошибка загрузки контекста: ${this.esc(String(err))}</div>`;
          container.classList.add('context-visible');
          el.textContent = '▽ Контекст';
        }

        el.classList.remove('btn-zathura-loading');
      });
    });

    // Edit idea buttons — toggle inline editing
    this.container.querySelectorAll('.btn-edit-idea').forEach(btn => {
      btn.addEventListener('click', () => {
        const ideaId = (btn as HTMLElement).dataset.ideaId;
        if (!ideaId) return;
        const card = btn.closest('.idea-card') as HTMLElement | null;
        if (!card) return;
        this.toggleEditMode(card, ideaId, true);
      });
    });

    // Save edit buttons
    this.container.querySelectorAll('.btn-save-edit').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ideaId = (btn as HTMLElement).dataset.ideaId;
        if (!ideaId) return;
        const card = btn.closest('.idea-card') as HTMLElement | null;
        if (!card) return;
        await this.saveEdit(card, ideaId);
        this.toggleEditMode(card, ideaId, false);
      });
    });

    // Cancel edit buttons
    this.container.querySelectorAll('.btn-cancel-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const ideaId = (btn as HTMLElement).dataset.ideaId;
        if (!ideaId) return;
        const card = btn.closest('.idea-card') as HTMLElement | null;
        if (!card) return;
        // Restore original content from data attributes
        this.cancelEdit(card, ideaId);
        this.toggleEditMode(card, ideaId, false);
      });
    });

    // Delete idea buttons
    this.container.querySelectorAll('.btn-delete-idea').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.ideaId;
        if (!id) return;

        // Highlight the card to confirm
        const card = btn.closest('.idea-card') as HTMLElement | null;
        if (!card) return;

        if (card.dataset.deleteConfirm === 'true') {
          // Second click — confirmed
          await db.ideas.delete(id);
          // Clean up relations pointing to deleted idea from other ideas
          const remaining = await db.ideas.where('bookId').equals(this.bookId).toArray();
          const updates = remaining.filter(i =>
            i.relations.some(r => r.targetId === id)
          );
          for (const idea of updates) {
            await db.ideas.update(idea.id, {
              relations: idea.relations.filter(r => r.targetId !== id),
            });
          }
          rerender();
        } else {
          // First click — ask for confirmation
          card.dataset.deleteConfirm = 'true';
          btn.textContent = 'x Точно удалить?';
          btn.classList.add('delete-confirm');
          setTimeout(() => {
            if (card.dataset.deleteConfirm === 'true') {
              card.dataset.deleteConfirm = '';
              btn.textContent = 'x Удалить';
              btn.classList.remove('delete-confirm');
            }
          }, 3000);
        }
      });
    });

    // Listen for analysis completion — re-render ideas
    document.addEventListener('ideas-updated', rerender, { once: true });
  }

  private applyFilters(ideas: Idea[], tocPaths: Map<string, TOCEntry[]>): Idea[] {
    // Build a set of selected TOC entry IDs (selected + all descendants)
    const selectedTocIds = this.getSelectedTocIds();
    return ideas.filter(i => {
      if (this.filters.familiarity !== 'all' && i.familiarity !== this.filters.familiarity) return false;
      if (this.filters.status !== 'all' && i.status !== this.filters.status) return false;
      if (this.filters.type !== 'all' && i.type !== this.filters.type) return false;
      if (selectedTocIds.size > 0) {
        // Match if ANY entry in the idea's TOC path is in the selected set
        const path = tocPaths.get(i.id);
        if (!path || !path.some(e => selectedTocIds.has(e.id))) return false;
      }
      return true;
    });
  }

  /**
   * When a TOC section is selected, include it AND all its descendant sections
   * so filtering by a chapter also shows ideas in its sub-sections.
   */
  private getSelectedTocIds(): Set<string> {
    if (this.filters.chapter === 'all') return new Set();
    const ids = new Set<string>();
    const addDescendants = (parentId: string) => {
      ids.add(parentId);
      for (const e of this.tocEntries) {
        if (e.parentId === parentId) addDescendants(e.id);
      }
    };
    addDescendants(this.filters.chapter);
    return ids;
  }

  /**
   * For each idea, find the most specific TOC entry (deepest level) whose
   * page range contains the idea's first book-page, then build the full
   * path from root chapter down to that entry.
   */
  private buildTocPaths(ideas: Idea[], toc: TOCEntry[], pageOffset: number): Map<string, TOCEntry[]> {
    const paths = new Map<string, TOCEntry[]>();
    if (toc.length === 0) return paths;

    // Build parent lookup for path reconstruction
    const byId = new Map<string, TOCEntry>();
    for (const e of toc) byId.set(e.id, e);

    function getPath(entry: TOCEntry): TOCEntry[] {
      const path: TOCEntry[] = [];
      let cur: TOCEntry | undefined = entry;
      while (cur) {
        path.unshift(cur);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return path;
    }

    for (const idea of ideas) {
      const bookPage = (idea.pages[0] || 1) - pageOffset;
      let best: TOCEntry | undefined;
      for (const entry of toc) {
        if (
          entry.pageEnd !== undefined &&
          bookPage >= entry.page &&
          bookPage <= entry.pageEnd
        ) {
          if (!best || entry.level > best.level) {
            best = entry;
          }
        }
      }
      if (best) {
        paths.set(idea.id, getPath(best));
      }
    }

    return paths;
  }

  /**
   * Restore previously rendered chat messages when chat panel is opened.
   * Loads from DB on first open, then uses in-memory cache.
   */
  private async restoreChatMessages(ideaId: string): Promise<void> {
    const messagesEl = document.getElementById(`chat-messages-${ideaId}`);
    if (!messagesEl) return;

    // Load from DB on first access
    if (!this.chatLoaded.has(ideaId)) {
      this.chatLoaded.add(ideaId);
      const saved = await loadIdeaChat(ideaId);
      if (saved.length > 0) {
        this.chatHistories.set(ideaId, saved);
      }
    }

    const history = this.chatHistories.get(ideaId);
    if (!history || history.length === 0) {
      messagesEl.innerHTML = '<div class="chat-empty">Задайте вопрос об этой идее. Контекст идеи и страницы книги будет отправлен автоматически.</div>';
      return;
    }
    messagesEl.innerHTML = history.map(m =>
      `<div class="chat-msg chat-msg-${m.role}">${m.role === 'user' ? this.renderMarkdown(m.content, true) : this.renderMarkdown(m.content, false)}</div>`
    ).join('');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /**
   * Build a system prompt containing the idea's content and page context.
   * Cached per idea to avoid re-reading pageCache on every message.
   */
  private async buildSystemPrompt(idea: Idea): Promise<string> {
    const cached = this.chatSystemPrompts.get(idea.id);
    if (cached) return cached;

    // Gather page context texts
    const pageTexts: string[] = [];
    for (const p of idea.pages) {
      const entry = await db.pageCache.where({ bookId: this.bookId, pageNumber: p }).first();
      if (!entry) continue;
      if (entry.ocrMarkdown) {
        pageTexts.push(`--- Страница ${p} (OCR) ---\n${entry.ocrMarkdown}`);
      } else if (entry.hasTextLayer && (entry.qualityScore ?? 0) >= 0.3) {
        pageTexts.push(`--- Страница ${p} (текстовый слой) ---\n${entry.text}`);
      }
    }

    let prompt = `Ты — помощник по изучению учебного материала. Отвечай на вопросы пользователя об конкретной идее из книги.\n\n`;
    prompt += `=== ИДЕЯ ===\n`;
    prompt += `Заголовок: ${idea.title}\n`;
    prompt += `Тип: ${idea.type}\n`;
    prompt += `Глубина: ${idea.depth}\n`;
    prompt += `Суть: ${idea.summary}\n`;
    if (idea.quote) prompt += `Цитата: ${idea.quote}\n`;
    prompt += `Страницы: ${idea.pages.join(', ')}\n`;
    if (idea.relations.length > 0) prompt += `Связи: ${idea.relations.length} шт.\n`;

    if (pageTexts.length > 0) {
      prompt += `\n=== КОНТЕКСТ СТРАНИЦ ===\n`;
      prompt += pageTexts.join('\n\n');
    }

    prompt += `\n\nИнструкции:\n`;
    prompt += `- Отвечай на русском языке\n`;
    prompt += `- Используй формулы LaTeX: строчные $...$ и блочные $$...$$\n`;
    prompt += `- Если в тексте есть формулы LaTeX, сохраняй их в ответах\n`;
    prompt += `- Будь лаконичным но информативным\n`;
    prompt += `- Если вопрос не связан с идеей, мягко направь к теме`;

    this.chatSystemPrompts.set(idea.id, prompt);
    return prompt;
  }

  /**
   * Send user's question to LLM with idea context + chat history.
   */
  private async sendChatMessage(ideaId: string): Promise<void> {
    const chatEl = document.getElementById(`chat-${ideaId}`);
    if (!chatEl) return;
    const messagesEl = document.getElementById(`chat-messages-${ideaId}`);
    const input = chatEl.querySelector('.chat-input') as HTMLTextAreaElement | null;
    if (!messagesEl || !input) return;

    const userText = input.value.trim();
    if (!userText) return;

    // Get settings and create provider
    let settings: Awaited<ReturnType<typeof getSettings>>;
    try {
      settings = await getSettings();
    } catch {
      this.appendChatMsg(messagesEl, 'system', 'Ошибка: не удалось загрузить настройки. Проверьте API ключ в настройках.');
      return;
    }
    const apiKey = settings.providerKeys[settings.activeProvider];
    if (!apiKey) {
      this.appendChatMsg(messagesEl, 'system', `API ключ для "${settings.activeProvider}" не настроен. Откройте настройки.`);
      return;
    }

    // Initialize history if needed
    if (!this.chatHistories.has(ideaId)) {
      this.chatHistories.set(ideaId, []);
    }
    const history = this.chatHistories.get(ideaId)!;

    // Clear placeholder if present
    const emptyEl = messagesEl.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();

    // Show user message
    history.push({ role: 'user', content: userText, timestamp: Date.now() });
    this.appendChatMsg(messagesEl, 'user', userText);
    input.value = '';
    input.style.height = 'auto';

    // Show loading indicator
    const loadingEl = document.createElement('div');
    loadingEl.className = 'chat-msg chat-msg-assistant chat-loading';
    loadingEl.innerHTML = '<span class="chat-loading-dots"><span>.</span><span>.</span><span>.</span></span>';
    messagesEl.appendChild(loadingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Disable input while processing
    input.disabled = true;
    const sendBtn = chatEl.querySelector('.chat-send-btn');
    if (sendBtn) (sendBtn as HTMLElement).style.pointerEvents = 'none';

    try {
      // Build system prompt (cached)
      const idea = await db.ideas.get(ideaId);
      if (!idea) throw new Error('Идея не найдена');
      const systemPrompt = await this.buildSystemPrompt(idea);

      // Create provider
      const provider = createProvider(settings.activeProvider, apiKey, { zaiBaseUrl: settings.zaiBaseUrl });
      const fallbackModels = parseFallbackModels(settings.fallbackModels);

      // Build messages array: system + history (map to ChatMessage format for LLM)
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content })),
      ];

      const response = await provider.chat(messages, {
        model: settings.activeModel,
        fallbackModels,
        retriesPerModel: 1,
      });

      // Store and render assistant response
      history.push({ role: 'assistant', content: response.content, timestamp: Date.now() });
      // Persist to DB
      await saveIdeaChat(ideaId, [...history]);
    } catch (err) {
      const errMsg = String(err);
      // Remove last user message from history on error so user can retry
      history.pop();
      this.appendChatMsg(messagesEl, 'system', `Ошибка: ${this.esc(errMsg.length > 200 ? errMsg.slice(0, 200) + '...' : errMsg)}`);
    } finally {
      // Remove loading indicator
      loadingEl.remove();
      // Render the last assistant response (if successful)
      const lastMsg = history[history.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        this.appendChatMsg(messagesEl, 'assistant', lastMsg.content);
      }
      input.disabled = false;
      if (sendBtn) (sendBtn as HTMLElement).style.pointerEvents = '';
      input.focus();

      // Update message indicator on toggle
      const indicator = chatEl.querySelector('.chat-has-messages');
      if (!indicator && history.length > 0) {
        const toggleIcon = chatEl.querySelector('.chat-toggle-icon');
        const dot = document.createElement('span');
        dot.className = 'chat-has-messages';
        toggleIcon?.parentElement?.appendChild(dot);
      }
    }
  }

  /**
   * Append a message to the chat messages container.
   */
  private appendChatMsg(container: HTMLElement, role: 'user' | 'assistant' | 'system', content: string): void {
    const div = document.createElement('div');
    div.className = `chat-msg chat-msg-${role}`;
    div.innerHTML = role === 'user' ? this.renderMarkdown(content, true) : this.renderMarkdown(content, false);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  private esc(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  /** Unique token counter for protecting math from markdown parser */
  private mathTokenCounter = 0;

  /**
   * Render text with Markdown + KaTeX math formulas.
   * For user messages, plain text is escaped and light markdown applied.
   * For assistant messages, full markdown rendering with math support.
   *
   * Supports: $$block$$, $inline$, \(inline\) math delimiters.
   * Markdown: bold, italic, code, code blocks, lists, headings, links.
   */
  private renderMarkdown(text: string, plain: boolean): string {
    if (!text) return '';
    const tokens = new Map<string, string>();
    this.mathTokenCounter = 0;

    // Step 1: extract and protect math formulas, replace with tokens
    let result = text;

    // Block math $$...$$
    result = result.replace(/\$\$([\s\S]+?)\$\$/g, (_, latex) => {
      const token = `%%MATH_BLOCK_${this.mathTokenCounter++}%%`;
      try {
        tokens.set(token, katex.renderToString(latex.trim(), { displayMode: true, throwOnError: false }));
      } catch {
        tokens.set(token, `<code>${this.esc(latex)}</code>`);
      }
      return token;
    });

    // Inline math $...$ (not preceded/followed by $)
    result = result.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)(?<!\$)\$(?!\$)/g, (_, latex) => {
      const token = `%%MATH_INLINE_${this.mathTokenCounter++}%%`;
      try {
        tokens.set(token, katex.renderToString(latex.trim(), { displayMode: false, throwOnError: false }));
      } catch {
        tokens.set(token, `<code>${this.esc(latex)}</code>`);
      }
      return token;
    });

    // \(...\) LaTeX-style inline
    result = result.replace(/\\\((.+?)\\\)/g, (_, latex) => {
      const token = `%%MATH_INLINE_${this.mathTokenCounter++}%%`;
      try {
        tokens.set(token, katex.renderToString(latex.trim(), { displayMode: false, throwOnError: false }));
      } catch {
        tokens.set(token, `<code>${this.esc(latex)}</code>`);
      }
      return token;
    });

    // Step 2: apply markdown
    if (plain) {
      // User messages: light formatting only (newlines → <br>, **bold**, *italic*, `code`)
      result = this.esc(result);
      result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
      result = result.replace(/`([^`]+?)`/g, '<code>$1</code>');
      result = result.replace(/\n/g, '<br>');
    } else {
      // Assistant messages: full marked rendering
      result = marked.parse(result, { async: false, breaks: true }) as string;
    }

    // Step 3: restore math tokens
    for (const [token, html] of tokens) {
      result = result.replace(token, html);
    }

    return result;
  }

  /**
   * Toggle inline editing mode for an idea card.
   * When enabling: replace rendered HTML with textareas pre-filled with raw text.
   * When disabling: restore the rendered view (after save or cancel).
   */
  private toggleEditMode(card: HTMLElement, ideaId: string, enable: boolean): void {
    const fields = card.querySelector('.idea-content-fields') as HTMLElement | null;
    const toolbar = document.getElementById(`edit-toolbar-${ideaId}`);
    const editBtn = card.querySelector('.btn-edit-idea') as HTMLElement | null;
    if (!fields || !toolbar) return;

    if (enable) {
      // Store original raw text in data attributes (for cancel)
      const editables = fields.querySelectorAll('.idea-editable-field');
      editables.forEach(el => {
        const field = (el as HTMLElement).dataset.field;
        const currentText = (el as HTMLElement).dataset.originalText || (el as HTMLElement).textContent || '';
        if (!field) return;
        (el as HTMLElement).dataset.originalText = currentText;
        (el as HTMLElement).dataset.originalHtml = el.innerHTML;

        const isTitle = field === 'title';
        const textarea = document.createElement('textarea');
        textarea.className = `idea-edit-textarea idea-edit-${field}`;
        textarea.value = currentText;
        textarea.dataset.field = field;
        textarea.placeholder = isTitle ? 'Заголовок идеи...' : (field === 'summary' ? 'Описание идеи...' : 'Цитата из книги...');
        // Prevent parent keydown handlers from eating keys
        textarea.addEventListener('keydown', (e) => e.stopPropagation());
        // Ctrl+Enter to save
        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const saveBtn = card.querySelector('.btn-save-edit') as HTMLElement | null;
            if (saveBtn) saveBtn.click();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            const cancelBtn = card.querySelector('.btn-cancel-edit') as HTMLElement | null;
            if (cancelBtn) cancelBtn.click();
          }
        });
        // Auto-resize title textarea
        if (isTitle) {
          textarea.style.minHeight = 'auto';
          textarea.style.height = 'auto';
          textarea.style.height = textarea.scrollHeight + 'px';
          textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
          });
        }

        el.innerHTML = '';
        el.appendChild(textarea);
      });

      toolbar.style.display = 'flex';
      if (editBtn) editBtn.style.display = 'none';
      card.classList.add('editing');
      // Focus first textarea
      const firstTa = fields.querySelector('.idea-edit-textarea') as HTMLTextAreaElement | null;
      if (firstTa) firstTa.focus();
    } else {
      // Will be re-rendered by saveEdit → rerender, or by cancelEdit + rerender
    }
  }

  /**
   * Save edited fields to IndexedDB and re-render the card.
   */
  private async saveEdit(card: HTMLElement, ideaId: string): Promise<void> {
    const fields = card.querySelector('.idea-content-fields') as HTMLElement | null;
    if (!fields) return;

    const updates: Partial<Idea> = {};
    const editables = fields.querySelectorAll('.idea-edit-textarea');
    editables.forEach(ta => {
      const field = (ta as HTMLElement).dataset.field as 'title' | 'summary' | 'quote';
      const value = (ta as HTMLTextAreaElement).value.trim();
      if (field && value) {
        updates[field] = value;
      } else if (field === 'quote' && value === '') {
        updates.quote = undefined;
      }
    });

    if (Object.keys(updates).length > 0) {
      await db.ideas.update(ideaId, updates);
      // Clear cached system prompt since idea content changed
      this.chatSystemPrompts.delete(ideaId);
    }
    this.render();
  }

  /**
   * Cancel editing — restore original content and re-render.
   */
  private cancelEdit(card: HTMLElement, ideaId: string): void {
    // Simply re-render to restore original state
    this.render();
  }

  /** Escape for HTML attribute values (single-quote safe) */
  private escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

/**
 * Show a brief floating hint near the zathura button.
 * Auto-removes after 4 seconds.
 */
function showZathuraHint(anchor: Element, message: string): void {
  // Remove any existing hint
  const existing = anchor.parentElement?.querySelector('.zathura-popup-hint');
  if (existing) existing.remove();

  const hint = document.createElement('div');
  hint.className = 'zathura-popup-hint';
  hint.textContent = message;
  anchor.parentElement?.appendChild(hint);

  setTimeout(() => {
    hint.style.opacity = '0';
    hint.style.transform = 'translateY(4px)';
    setTimeout(() => hint.remove(), 300);
  }, 4000);
}
