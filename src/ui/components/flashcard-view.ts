// ============================================================
// Flashcard View — full-screen idea review mode
// ============================================================

import { db, getSettings, loadIdeaChat, saveIdeaChat } from '../../db/index.js';
import type { Idea, Familiarity, IdeaStatus, TOCEntry, IdeaChatMessage } from '../../db/schema.js';
import type { ChatMessage } from '../../background/ai-client.js';
import { createProvider, parseFallbackModels } from '../../background/ai-client.js';
import { openInZathura, isNativeHostAvailable } from '../utils/native-messaging.js';
import katex from 'katex';
import { marked } from 'marked';
import '../styles/components/flashcard.css';
import 'katex/dist/katex.min.css';

const TYPE_ICONS: Record<string, string> = {
  definition: '', method: '\\', theorem: '/',
  insight: '✦', example: '_', analogy: '↻',
};
const TYPE_LABELS: Record<string, string> = {
  definition: 'Определение', method: 'Метод', theorem: 'Теорема',
  insight: 'Инсайт', example: 'Пример', analogy: 'Аналогия',
};
const DEPTH_LABELS: Record<string, string> = { basic: 'Базовый', medium: 'Средний', advanced: 'Продвинутый' };
const FAM_LABELS: Record<Familiarity, string> = { unknown: 'Не изучал', heard: 'Слышал', known: 'Знаю', new: 'Новая' };
const STAT_LABELS: Record<IdeaStatus, string> = {
  unseen: 'Не изучал', in_progress: 'В процессе', mastered: 'Освоено', applied: 'Применяю', confused: 'Не понятно',
};
const STAT_COLORS: Record<IdeaStatus, string> = {
  unseen: '#6B7280', in_progress: '#D97706', mastered: '#059669',
  applied: '#2563EB', confused: '#DC2626',
};

export interface FlashcardOptions {
  bookId: string;
  /** Pre-selected filters from idea-list page */
  filterStatus?: IdeaStatus | 'all';
  filterChapter?: string;
  filterFamiliarity?: Familiarity | 'all';
  filterType?: Idea['type'] | 'all';
}

export class FlashcardView {
  private container: HTMLElement;
  private bookId: string;
  private bookFilePath?: string;
  private options: FlashcardOptions;
  private ideas: Idea[] = [];
  private currentIndex = 0;
  private totalCount = 0;
  private reviewedCount = 0;
  private tocEntries: TOCEntry[] = [];
  private pageOffset = 0;

  /** Chat state */
  private chatHistories = new Map<string, IdeaChatMessage[]>();
  private chatLoaded = new Set<string>();
  private chatSystemPrompts = new Map<string, string>();

  constructor(container: HTMLElement, options: FlashcardOptions) {
    this.container = container;
    this.bookId = options.bookId;
    this.options = options;
  }

  async render(): Promise<void> {
    const book = await db.books.get(this.bookId);
    if (!book) return;
    this.bookFilePath = book.filePath;
    this.pageOffset = book.pageOffset || 0;
    this.tocEntries = book.tableOfContents || [];

    // Fetch all ideas and apply filters
    const allIdeas = await db.ideas.where('bookId').equals(this.bookId).toArray();
    this.ideas = this.applyFilters(allIdeas);
    this.totalCount = this.ideas.length;

    if (this.ideas.length === 0) {
      this.renderEmpty();
      return;
    }

    this.renderSetup();
  }

  // ─── Filter selection screen ─────────────────────────────

