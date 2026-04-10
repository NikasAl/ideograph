// ============================================================
// Main App — SPA entry point for Ideograph new tab
// ============================================================

import './styles/global.css';
import { BookListView } from './components/book-list.js';
import { IdeaListView } from './components/idea-list.js';
import { IdeaGraphView } from './components/idea-graph.js';
import { SettingsModal } from './components/settings-modal.js';
import { getSettings } from '../db/index.js';
import { restoreAllHandles } from './utils/file-store.js';
import type { Settings } from '../db/schema.js';

type ViewType = 'library' | 'ideas' | 'graph';

class App {
  private currentView: ViewType = 'library';
  private selectedBookId: string | null = null;
  private settings: Settings | null = null;

  async init(): Promise<void> {
    // Restore file handles from IndexedDB before rendering
    await restoreAllHandles();
    this.settings = await getSettings();
    this.applyTheme(this.settings.theme);
    this.render();
    this.bindEvents();
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
          <span class="logo-icon">💡</span>
          <h1 class="logo-text">Идеограф</h1>
        </div>
        <nav class="app-nav">
          <button class="nav-btn ${this.currentView === 'library' ? 'active' : ''}" data-view="library">
            📚 Библиотека
          </button>
          <button class="nav-btn ${this.currentView === 'ideas' ? 'active' : ''}" data-view="ideas" ${!this.selectedBookId ? 'disabled' : ''}>
            💡 Идеи
          </button>
          <button class="nav-btn ${this.currentView === 'graph' ? 'active' : ''}" data-view="graph" ${!this.selectedBookId ? 'disabled' : ''}>
            🕸️ Граф
          </button>
        </nav>
        <div class="app-actions">
          <button class="icon-btn btn-about" id="btn-about" title="О расширении">ℹ️</button>
          <button class="icon-btn" id="btn-settings" title="Настройки">⚙️</button>
        </div>
      </header>

      ${this.showAbout ? `
      <div class="about-banner">
        <span class="about-text">💡 Идеограф — Навигатор по идеям книг</span>
        <button class="about-close" id="btn-about-close">✕</button>
      </div>
      ` : ''}

      <main class="app-content">
        <div id="view-container"></div>
      </main>
    `;

    this.renderCurrentView();
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
    }
  }

  private bindEvents(): void {
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

    document.addEventListener('book-selected', ((e: CustomEvent) => {
      this.selectedBookId = e.detail.bookId;
      this.currentView = 'ideas';
      this.render();
    }) as EventListener);

    document.addEventListener('settings-changed', (() => {
      getSettings().then((s) => {
        this.settings = s;
        this.applyTheme(s.theme);
      });
    }) as EventListener);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.settings?.theme === 'system') this.applyTheme('system');
    });
  }
}

const app = new App();
app.init();
