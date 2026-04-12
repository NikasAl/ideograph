// ============================================================
// Main App — SPA entry point for Ideograph new tab
// ============================================================

import './styles/global.css';
import { BookListView } from './components/book-list.js';
import { IdeaListView } from './components/idea-list.js';
import { IdeaGraphView } from './components/idea-graph.js';
import { ModelTestView } from './components/model-test.js';
import { TOCPanel } from './components/toc-panel.js';
import { AnalysisPanel } from './components/analysis-panel.js';
import { SettingsModal } from './components/settings-modal.js';
import { getSettings } from '../db/index.js';
import { restoreAllHandles } from './utils/file-store.js';
import type { Settings } from '../db/schema.js';

type ViewType = 'library' | 'ideas' | 'graph' | 'model-test' | 'toc';

class App {
  private currentView: ViewType = 'library';
  private selectedBookId: string | null = null;
  private settings: Settings | null = null;

  async init(): Promise<void> {
    // Restore file handles from IndexedDB before rendering
    await restoreAllHandles();
    this.settings = await getSettings();
    this.applyTheme(this.settings.theme);
    this.bindGlobalEvents();
    this.render();
  }

  private applyTheme(theme: string): void {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme === 'system' ? this.getSystemTheme() : theme);
  }

  private getSystemTheme(): string {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private showAbout = false;

  private render(): void {
    const app = document.getElementById('app');
    if (!app) return;

    app.innerHTML = `
      <header class="app-header">
        <div class="app-logo">
          <span class="logo-icon">✦</span>
          <h1 class="logo-text">Идеограф</h1>
        </div>
        <nav class="app-nav">
          <button class="nav-btn ${this.currentView === 'library' ? 'active' : ''}" data-view="library">
            ≡ Библиотека
          </button>
          <button class="nav-btn ${this.currentView === 'ideas' ? 'active' : ''}" data-view="ideas" ${!this.selectedBookId ? 'disabled' : ''}>
            ✦ Идеи
          </button>
          <button class="nav-btn ${this.currentView === 'graph' ? 'active' : ''}" data-view="graph" ${!this.selectedBookId ? 'disabled' : ''}>
            ~ Граф
          </button>
          <button class="nav-btn ${this.currentView === 'toc' ? 'active' : ''}" data-view="toc" ${!this.selectedBookId ? 'disabled' : ''}>
            ≡ Оглавление
          </button>
        </nav>
        <div class="app-actions">
          <button class="icon-btn ${this.currentView === 'model-test' ? 'active' : ''}" id="btn-model-test" title="Тест моделей">⚡</button>
          <button class="icon-btn btn-about" id="btn-about" title="О расширении">i</button>
          <button class="icon-btn" id="btn-settings" title="Настройки">⚙</button>
        </div>
      </header>

      ${this.showAbout ? `
      <div class="about-banner">
        <span class="about-text">✦ Идеограф — Навигатор по идеям книг</span>
        <button class="about-close" id="btn-about-close">✕</button>
      </div>
      ` : ''}

      <main class="app-content">
        <div id="view-container"></div>
      </main>
    `;

    this.renderCurrentView();
    this.bindDomEvents();
  }

  private renderCurrentView(): void {
    const container = document.getElementById('view-container');
    if (!container) return;

    switch (this.currentView) {
      case 'library':
        new BookListView(container).render();
        break;
      case 'ideas':
        if (this.selectedBookId) {
          new IdeaListView(container, this.selectedBookId).render();
        }
        break;
      case 'graph':
        if (this.selectedBookId) {
          new IdeaGraphView(container, this.selectedBookId).render();
        }
        break;
      case 'model-test':
        new ModelTestView(container).render();
        break;
      case 'toc':
        if (this.selectedBookId) {
          new TOCPanel(container, this.selectedBookId).render();
        }
        break;
    }
  }

  /** Bind DOM element listeners (must be called after every render) */
  private bindDomEvents(): void {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.currentView = (btn as HTMLElement).dataset.view as ViewType;
        this.render();
      });
    });

    document.getElementById('btn-about')?.addEventListener('click', () => {
      this.showAbout = !this.showAbout;
      this.render();
    });

    document.getElementById('btn-about-close')?.addEventListener('click', () => {
      this.showAbout = false;
      this.render();
    });

    document.getElementById('btn-settings')?.addEventListener('click', () => {
      new SettingsModal().open();
    });

    document.getElementById('btn-model-test')?.addEventListener('click', () => {
      this.currentView = 'model-test';
      this.render();
    });
  }

  /** Bind document-level listeners (called once) */
  private bindGlobalEvents(): void {
    document.addEventListener('book-selected', ((e: CustomEvent) => {
      this.selectedBookId = e.detail.bookId;
      this.currentView = 'ideas';
      this.render();
    }) as EventListener);

    document.addEventListener('open-toc', ((e: CustomEvent) => {
      this.selectedBookId = e.detail.bookId;
      this.currentView = 'toc';
      this.render();
    }) as EventListener);

    document.addEventListener('settings-changed', (() => {
      getSettings().then((s) => {
        this.settings = s;
        this.applyTheme(s.theme);
      });
    }) as EventListener);

    // Navigate event from sub-views (e.g. back button from model-test)
    document.addEventListener('navigate', ((e: CustomEvent) => {
      this.currentView = e.detail.view as ViewType;
      this.render();
    }) as EventListener);

    // Analyze chapter from TOC panel — navigate to ideas and open analysis with pre-filled range
    document.addEventListener('analyze-chapter', ((e: CustomEvent<{
      bookId: string;
      pageFrom: number;
      pageTo: number;
      chapterTitle: string;
      chapterId?: string;
    }>) => {
      const { bookId, pageFrom, pageTo, chapterTitle, chapterId } = e.detail;
      this.selectedBookId = bookId;
      this.currentView = 'ideas';
      this.render();
      // After render, open AnalysisPanel with pre-filled page range
      requestAnimationFrame(() => {
        const container = document.getElementById('view-container');
        if (container) {
          new AnalysisPanel(container, bookId, { pageFrom, pageTo, chapterTitle, chapterId }).render();
        }
      });
    }) as EventListener);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.settings?.theme === 'system') this.applyTheme('system');
    });
  }
}

const app = new App();
app.init();