  private renderSetup(): void {
    this.container.innerHTML = `
      <div class="flashcard-setup">
        <div class="flashcard-setup-card">
          <div class="flashcard-setup-header">
            <button class="flashcard-back-btn" id="fc-back">← Назад к идеям</button>
            <h2>✦ Режим карточек</h2>
            <div class="flashcard-count-badge">${this.totalCount} ${this.pluralize(this.totalCount, 'идея', 'идеи', 'идей')}</div>
          </div>
          <p class="flashcard-setup-desc">Выберите фильтр для отбора идей. Карточки будут показаны последовательно, нажимайте кнопку статуса для перехода к следующей.</p>

          <div class="flashcard-filters">
            <div class="fc-filter-group">
              <label class="fc-filter-label">Статус освоения</label>
              <select id="fc-filter-status" class="filter-select fc-filter-select">
                <option value="all">Все статусы</option>
                <option value="unseen">Не изучал</option>
                <option value="in_progress">В процессе</option>
                <option value="mastered">Освоено</option>
                <option value="applied">Применяю</option>
                <option value="confused">Не понятно</option>
              </select>
            </div>
            <div class="fc-filter-group">
              <label class="fc-filter-label">Раздел (ТОС)</label>
              <select id="fc-filter-chapter" class="filter-select fc-filter-select">
                <option value="all">Все разделы</option>
                ${this.tocEntries.map(e => {
                  const indent = '  '.repeat(e.level - 1);
                  const prefix = e.level === 1 ? '' : (e.level === 2 ? '└ ' : '└ ');
                  return `<option value="${e.id}">${indent}${prefix}${this.esc(e.title)}</option>`;
                }).join('')}
              </select>
            </div>
          </div>

          <div class="flashcard-preview">
            <span class="fc-preview-count" id="fc-preview-count">${this.totalCount} ${this.pluralize(this.totalCount, 'идея', 'идеи', 'идей')} будет показано</span>
          </div>

          <button class="primary-btn flashcard-start-btn" id="fc-start">▶ Начать</button>
        </div>
      </div>`;

    this.bindSetupEvents();
  }

