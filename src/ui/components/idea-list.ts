// ============================================================
// Idea List View — cards with extracted ideas and filters
// ============================================================

import { db } from '../../db/index.js';
import type { Idea, Familiarity, IdeaStatus } from '../../db/schema.js';
import { AnalysisPanel } from './analysis-panel.js';
import { openInZathura, isNativeHostAvailable } from '../utils/native-messaging.js';
import '../styles/components/idea-list.css';

const TYPE_ICONS: Record<string, string> = {
  definition: '📋', method: '🔧', theorem: '📐',
  insight: '💡', example: '📝', analogy: '🔄',
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
  private filters = { familiarity: 'all' as Familiarity | 'all', status: 'all' as IdeaStatus | 'all', type: 'all' as Idea['type'] | 'all' };

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  async render(): Promise<void> {
    const book = await db.books.get(this.bookId);
    this.bookFilePath = book?.filePath;
    const allIdeas = await db.ideas.where('bookId').equals(this.bookId).toArray();
    const ideas = this.applyFilters(allIdeas);

    this.container.innerHTML = `
      <div class="idea-list-view">
        <div class="view-header">
          <h2>💡 Идеи: ${book ? this.esc(book.title) : ''}</h2>
          <button class="primary-btn" id="btn-analyze">🔍 Анализировать</button>
        </div>
        <div class="filters-bar">
          <select id="filter-fam" class="filter-select">
            <option value="all"${this.filters.familiarity === 'all' ? ' selected' : ''}>Все уровни знакомства</option>
            <option value="unknown"${this.filters.familiarity === 'unknown' ? ' selected' : ''}>❌ Не изучал</option>
            <option value="heard"${this.filters.familiarity === 'heard' ? ' selected' : ''}>⚠️ Слышал</option>
            <option value="known"${this.filters.familiarity === 'known' ? ' selected' : ''}>✅ Знаю</option>
            <option value="new"${this.filters.familiarity === 'new' ? ' selected' : ''}>🆕 Новые</option>
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
          <span class="idea-count">${ideas.length} / ${allIdeas.length}</span>
        </div>
        <div class="ideas-container">
          ${ideas.length === 0 ? `
            <div class="empty-state"><div class="empty-icon">🧠</div>
            <p>Идеи ещё не извлечены</p><p class="empty-hint">Нажмите «Анализировать»</p></div>
          ` : ideas.map((i) => this.card(i)).join('')}
        </div>
      </div>`;

    this.bind();
  }

  private card(i: Idea): string {
    return `
      <div class="idea-card ${STAT_COLORS[i.status]}" data-idea-id="${i.id}">
        <div class="idea-card-header">
          <span class="idea-type-icon">${TYPE_ICONS[i.type] || '📌'}</span>
          <span class="idea-depth-badge depth-${i.depth}">${DEPTH_LABELS[i.depth]}</span>
          <span class="idea-importance">⭐ ${'★'.repeat(i.importance)}${'☆'.repeat(5 - i.importance)}</span>
        </div>
        <h3 class="idea-title">${this.esc(i.title)}</h3>
        <p class="idea-summary">${this.esc(i.summary)}</p>
        ${i.quote ? `<blockquote class="idea-quote">${this.esc(i.quote)}</blockquote>` : ''}
        <div class="idea-meta">
          <span>📄 стр. ${i.pages.join(', ')}</span>
          ${i.relations.length ? `<span>🔗 ${i.relations.length} связей</span>` : ''}
          ${this.bookFilePath ? `
            ${i.pages.map((p, idx) => `
              <button class="btn-zathura" data-page="${p}" data-quote="${this.escAttr(i.quote || '')}" title="Открыть в zathura на стр. ${p}">
                📖 zathura${idx === 0 && i.quote ? ' + поиск' : ''}
              </button>
            `).join('')}
          ` : ''}
          ${!this.bookFilePath ? `
            <span class="zathura-hint" title="Добавьте путь к файлу в настройках книги">📖 путь не указан</span>
          ` : ''}
        </div>
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
        <div class="idea-notes">
          <label>📝 Заметки:</label>
          <textarea class="notes-textarea" data-idea-id="${i.id}" placeholder="Ваши заметки...">${this.esc(i.notes)}</textarea>
        </div>
        ${i.userTags?.length ? `<div class="idea-tags">${i.userTags.map(t => `<span class="tag">${this.esc(t)}</span>`).join('')}</div>` : ''}
      </div>`;
  }

  private bind(): void {
    const rerender = () => this.render();
    document.getElementById('filter-fam')?.addEventListener('change', (e) => { this.filters.familiarity = (e.target as HTMLSelectElement).value as typeof this.filters.familiarity; rerender(); });
    document.getElementById('filter-stat')?.addEventListener('change', (e) => { this.filters.status = (e.target as HTMLSelectElement).value as typeof this.filters.status; rerender(); });
    document.getElementById('filter-type')?.addEventListener('change', (e) => { this.filters.type = (e.target as HTMLSelectElement).value as typeof this.filters.type; rerender(); });

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
      ta.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const id = (ta as HTMLElement).dataset.ideaId;
          if (id) await db.ideas.update(id, { notes: (ta as HTMLTextAreaElement).value });
        }, 500);
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
        btn.textContent = '⏳ Открываю...';
        btn.classList.add('btn-zathura-loading');

        const result = await openInZathura(this.bookFilePath, page, quote || undefined);

        if (result.launched) {
          btn.textContent = '✅ Открыто!';
          if (result.searchHint) {
            // Show search hint as a tooltip-like element
            showZathuraHint(btn, result.searchHint);
          }
        } else {
          btn.textContent = '📋 Скопировано';
          if (result.error) {
            showZathuraHint(btn, result.error);
          }
        }

        btn.classList.remove('btn-zathura-loading');
        setTimeout(() => { btn.textContent = original; }, 2500);
      });
    });

    // Listen for analysis completion — re-render ideas
    document.addEventListener('ideas-updated', rerender, { once: true });
  }

  private applyFilters(ideas: Idea[]): Idea[] {
    return ideas.filter(i => {
      if (this.filters.familiarity !== 'all' && i.familiarity !== this.filters.familiarity) return false;
      if (this.filters.status !== 'all' && i.status !== this.filters.status) return false;
      if (this.filters.type !== 'all' && i.type !== this.filters.type) return false;
      return true;
    });
  }

  private esc(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

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