  private bindSetupEvents(): void {
    // Pre-select filters from options
    const statusSelect = document.getElementById('fc-filter-status') as HTMLSelectElement | null;
    const chapterSelect = document.getElementById('fc-filter-chapter') as HTMLSelectElement | null;
    if (statusSelect && this.options.filterStatus) statusSelect.value = this.options.filterStatus;
    if (chapterSelect && this.options.filterChapter) chapterSelect.value = this.options.filterChapter;

    const updatePreview = async () => {
      const allIdeas = await db.ideas.where('bookId').equals(this.bookId).toArray();
      this.ideas = this.applyFilters(allIdeas);
      this.totalCount = this.ideas.length;
      const preview = document.getElementById('fc-preview-count');
      if (preview) {
        preview.textContent = this.totalCount > 0
          ? `${this.totalCount} ${this.pluralize(this.totalCount, 'идея', 'идеи', 'идей')} будет показано`
          : 'Нет идей по выбранному фильтру';
        preview.classList.toggle('fc-preview-empty', this.totalCount === 0);
      }
    };

    statusSelect?.addEventListener('change', () => {
      this.options.filterStatus = statusSelect.value as IdeaStatus | 'all';
      updatePreview();
    });
    chapterSelect?.addEventListener('change', () => {
      this.options.filterChapter = chapterSelect.value;
      updatePreview();
    });

    document.getElementById('fc-back')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'ideas' } }));
    });

    document.getElementById('fc-start')?.addEventListener('click', () => {
      if (this.ideas.length === 0) return;
      this.currentIndex = 0;
      this.reviewedCount = 0;
      this.renderCard();
    });
  }

  // ─── Flashcard display ──────────────────────────────────

  private renderCard(): void {
    const idea = this.ideas[this.currentIndex];
    if (!idea) return;

    const progress = this.totalCount > 0 ? Math.round((this.reviewedCount / this.totalCount) * 100) : 0;
    const tocPath = this.buildTocPath(idea);
    const statusColors: Record<string, string> = {
      unseen: 'status-unseen', in_progress: 'status-progress', mastered: 'status-mastered',
      applied: 'status-applied', confused: 'status-confused',
    };
    const cardStatusClass = statusColors[idea.status] || '';

    this.container.innerHTML = `
      <div class="flashcard-view">
        <!-- Top bar -->
        <div class="flashcard-topbar">
          <button class="flashcard-back-btn" id="fc-back">← Выход</button>
          <div class="flashcard-progress-wrap">
            <div class="flashcard-progress-bar">
              <div class="flashcard-progress-fill" style="width: ${progress}%"></div>
            </div>
            <span class="flashcard-progress-text">${this.reviewedCount} / ${this.totalCount}</span>
          </div>
          <span class="flashcard-counter">${this.currentIndex + 1} / ${this.totalCount}</span>
        </div>

        <!-- Card -->
        <div class="flashcard-card ${cardStatusClass}" id="fc-card">
          <div class="fc-card-header">
            <span class="fc-type-badge fc-type-${idea.type}">${TYPE_ICONS[idea.type] || '◇'} ${TYPE_LABELS[idea.type] || idea.type}</span>
            <span class="fc-depth-badge depth-${idea.depth}">${DEPTH_LABELS[idea.depth]}</span>
            <div class="fc-stars" id="fc-stars">
              ${[1,2,3,4,5].map(s => `<span class="fc-star${s <= idea.importance ? ' fc-star-filled' : ''}" data-star="${s}">&#9733;</span>`).join('')}
            </div>
          </div>

          ${tocPath ? `<div class="fc-toc-path">${tocPath}</div>` : ''}

          <h2 class="fc-title">${this.renderMarkdown(idea.title.trim(), false)}</h2>
          <div class="fc-summary">${this.renderMarkdown(idea.summary, false)}</div>

          ${idea.quote ? `<blockquote class="fc-quote">${this.renderMarkdown(idea.quote, false)}</blockquote>` : ''}

          ${idea.relations.length ? `<div class="fc-relations"><span class="fc-rel-badge">${idea.relations.length} связей</span></div>` : ''}

          <!-- Meta actions -->
          <div class="fc-meta-row">
            <span class="fc-pages">стр. ${idea.pages.join(', ')}</span>
            <button class="btn-context fc-btn" id="fc-context" title="Показать контекст страниц">▽ Контекст</button>
            ${this.bookFilePath ? idea.pages.map((p, idx) => `
              <button class="btn-zathura fc-btn" data-page="${p}" data-quote="${this.escAttr(idea.quote || '')}" title="Открыть в zathura на стр. ${p}">
                ▸ zathura${idx === 0 && idea.quote ? ' + поиск' : ''}
              </button>
            `).join('') : ''}
          </div>
          <div class="fc-context-container" id="fc-context-body"></div>

          <!-- Notes -->
          <div class="fc-notes-section" id="fc-notes-section">
            <div class="fc-section-toggle" id="fc-notes-toggle">
              <span class="fc-toggle-icon">▶</span>
              <label>_ Заметки</label>
              ${idea.notes ? '<span class="fc-has-content"></span>' : ''}
            </div>
            <div class="fc-section-body" id="fc-notes-body" style="display:none">
              <textarea class="notes-textarea fc-notes-textarea" placeholder="Ваши заметки...">${this.esc(idea.notes)}</textarea>
            </div>
          </div>

          <!-- Chat -->
          <div class="fc-chat-section" id="fc-chat-section">
            <div class="fc-section-toggle" id="fc-chat-toggle">
              <span class="fc-toggle-icon">▶</span>
              <label>_ Чат с ИИ</label>
            </div>
            <div class="fc-section-body" id="fc-chat-body" style="display:none">
              <div class="chat-messages" id="fc-chat-messages"></div>
              <div class="chat-input-row">
                <textarea class="chat-input" id="fc-chat-input" placeholder="Задайте вопрос об этой идее..." rows="1"></textarea>
                <button class="chat-send-btn" id="fc-chat-send" title="Отправить">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Status buttons -->
        <div class="flashcard-actions">
          ${(['unseen','in_progress','mastered','applied','confused'] as IdeaStatus[]).map(s => `
            <button class="fc-action-btn fc-action-${s}" data-status="${s}"
              ${idea.status === s ? 'disabled' : ''}
              title="${STAT_LABELS[s]}">
              <span class="fc-action-dot" style="background: ${STAT_COLORS[s]}"></span>
              ${STAT_LABELS[s]}
            </button>
          `).join('')}
        </div>

        <!-- Navigation -->
        <div class="flashcard-nav">
          <button class="fc-nav-btn" id="fc-prev" ${this.currentIndex === 0 ? 'disabled' : ''}>← Предыдущая</button>
          <button class="fc-nav-btn" id="fc-next" ${this.currentIndex >= this.ideas.length - 1 ? 'disabled' : ''}>Следующая →</button>
        </div>
      </div>`;

    this.bindCardEvents(idea);
  }

  private bindCardEvents(idea: Idea): void {
    // Back button
    document.getElementById('fc-back')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'ideas' } }));
    });

    // Status buttons — set status and advance
    this.container.querySelectorAll('.fc-action-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const status = (btn as HTMLElement).dataset.status as IdeaStatus;
        if (!status || status === idea.status) return;

        await db.ideas.update(idea.id, { status });
        this.reviewedCount++;
        idea.status = status;

        // Advance to next card
        if (this.currentIndex < this.ideas.length - 1) {
          this.currentIndex++;
          this.renderCard();
        } else {
          // Session complete
          this.renderComplete();
        }
      });
    });

    // Previous / Next navigation
    document.getElementById('fc-prev')?.addEventListener('click', () => {
      if (this.currentIndex > 0) {
        this.currentIndex--;
        this.renderCard();
      }
    });
    document.getElementById('fc-next')?.addEventListener('click', () => {
      if (this.currentIndex < this.ideas.length - 1) {
        this.currentIndex++;
        this.reviewedCount = Math.max(this.reviewedCount, this.currentIndex + 1);
        this.renderCard();
      }
    });

    // Context button
    document.getElementById('fc-context')?.addEventListener('click', () => {
      const ctxBody = document.getElementById('fc-context-body');
      const ctxBtn = document.getElementById('fc-context');
      if (!ctxBody || !ctxBtn) return;

      if (ctxBody.classList.contains('fc-context-visible')) {
        ctxBody.innerHTML = '';
        ctxBody.classList.remove('fc-context-visible');
        ctxBtn.textContent = '▽ Контекст';
        return;
      }

      ctxBtn.textContent = '... Загрузка...';
      this.loadContext(idea, ctxBody, ctxBtn);
    });

    // Zathura buttons
    this.container.querySelectorAll('.btn-zathura').forEach(btn => {
      btn.addEventListener('click', async () => {
        const page = parseInt((btn as HTMLElement).dataset.page || '0', 10);
        const quote = (btn as HTMLElement).dataset.quote || '';
        if (!page || !this.bookFilePath) return;

        const original = btn.textContent;
        btn.textContent = '... Открываю...';
        btn.classList.add('btn-zathura-loading');

        const result = await openInZathura(this.bookFilePath, page, quote || undefined);
        btn.textContent = result.launched ? '[ok]' : '[копия]';
        btn.classList.remove('btn-zathura-loading');
        setTimeout(() => { btn.textContent = original; }, 2500);
      });
    });

    // Notes toggle
    document.getElementById('fc-notes-toggle')?.addEventListener('click', () => {
      this.toggleSection('fc-notes-body', 'fc-notes-toggle');
    });

    // Notes auto-save
    const notesTa = document.querySelector('.fc-notes-textarea') as HTMLTextAreaElement | null;
    if (notesTa) {
      notesTa.addEventListener('keydown', (e) => e.stopPropagation());
      let timer: ReturnType<typeof setTimeout>;
      notesTa.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          await db.ideas.update(idea.id, { notes: notesTa.value });
        }, 500);
      });
    }

    // Chat toggle
    document.getElementById('fc-chat-toggle')?.addEventListener('click', () => {
      const opened = this.toggleSection('fc-chat-body', 'fc-chat-toggle');
      if (opened) {
        this.restoreChatMessages(idea.id);
        const input = document.getElementById('fc-chat-input') as HTMLTextAreaElement | null;
        if (input) input.focus();
      }
    });

    // Chat input
    const chatInput = document.getElementById('fc-chat-input') as HTMLTextAreaElement | null;
    if (chatInput) {
      chatInput.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendChatMessage(idea.id);
        }
      });
    }

    // Chat send button
    document.getElementById('fc-chat-send')?.addEventListener('click', () => {
      this.sendChatMessage(idea.id);
    });
  }

  // ─── Session complete screen ────────────────────────────

  private renderComplete(): void {
    this.container.innerHTML = `
      <div class="flashcard-complete">
        <div class="flashcard-complete-card">
          <div class="fc-complete-icon">✦</div>
          <h2>Сессия завершена!</h2>
          <p class="fc-complete-stats">Просмотрено ${this.reviewedCount} ${this.pluralize(this.reviewedCount, 'идея', 'идеи', 'идей')}</p>
          <div class="fc-complete-actions">
            <button class="primary-btn" id="fc-back-ideas">← К идеям</button>
            <button class="secondary-btn" id="fc-restart">↻ Начать заново</button>
          </div>
        </div>
      </div>`;

    document.getElementById('fc-back-ideas')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'ideas' } }));
    });
    document.getElementById('fc-restart')?.addEventListener('click', () => {
      this.currentIndex = 0;
      this.reviewedCount = 0;
      this.renderSetup();
    });
  }

  private renderEmpty(): void {
    this.container.innerHTML = `
      <div class="flashcard-complete">
        <div class="flashcard-complete-card">
          <div class="fc-complete-icon">◇</div>
          <h2>Нет идей для карточек</h2>
          <p class="fc-complete-stats">Сначала извлеките идеи из книги нажав «Анализировать».</p>
          <button class="primary-btn" id="fc-back-ideas">← К идеям</button>
        </div>
      </div>`;
    document.getElementById('fc-back-ideas')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'ideas' } }));
    });
  }

  // ─── Filter logic ───────────────────────────────────────

  private applyFilters(allIdeas: Idea[]): Idea[] {
    return allIdeas.filter(i => {
      if (this.options.filterStatus && this.options.filterStatus !== 'all' && i.status !== this.options.filterStatus) return false;
      if (this.options.filterChapter && this.options.filterChapter !== 'all') {
        const selectedIds = this.getDescendantIds(this.options.filterChapter);
        const chapterId = i.chapterId;
        if (!chapterId || !selectedIds.has(chapterId)) return false;
      }
      return true;
    });
  }

  private getDescendantIds(parentId: string): Set<string> {
    const ids = new Set<string>();
    const add = (pid: string) => {
      ids.add(pid);
      for (const e of this.tocEntries) {
        if (e.parentId === pid) add(e.id);
      }
    };
    add(parentId);
    return ids;
  }

  private buildTocPath(idea: Idea): string {
    const byId = new Map<string, TOCEntry>();
    for (const e of this.tocEntries) byId.set(e.id, e);

    // Find matching entry for idea's chapterId or by page range
    let match: TOCEntry | undefined;
    if (idea.chapterId) {
      match = byId.get(idea.chapterId);
    }
    if (!match) {
      const bookPage = (idea.pages[0] || 1) - this.pageOffset;
      for (const e of this.tocEntries) {
        if (e.pageEnd !== undefined && bookPage >= e.page && bookPage <= e.pageEnd) {
          if (!match || e.level > match.level) match = e;
        }
      }
    }
    if (!match) return '';

    // Build path from root
    const path: TOCEntry[] = [];
    let cur: TOCEntry | undefined = match;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path.map(e => `<span class="toc-path-segment toc-path-level-${e.level}">${this.esc(e.title)}</span>`).join(' <span class="toc-path-sep">/</span> ');
  }

  // ─── Context loading ────────────────────────────────────

  private async loadContext(idea: Idea, container: HTMLElement, btn: HTMLElement): Promise<void> {
    const pageTexts: Array<{ page: number; text: string; source: string }> = [];
    for (const p of idea.pages) {
      const cached = await db.pageCache.where({ bookId: this.bookId, pageNumber: p }).first();
      if (!cached) continue;
      if (cached.ocrMarkdown) {
        pageTexts.push({ page: p, text: cached.ocrMarkdown, source: 'OCR' });
      } else if (cached.hasTextLayer && (cached.qualityScore ?? 0) >= 0.3) {
        pageTexts.push({ page: p, text: cached.text, source: 'текстовый слой' });
      }
    }

    if (pageTexts.length === 0) {
      container.innerHTML = `<div class="context-empty">Текст страниц недоступен.</div>`;
    } else {
      container.innerHTML = pageTexts.map(pt => `
        <details class="context-section" open>
          <summary class="context-summary">Страница ${pt.page} <span class="context-source">(${pt.source})</span></summary>
          <pre class="context-text">${this.renderMarkdown(pt.text, false)}</pre>
        </details>
      `).join('');
    }
    container.classList.add('fc-context-visible');
    btn.textContent = '▽ Скрыть контекст';
    btn.classList.remove('btn-zathura-loading');
  }

  // ─── Chat ───────────────────────────────────────────────

  private async restoreChatMessages(ideaId: string): Promise<void> {
    const messagesEl = document.getElementById('fc-chat-messages');
    if (!messagesEl) return;

    if (!this.chatLoaded.has(ideaId)) {
      this.chatLoaded.add(ideaId);
      const saved = await loadIdeaChat(ideaId);
      if (saved.length > 0) {
        this.chatHistories.set(ideaId, saved);
      }
    }

    const history = this.chatHistories.get(ideaId);
    if (!history || history.length === 0) {
      messagesEl.innerHTML = '<div class="chat-empty">Задайте вопрос об этой идее.</div>';
      return;
    }
    messagesEl.innerHTML = history.map(m =>
      `<div class="chat-msg chat-msg-${m.role}">${m.role === 'user' ? this.renderMarkdown(m.content, true) : this.renderMarkdown(m.content, false)}</div>`
    ).join('');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  private async sendChatMessage(ideaId: string): Promise<void> {
    const messagesEl = document.getElementById('fc-chat-messages');
    const input = document.getElementById('fc-chat-input') as HTMLTextAreaElement | null;
    const sendBtn = document.getElementById('fc-chat-send');
    if (!messagesEl || !input) return;

    const userText = input.value.trim();
    if (!userText) return;

    let settings: Awaited<ReturnType<typeof getSettings>>;
    try {
      settings = await getSettings();
    } catch {
      this.appendChatMsg(messagesEl, 'system', 'Ошибка: не удалось загрузить настройки.');
      return;
    }
    const apiKey = settings.providerKeys[settings.activeProvider];
    if (!apiKey) {
      this.appendChatMsg(messagesEl, 'system', `API ключ для "${settings.activeProvider}" не настроен.`);
      return;
    }

    if (!this.chatHistories.has(ideaId)) {
      this.chatHistories.set(ideaId, []);
    }
    const history = this.chatHistories.get(ideaId)!;

    const emptyEl = messagesEl.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();

    history.push({ role: 'user', content: userText, timestamp: Date.now() });
    this.appendChatMsg(messagesEl, 'user', userText);
    input.value = '';
    input.style.height = 'auto';

    const loadingEl = document.createElement('div');
    loadingEl.className = 'chat-msg chat-msg-assistant chat-loading';
    loadingEl.innerHTML = '<span class="chat-loading-dots"><span>.</span><span>.</span><span>.</span></span>';
    messagesEl.appendChild(loadingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    input.disabled = true;
    if (sendBtn) (sendBtn as HTMLElement).style.pointerEvents = 'none';

    try {
      const idea = await db.ideas.get(ideaId);
      if (!idea) throw new Error('Идея не найдена');
      const systemPrompt = await this.buildSystemPrompt(idea);

      const provider = createProvider(settings.activeProvider, apiKey, { zaiBaseUrl: settings.zaiBaseUrl });
      const fallbackModels = parseFallbackModels(settings.fallbackModels);

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content })),
      ];

      const response = await provider.chat(messages, {
        model: settings.activeModel,
        fallbackModels,
        retriesPerModel: 1,
      });

      history.push({ role: 'assistant', content: response.content, timestamp: Date.now() });
      await saveIdeaChat(ideaId, [...history]);
    } catch (err) {
      history.pop();
      this.appendChatMsg(messagesEl, 'system', `Ошибка: ${this.esc(String(err).slice(0, 200))}`);
    } finally {
      loadingEl.remove();
      const lastMsg = history[history.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        this.appendChatMsg(messagesEl, 'assistant', lastMsg.content);
      }
      input.disabled = false;
      if (sendBtn) (sendBtn as HTMLElement).style.pointerEvents = '';
      input.focus();
    }
  }

  private async buildSystemPrompt(idea: Idea): Promise<string> {
    const cached = this.chatSystemPrompts.get(idea.id);
    if (cached) return cached;

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
    prompt += `=== ИДЕЯ ===\nЗаголовок: ${idea.title}\nТип: ${idea.type}\nГлубина: ${idea.depth}\nСуть: ${idea.summary}\n`;
    if (idea.quote) prompt += `Цитата: ${idea.quote}\n`;
    prompt += `Страницы: ${idea.pages.join(', ')}\n`;
    if (idea.relations.length > 0) prompt += `Связи: ${idea.relations.length} шт.\n`;

    if (pageTexts.length > 0) {
      prompt += `\n=== КОНТЕКСТ СТРАНИЦ ===\n${pageTexts.join('\n\n')}`;
    }

    prompt += `\n\nИнструкции:\n- Отвечай на русском языке\n- Используй формулы LaTeX: строчные $...$ и блочные $$...$$\n- Будь лаконичным но информативным`;

    this.chatSystemPrompts.set(idea.id, prompt);
    return prompt;
  }

  private appendChatMsg(container: HTMLElement, role: 'user' | 'assistant' | 'system', content: string): void {
    const div = document.createElement('div');
    div.className = `chat-msg chat-msg-${role}`;
    div.innerHTML = role === 'user' ? this.renderMarkdown(content, true) : this.renderMarkdown(content, false);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // ─── Helpers ────────────────────────────────────────────

  private toggleSection(bodyId: string, toggleId: string): boolean {
    const body = document.getElementById(bodyId) as HTMLElement | null;
    const toggle = document.getElementById(toggleId);
    if (!body || !toggle) return false;
    const isVisible = body.style.display !== 'none';
    body.style.display = isVisible ? 'none' : 'block';
    const icon = toggle.querySelector('.fc-toggle-icon');
    if (icon) icon.textContent = isVisible ? '▶' : '▼';
    return !isVisible;
  }

  private esc(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  private escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private pluralize(n: number, one: string, few: string, many: string): string {
    const abs = Math.abs(n) % 100;
    const n1 = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (n1 > 1 && n1 < 5) return few;
    if (n1 === 1) return one;
    return many;
  }

  private mathTokenCounter = 0;

  private renderMarkdown(text: string, plain: boolean): string {
    if (!text) return '';
    const tokens = new Map<string, string>();
    this.mathTokenCounter = 0;
    let result = text;

    result = result.replace(/\$\$([\s\S]+?)\$\$/g, (_, latex) => {
      const token = `%%MATH_BLOCK_${this.mathTokenCounter++}%%`;
      try {
        tokens.set(token, katex.renderToString(latex.trim(), { displayMode: true, throwOnError: false }));
      } catch {
        tokens.set(token, `<code>${this.esc(latex)}</code>`);
      }
      return token;
    });

    result = result.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)(?<!\$)\$(?!\$)/g, (_, latex) => {
      const token = `%%MATH_INLINE_${this.mathTokenCounter++}%%`;
      try {
        tokens.set(token, katex.renderToString(latex.trim(), { displayMode: false, throwOnError: false }));
      } catch {
        tokens.set(token, `<code>${this.esc(latex)}</code>`);
      }
      return token;
    });

    result = result.replace(/\\\((.+?)\\\)/g, (_, latex) => {
      const token = `%%MATH_INLINE_${this.mathTokenCounter++}%%`;
      try {
        tokens.set(token, katex.renderToString(latex.trim(), { displayMode: false, throwOnError: false }));
      } catch {
        tokens.set(token, `<code>${this.esc(latex)}</code>`);
      }
      return token;
    });

    if (plain) {
      result = this.esc(result);
      result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
      result = result.replace(/`([^`]+?)`/g, '<code>$1</code>');
      result = result.replace(/\n/g, '<br>');
    } else {
      result = marked.parse(result, { async: false, breaks: true }) as string;
    }

    for (const [token, html] of tokens) {
      result = result.replace(token, html);
    }

    return result;
  }
}
