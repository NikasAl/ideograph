// ============================================================
// Model Test / Benchmark — test AI models across providers
// ============================================================

import '../styles/components/model-test.css';
import { getSettings } from '../../db/index.js';
import { saveModelRating, clearModelRatings, getBestModels } from '../../db/index.js';
import { createProvider } from '../../background/ai-client.js';
import type { AIProvider, ChatMessage } from '../../background/ai-client.js';
import type { ModelRating, Settings } from '../../db/schema.js';

// ============================================================
// Types
// ============================================================

interface DiscoveredModel {
  id: string;
  name: string;
  provider: 'openrouter' | 'z-ai';
  supportsVision: boolean;
  promptPrice?: number;    // per 1M tokens in USD
  completionPrice?: number;
}

interface TestResult {
  modelId: string;
  provider: string;
  simplePass: boolean;
  simpleTimeMs: number;
  simpleError?: string;
  instructionPass: boolean;
  instructionTimeMs: number;
  instructionError?: string;
  jsonPass: boolean;
  jsonTimeMs: number;
  jsonError?: string;
  extractionPass: boolean;
  extractionTimeMs: number;
  extractionError?: string;
  totalScore: number;
}

// ============================================================
// Test prompts
// ============================================================

const SIMPLE_TEST_PROMPT = 'Ответь одним словом: да';

const INSTRUCTION_TEST_PROMPT =
  'Напиши ровно три строки: первую с числом 42, вторую со словом \'тест\', третью пустую.';

const JSON_TEST_PROMPT =
  'Верни JSON: {"color": "blue", "count": 5}';

const EXTRACTION_SYSTEM_PROMPT = `Ты — аналитик знаний. Твоя задача — извлечь из текста все самостоятельные идеи, концепции, определения, утверждения и методы.

Пиши результат на русском языке, даже если исходный текст на другом языке.

Для каждой идеи укажи:
- title: краткое название (до 10 слов)
- summary: суть в 1-2 предложениях на русском
- type: один из: definition, method, theorem, insight, example, analogy
- depth: basic | medium | advanced
- importance: 1-5

Верни JSON-объект с полем "ideas" — массивом идей.`;

const EXTRACTION_SAMPLE_TEXT = `Линейная алгебра — раздел математики, изучающий векторы, матрицы и линейные отображения.

Определение. Векторное пространство V над полем F — это множество с двумя операциями: сложением векторов и умножением на скаляр, удовлетворяющее восьми аксиомам.

Теорема (о размерности). Любые два базиса векторного пространства имеют одно и то же число элементов. Это число называется размерностью пространства.

Метод Гаусса — алгоритм приведения матрицы к ступенчатому виду с помощью элементарных преобразований строк. Позволяет решать системы линейных уравнений и находить ранг матрицы.

Аналогия: векторное пространство подобно координатной плоскости, но вместо двух направлений может быть любое (конечное) число независимых направлений.`;

const EXTRACTION_USER_PROMPT = `Вот текст. Извлеки из него идеи.

---
${EXTRACTION_SAMPLE_TEXT}
---`;

// ============================================================
// z-ai hardcoded models
// ============================================================

const ZAI_MODELS: Array<Omit<DiscoveredModel, 'provider'>> = [
  { id: 'GLM-4.7-Flash', name: 'GLM-4.7 Flash', supportsVision: false },
  { id: 'GLM-4.6V-Flash', name: 'GLM-4.6V Flash', supportsVision: true },
  { id: 'GLM-4V-Plus', name: 'GLM-4V Plus', supportsVision: true },
  { id: 'GLM-4-Plus', name: 'GLM-4 Plus', supportsVision: false },
];

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPrice(pricePerM: number | undefined): string {
  if (pricePerM === undefined || pricePerM === null) return '—';
  if (pricePerM === 0) return 'бесплатно';
  return `$${pricePerM.toFixed(2)}/M`;
}

function computeScore(r: TestResult): number {
  let score = 0;
  if (r.simplePass) score += 20;
  if (r.instructionPass) score += 25;
  if (r.jsonPass) score += 25;
  if (r.extractionPass) score += 30;
  return score;
}

function starsHtml(rating: number | undefined): string {
  if (!rating) return '<span class="mt-result-skip">—</span>';
  let html = '<span class="mt-star-rating">';
  for (let i = 1; i <= 5; i++) {
    html += `<span class="mt-star ${i <= rating ? 'active' : ''}" data-rating="${i}">★</span>`;
  }
  html += '</span>';
  return html;
}

// ============================================================
// Main component
// ============================================================

export class ModelTestView {
  private container: HTMLElement;
  private settings: Settings | null = null;

  // State
  private activeProvider: 'openrouter' | 'z-ai' = 'openrouter';
  private allModels: DiscoveredModel[] = [];
  private filteredModels: DiscoveredModel[] = [];
  private selectedModelIds = new Set<string>();
  private testResults: Map<string, TestResult> = new Map();

  // Filter state
  private searchQuery = '';
  private maxPrice = '';
  private visionOnly = false;

  // Test state
  private isRunning = false;
  private isCancelled = false;
  private abortController: AbortController | null = null;
  private currentTestModel = '';
  private currentTestPhase = '';
  private progressPercent = 0;

  // Test options
  private runExtractionTest = true;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async render(): Promise<void> {
    this.settings = await getSettings();
    this.renderHTML();
    this.bindEvents();
  }

  // ============================================================
  // HTML rendering
  // ============================================================

  private renderHTML(): void {
    const s = this.settings!;

    this.container.innerHTML = `
      <div class="model-test-view">
        <div class="view-header">
          <div>
            <h2>🧪 Тест моделей</h2>
            <p class="view-description">
              Загрузите список моделей, выберите и запустите тесты для сравнения качества и скорости ответа AI-моделей.
            </p>
          </div>
          <button class="mt-back-btn" id="mt-back">← Назад</button>
        </div>

        <!-- Provider tabs -->
        <div class="mt-section">
          <div class="mt-provider-tabs">
            <button class="mt-provider-tab ${this.activeProvider === 'openrouter' ? 'active' : ''}" data-provider="openrouter">
              OpenRouter
              <span class="provider-key-status ${s.providerKeys.openrouter ? 'key-ok' : 'key-missing'}"></span>
            </button>
            <button class="mt-provider-tab ${this.activeProvider === 'z-ai' ? 'active' : ''}" data-provider="z-ai">
              z-ai
              <span class="provider-key-status ${s.providerKeys['z-ai'] && s.zaiBaseUrl ? 'key-ok' : 'key-missing'}"></span>
            </button>
          </div>

          <div class="mt-section-description">
            ${this.activeProvider === 'openrouter'
              ? 'Загрузит список всех моделей с OpenRouter API. Показывает цены и поддержку vision.'
              : 'Использует предустановленный список z-ai моделей. Убедитесь что z-ai Base URL указан в настройках.'}
          </div>

          <div class="mt-test-controls">
            <button class="primary-btn" id="mt-fetch-models">📥 Загрузить модели</button>
            <span id="mt-models-count" class="mt-model-list-count"></span>
          </div>
        </div>

        <!-- Model list (shown after fetch) -->
        <div class="mt-section" id="mt-model-list-section" style="display:none;">
          <div class="mt-section-header">
            <h3>📋 Модели (${this.filteredModels.length})</h3>
          </div>

          <!-- Filters -->
          <div class="mt-filters">
            <label>
              🔍 <input type="text" id="mt-search" placeholder="Поиск по названию..." value="${escapeHtml(this.searchQuery)}" />
            </label>
            <label>
              💰 Макс. цена: <input type="number" id="mt-max-price" placeholder="∞" value="${this.maxPrice}" min="0" step="0.01" style="width:80px;" />
            </label>
            <label class="mt-checkbox-label">
              <input type="checkbox" id="mt-vision-only" ${this.visionOnly ? 'checked' : ''} />
              Только vision
            </label>
            <button class="mt-quick-select" id="mt-select-free">Бесплатные</button>
            <button class="mt-quick-select" id="mt-select-under-1">До $1</button>
            <button class="mt-quick-select" id="mt-select-all">Выбрать все</button>
            <button class="mt-quick-select" id="mt-deselect-all">Снять все</button>
          </div>

          <!-- Table -->
          <div class="mt-model-list-wrapper">
            <table class="mt-model-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Модель</th>
                  <th>Ввод</th>
                  <th>Вывод</th>
                  <th>Vision</th>
                </tr>
              </thead>
              <tbody id="mt-model-table-body">
                ${this.renderModelRows()}
              </tbody>
            </table>
          </div>
          <div class="mt-model-list-count">
            Выбрано: <strong id="mt-selected-count">${this.selectedModelIds.size}</strong>
          </div>
        </div>

        <!-- Test configuration & run -->
        <div class="mt-section" id="mt-test-section" style="display:none;">
          <div class="mt-section-header">
            <h3>🚀 Запуск тестов</h3>
          </div>
          <div class="mt-test-options">
            <label class="mt-test-option">
              <input type="checkbox" id="mt-run-extraction" ${this.runExtractionTest ? 'checked' : ''} />
              Тест извлечения идей (долгий)
            </label>
          </div>

          <div class="mt-test-controls">
            <button class="primary-btn" id="mt-run-tests" ${this.selectedModelIds.size === 0 ? 'disabled' : ''}>
              ▶ Запустить тесты (${this.selectedModelIds.size} модел${this.selectedModelIds.size === 1 ? 'ь' : this.selectedModelIds.size < 5 ? 'и' : 'ей'})
            </button>
            <button class="mt-btn-cancel" id="mt-cancel-tests" style="display:none;">⏹ Отменить</button>
            <span class="selected-count" id="mt-test-status"></span>
          </div>

          <!-- Progress -->
          <div class="mt-progress-section" id="mt-progress-section" style="display:none;">
            <div class="mt-progress-info">
              <span class="mt-progress-model" id="mt-progress-model"></span>
              <span class="mt-progress-stats" id="mt-progress-stats"></span>
            </div>
            <div class="mt-progress-bar">
              <div class="mt-progress-fill" id="mt-progress-fill"></div>
            </div>
          </div>
        </div>

        <!-- Error display -->
        <div id="mt-error-container"></div>

        <!-- Results -->
        <div class="mt-section" id="mt-results-section" style="display:none;">
          <div class="mt-section-header">
            <h3>📊 Результаты</h3>
            <div class="mt-actions-row">
              <button class="mt-btn-export" id="mt-export-json">📥 Экспорт JSON</button>
            </div>
          </div>
          <div class="mt-results-wrapper">
            <table class="mt-results-table">
              <thead>
                <tr>
                  <th>Модель</th>
                  <th>Простой</th>
                  <th>Инструкции</th>
                  <th>JSON</th>
                  <th>Извлечение</th>
                  <th>Оценка</th>
                  <th>Балл</th>
                </tr>
              </thead>
              <tbody id="mt-results-body">
                ${this.renderResultRows()}
              </tbody>
            </table>
          </div>
        </div>

        <!-- History -->
        <div class="mt-section mt-history" id="mt-history-section" style="display:none;">
          <div class="mt-section-header">
            <h3>📜 История тестов</h3>
            <div class="mt-actions-row">
              <button class="mt-btn-danger" id="mt-clear-history">🗑 Очистить историю</button>
            </div>
          </div>
          <div id="mt-history-list">
            <div class="mt-loading"><div class="mt-spinner"></div> Загрузка...</div>
          </div>
        </div>
      </div>
    `;

    // Load history in background
    this.loadHistory();
  }

  private renderModelRows(): string {
    if (this.filteredModels.length === 0) {
      return `<tr><td colspan="5" class="mt-empty">Нет моделей</td></tr>`;
    }

    return this.filteredModels.map((m) => {
      const selected = this.selectedModelIds.has(m.id) ? 'checked' : '';
      const rowClass = this.selectedModelIds.has(m.id) ? 'selected' : '';
      return `
        <tr class="${rowClass}">
          <td><input type="checkbox" data-model-id="${escapeHtml(m.id)}" ${selected} /></td>
          <td>
            <div class="mt-model-name">
              ${escapeHtml(m.id)}
              ${m.name !== m.id ? `<span class="mt-model-pretty">${escapeHtml(m.name)}</span>` : ''}
            </div>
          </td>
          <td><span class="mt-model-price">${formatPrice(m.promptPrice)}</span></td>
          <td><span class="mt-model-price">${formatPrice(m.completionPrice)}</span></td>
          <td>${m.supportsVision ? '<span class="mt-model-vision-badge">👁 Vision</span>' : '—'}</td>
        </tr>
      `;
    }).join('');
  }

  private renderResultRows(): string {
    const results = Array.from(this.testResults.values()).sort((a, b) => b.totalScore - a.totalScore);
    if (results.length === 0) {
      return `<tr><td colspan="7" class="mt-empty">Нет результатов</td></tr>`;
    }

    return results.map((r) => {
      const scoreClass = r.totalScore >= 70 ? 'high' : r.totalScore >= 40 ? 'medium' : 'low';
      return `
        <tr>
          <td>
            <div class="mt-result-model">${escapeHtml(r.modelId)}</div>
            <div class="mt-result-provider">${escapeHtml(r.provider)}</div>
          </td>
          <td>
            <div class="mt-result-cell">
              <span class="${r.simplePass ? 'mt-result-pass' : 'mt-result-fail'}">${r.simplePass ? '✅' : '❌'}</span>
              <span class="mt-result-time">${r.simpleTimeMs}ms</span>
            </div>
          </td>
          <td>
            <div class="mt-result-cell">
              <span class="${r.instructionPass ? 'mt-result-pass' : 'mt-result-fail'}">${r.instructionPass ? '✅' : '❌'}</span>
              <span class="mt-result-time">${r.instructionTimeMs}ms</span>
            </div>
          </td>
          <td>
            <div class="mt-result-cell">
              <span class="${r.jsonPass ? 'mt-result-pass' : 'mt-result-fail'}">${r.jsonPass ? '✅' : '❌'}</span>
              <span class="mt-result-time">${r.jsonTimeMs}ms</span>
            </div>
          </td>
          <td>
            <div class="mt-result-cell">
              <span class="${r.extractionPass ? 'mt-result-pass' : 'mt-result-fail'}">${r.extractionPass ? '✅' : '❌'}</span>
              <span class="mt-result-time">${r.extractionTimeMs}ms</span>
            </div>
          </td>
          <td data-result-model="${escapeHtml(r.modelId)}">${starsHtml(undefined)}</td>
          <td><span class="mt-result-score ${scoreClass}">${r.totalScore}</span></td>
        </tr>
      `;
    }).join('');
  }

  // ============================================================
  // Event binding
  // ============================================================

  private bindEvents(): void {
    // Back button
    this.container.querySelector('#mt-back')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'library' } }));
    });

    // Provider tabs
    this.container.querySelectorAll('.mt-provider-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (this.isRunning) return;
        this.activeProvider = (tab as HTMLElement).dataset.provider as 'openrouter' | 'z-ai';
        this.renderHTML();
        this.bindEvents();
      });
    });

    // Fetch models
    this.container.querySelector('#mt-fetch-models')?.addEventListener('click', () => {
      this.fetchModels();
    });

    // Filters
    this.container.querySelector('#mt-search')?.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.applyFilters();
    });

    this.container.querySelector('#mt-max-price')?.addEventListener('input', (e) => {
      this.maxPrice = (e.target as HTMLInputElement).value;
      this.applyFilters();
    });

    this.container.querySelector('#mt-vision-only')?.addEventListener('change', (e) => {
      this.visionOnly = (e.target as HTMLInputElement).checked;
      this.applyFilters();
    });

    // Quick select buttons
    this.container.querySelector('#mt-select-free')?.addEventListener('click', () => {
      this.selectedModelIds.clear();
      for (const m of this.filteredModels) {
        if ((m.promptPrice ?? 0) === 0 && (m.completionPrice ?? 0) === 0) {
          this.selectedModelIds.add(m.id);
        }
      }
      this.refreshModelList();
    });

    this.container.querySelector('#mt-select-under-1')?.addEventListener('click', () => {
      this.selectedModelIds.clear();
      for (const m of this.filteredModels) {
        const total = (m.promptPrice ?? 0) + (m.completionPrice ?? 0);
        if (total < 1) {
          this.selectedModelIds.add(m.id);
        }
      }
      this.refreshModelList();
    });

    this.container.querySelector('#mt-select-all')?.addEventListener('click', () => {
      for (const m of this.filteredModels) {
        this.selectedModelIds.add(m.id);
      }
      this.refreshModelList();
    });

    this.container.querySelector('#mt-deselect-all')?.addEventListener('click', () => {
      this.selectedModelIds.clear();
      this.refreshModelList();
    });

    // Extraction test checkbox
    this.container.querySelector('#mt-run-extraction')?.addEventListener('change', (e) => {
      this.runExtractionTest = (e.target as HTMLInputElement).checked;
    });

    // Run tests
    this.container.querySelector('#mt-run-tests')?.addEventListener('click', () => {
      this.runTests();
    });

    // Cancel tests
    this.container.querySelector('#mt-cancel-tests')?.addEventListener('click', () => {
      this.cancelTests();
    });

    // Export JSON
    this.container.querySelector('#mt-export-json')?.addEventListener('click', () => {
      this.exportResults();
    });

    // Clear history
    this.container.querySelector('#mt-clear-history')?.addEventListener('click', async () => {
      if (confirm('Удалить всю историю тестов?')) {
        await clearModelRatings();
        this.loadHistory();
      }
    });

    // Checkbox clicks on model rows (delegated)
    this.container.querySelector('#mt-model-table-body')?.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.type === 'checkbox' && target.dataset.modelId) {
        if (target.checked) {
          this.selectedModelIds.add(target.dataset.modelId);
        } else {
          this.selectedModelIds.delete(target.dataset.modelId);
        }
        this.refreshModelList();
      }
    });

    // Star rating clicks (delegated)
    this.container.querySelector('#mt-results-body')?.addEventListener('click', (e) => {
      const star = (e.target as HTMLElement).closest('.mt-star') as HTMLElement | null;
      if (!star) return;
      const rating = parseInt(star.dataset.rating || '0', 10);
      const modelCell = (e.target as HTMLElement).closest('[data-result-model]') as HTMLElement | null;
      if (!modelCell) return;
      const modelId = modelCell.dataset.resultModel!;
      const result = this.testResults.get(modelId);
      if (!result) return;

      // Save rating
      this.saveRating(result, rating);
      // Re-render stars
      modelCell.innerHTML = starsHtml(rating);
    });
  }

  // ============================================================
  // Model fetching
  // ============================================================

  private async fetchModels(): Promise<void> {
    const s = this.settings!;
    const btn = this.container.querySelector('#mt-fetch-models') as HTMLElement;
    const countEl = this.container.querySelector('#mt-models-count') as HTMLElement;

    btn.textContent = '⏳ Загрузка...';
    btn.setAttribute('disabled', 'true');

    try {
      if (this.activeProvider === 'openrouter') {
        if (!s.providerKeys.openrouter) {
          this.showError('OpenRouter API ключ не задан. Укажите его в настройках.');
          return;
        }
        await this.fetchOpenRouterModels(s.providerKeys.openrouter);
      } else {
        if (!s.providerKeys['z-ai']) {
          this.showError('z-ai API ключ не задан. Укажите его в настройках.');
          return;
        }
        this.loadZAIModels();
      }

      this.applyFilters();

      // Show model list section
      const section = this.container.querySelector('#mt-model-list-section') as HTMLElement | null;
      if (section) section.style.display = '';

      // Show test section
      const testSection = this.container.querySelector('#mt-test-section') as HTMLElement | null;
      if (testSection) testSection.style.display = '';

      countEl.textContent = `Найдено: ${this.allModels.length} моделей`;
    } catch (err) {
      this.showError(`Ошибка загрузки моделей: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      btn.textContent = '📥 Загрузить модели';
      btn.removeAttribute('disabled');
    }
  }

  private async fetchOpenRouterModels(apiKey: string): Promise<void> {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
      throw new Error(`OpenRouter API вернул ${resp.status}`);
    }
    const data = await resp.json() as Record<string, unknown>;
    const rawModels = (data.data as Array<Record<string, unknown>>) || [];

    this.allModels = rawModels.map((m) => {
      const pricing = m.pricing as Record<string, unknown> | undefined;
      const arch = m.architecture as Record<string, unknown> | undefined;
      const modality = (arch?.modality as string) || '';
      const supportsVision = ['vision', 'image'].some((k) => modality.includes(k));
      const promptPrice = pricing?.prompt ? parseFloat(pricing.prompt as string) * 1_000_000 : undefined;
      const completionPrice = pricing?.completion ? parseFloat(pricing.completion as string) * 1_000_000 : undefined;

      return {
        id: m.id as string,
        name: (m.name as string) || (m.id as string),
        provider: 'openrouter' as const,
        supportsVision,
        promptPrice: isNaN(promptPrice ?? NaN) ? undefined : promptPrice,
        completionPrice: isNaN(completionPrice ?? NaN) ? undefined : completionPrice,
      };
    });

    // Sort by prompt price (free first, then cheap)
    this.allModels.sort((a, b) => ((a.promptPrice ?? 0) + (a.completionPrice ?? 0)) - ((b.promptPrice ?? 0) + (b.completionPrice ?? 0)));
  }

  private loadZAIModels(): void {
    this.allModels = ZAI_MODELS.map((m) => ({
      ...m,
      provider: 'z-ai' as const,
      promptPrice: undefined,
      completionPrice: undefined,
    }));
  }

  // ============================================================
  // Filters
  // ============================================================

  private applyFilters(): void {
    let models = [...this.allModels];

    // Search filter
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      models = models.filter((m) =>
        m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      );
    }

    // Price filter
    if (this.maxPrice) {
      const max = parseFloat(this.maxPrice);
      if (!isNaN(max)) {
        models = models.filter((m) => {
          const prompt = m.promptPrice ?? 0;
          const completion = m.completionPrice ?? 0;
          return prompt <= max && completion <= max;
        });
      }
    }

    // Vision-only filter
    if (this.visionOnly) {
      models = models.filter((m) => m.supportsVision);
    }

    this.filteredModels = models;
    this.refreshModelList();
  }

  private refreshModelList(): void {
    const tbody = this.container.querySelector('#mt-model-table-body');
    if (tbody) tbody.innerHTML = this.renderModelRows();

    const countEl = this.container.querySelector('#mt-selected-count');
    if (countEl) countEl.textContent = String(this.selectedModelIds.size);

    const runBtn = this.container.querySelector('#mt-run-tests') as HTMLButtonElement | null;
    if (runBtn) {
      runBtn.disabled = this.selectedModelIds.size === 0;
      runBtn.textContent = this.selectedModelIds.size > 0
        ? `▶ Запустить тесты (${this.selectedModelIds.size} модел${this.selectedModelIds.size === 1 ? 'ь' : this.selectedModelIds.size < 5 ? 'и' : 'ей'})`
        : '▶ Запустить тесты';
    }
  }

  // ============================================================
  // Test execution
  // ============================================================

  private async runTests(): Promise<void> {
    if (this.selectedModelIds.size === 0) return;

    const s = this.settings!;
    this.isRunning = true;
    this.isCancelled = false;
    this.abortController = new AbortController();
    this.testResults.clear();

    const runBtn = this.container.querySelector('#mt-run-tests') as HTMLElement;
    const cancelBtn = this.container.querySelector('#mt-cancel-tests') as HTMLElement;
    const statusEl = this.container.querySelector('#mt-test-status') as HTMLElement;
    const progressSection = this.container.querySelector('#mt-progress-section') as HTMLElement;
    const resultsSection = this.container.querySelector('#mt-results-section') as HTMLElement;

    runBtn.style.display = 'none';
    cancelBtn.style.display = '';
    progressSection.style.display = '';
    resultsSection.style.display = '';

    // Create provider — for testing we try both providers as needed
    // Use the currently active provider settings
    const providerMap = new Map<string, AIProvider>();

    const modelsToTest = this.filteredModels.filter((m) => this.selectedModelIds.has(m.id));
    const totalModels = modelsToTest.length;
    const totalSteps = totalModels * (this.runExtractionTest ? 4 : 3);
    let currentStep = 0;

    for (const model of modelsToTest) {
      if (this.isCancelled) break;

      // Get or create provider for this model's provider type
      let provider = providerMap.get(model.provider);
      if (!provider) {
        try {
          const apiKey = model.provider === 'openrouter'
            ? s.providerKeys.openrouter!
            : s.providerKeys['z-ai']!;
          provider = createProvider(model.provider, apiKey, { zaiBaseUrl: s.zaiBaseUrl });
          providerMap.set(model.provider, provider);
        } catch (err) {
          this.testResults.set(model.id, {
            modelId: model.id,
            provider: model.provider,
            simplePass: false, simpleTimeMs: 0, simpleError: `Provider error: ${err}`,
            instructionPass: false, instructionTimeMs: 0, instructionError: 'Skipped',
            jsonPass: false, jsonTimeMs: 0, jsonError: 'Skipped',
            extractionPass: false, extractionTimeMs: 0, extractionError: 'Skipped',
            totalScore: 0,
          });
          currentStep += this.runExtractionTest ? 4 : 3;
          this.updateProgress(model.id, `Ошибка провайдера`, currentStep, totalSteps);
          continue;
        }
      }

      const result: TestResult = {
        modelId: model.id,
        provider: model.provider,
        simplePass: false, simpleTimeMs: 0,
        instructionPass: false, instructionTimeMs: 0,
        jsonPass: false, jsonTimeMs: 0,
        extractionPass: false, extractionTimeMs: 0,
        totalScore: 0,
      };

      // --- Test 1: Simple response ---
      if (!this.isCancelled) {
        this.updateProgress(model.id, 'Простой тест...', currentStep, totalSteps);
        try {
          const start = Date.now();
          const resp = await provider.chat(
            [{ role: 'user', content: SIMPLE_TEST_PROMPT }],
            { model: model.id, temperature: 0, maxTokens: 50 },
          );
          result.simpleTimeMs = Date.now() - start;
          const answer = resp.content.toLowerCase().trim();
          result.simplePass = answer.includes('да') || answer.includes('yes');
        } catch (err) {
          result.simpleTimeMs = 0;
          result.simpleError = err instanceof Error ? err.message : String(err);
        }
        currentStep++;
      }

      // Rate limit delay
      if (s.requestDelayMs && !this.isCancelled) await sleep(s.requestDelayMs);

      // --- Test 2: Instruction following ---
      if (!this.isCancelled) {
        this.updateProgress(model.id, 'Тест инструкций...', currentStep, totalSteps);
        try {
          const start = Date.now();
          const resp = await provider.chat(
            [{ role: 'user', content: INSTRUCTION_TEST_PROMPT }],
            { model: model.id, temperature: 0, maxTokens: 200 },
          );
          result.instructionTimeMs = Date.now() - start;
          const lines = resp.content.trim().split('\n');
          result.instructionPass =
            lines.length >= 3 &&
            lines[0].includes('42') &&
            lines[1].includes('тест') &&
            lines[2].trim() === '';
        } catch (err) {
          result.instructionTimeMs = 0;
          result.instructionError = err instanceof Error ? err.message : String(err);
        }
        currentStep++;
      }

      if (s.requestDelayMs && !this.isCancelled) await sleep(s.requestDelayMs);

      // --- Test 3: JSON mode ---
      if (!this.isCancelled) {
        this.updateProgress(model.id, 'JSON тест...', currentStep, totalSteps);
        try {
          const start = Date.now();
          const resp = await provider.chat(
            [{ role: 'user', content: JSON_TEST_PROMPT }],
            { model: model.id, temperature: 0, maxTokens: 100, jsonMode: true },
          );
          result.jsonTimeMs = Date.now() - start;
          const parsed = JSON.parse(resp.content);
          result.jsonPass = parsed.color === 'blue' && parsed.count === 5;
        } catch (err) {
          result.jsonTimeMs = 0;
          result.jsonError = err instanceof Error ? err.message : String(err);
        }
        currentStep++;
      }

      // --- Test 4: Idea extraction (optional) ---
      if (this.runExtractionTest && !this.isCancelled) {
        if (s.requestDelayMs) await sleep(s.requestDelayMs);
        this.updateProgress(model.id, 'Тест извлечения идей...', currentStep, totalSteps);
        try {
          const start = Date.now();
          const messages: ChatMessage[] = [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: EXTRACTION_USER_PROMPT },
          ];
          const resp = await provider.chat(
            messages,
            { model: model.id, temperature: 0.3, maxTokens: 4096, jsonMode: true },
          );
          result.extractionTimeMs = Date.now() - start;

          const json = JSON.parse(resp.content);
          const ideas = json.ideas || json;
          if (Array.isArray(ideas) && ideas.length > 0) {
            const first = ideas[0];
            result.extractionPass =
              typeof first.title === 'string' && first.title.length > 0 &&
              typeof first.summary === 'string' && first.summary.length > 0;
          }
        } catch (err) {
          result.extractionTimeMs = 0;
          result.extractionError = err instanceof Error ? err.message : String(err);
        }
        currentStep++;
      }

      // Compute score
      result.totalScore = computeScore(result);
      this.testResults.set(model.id, result);

      // Save to DB
      await this.saveRating(result, undefined);

      // Update results table
      this.refreshResults();
    }

    // Done
    this.isRunning = false;
    runBtn.style.display = '';
    cancelBtn.style.display = 'none';

    if (this.isCancelled) {
      statusEl.textContent = '❌ Тесты отменены';
    } else {
      statusEl.textContent = `✅ Тесты завершены (${this.testResults.size} моделей)`;
    }

    this.progressPercent = 100;
    const fill = this.container.querySelector('#mt-progress-fill') as HTMLElement;
    if (fill) {
      fill.style.width = '100%';
      fill.classList.add('complete');
    }

    this.loadHistory();
  }

  private cancelTests(): void {
    this.isCancelled = true;
    this.abortController?.abort();
  }

  private updateProgress(modelId: string, phase: string, step: number, total: number): void {
    this.currentTestModel = modelId;
    this.currentTestPhase = phase;
    this.progressPercent = total > 0 ? Math.round((step / total) * 100) : 0;

    const modelEl = this.container.querySelector('#mt-progress-model');
    const statsEl = this.container.querySelector('#mt-progress-stats');
    const fillEl = this.container.querySelector('#mt-progress-fill');

    if (modelEl) modelEl.textContent = `${modelId} — ${phase}`;
    if (statsEl) statsEl.textContent = `${step}/${total} (${this.progressPercent}%)`;
    if (fillEl) {
      (fillEl as HTMLElement).style.width = `${this.progressPercent}%`;
      fillEl.classList.remove('complete', 'error');
    }
  }

  private refreshResults(): void {
    const tbody = this.container.querySelector('#mt-results-body');
    if (tbody) tbody.innerHTML = this.renderResultRows();
  }

  // ============================================================
  // Rating persistence
  // ============================================================

  private async saveRating(result: TestResult, userRating: number | undefined): Promise<void> {
    const rating: ModelRating = {
      modelId: result.modelId,
      provider: result.provider,
      testedAt: Date.now(),
      simplePass: result.simplePass,
      simpleTimeMs: result.simpleTimeMs,
      instructionPass: result.instructionPass,
      instructionTimeMs: result.instructionTimeMs,
      jsonPass: result.jsonPass,
      jsonTimeMs: result.jsonTimeMs,
      extractionPass: result.extractionPass,
      extractionTimeMs: result.extractionTimeMs,
      totalScore: result.totalScore,
    };
    if (userRating !== undefined) {
      rating.userRating = userRating;
    }
    await saveModelRating(rating);
  }

  // ============================================================
  // History
  // ============================================================

  private async loadHistory(): Promise<void> {
    const section = this.container.querySelector('#mt-history-section') as HTMLElement;
    const listEl = this.container.querySelector('#mt-history-list') as HTMLElement;
    if (!section || !listEl) return;

    try {
      const ratings = await getBestModels(30);
      if (ratings.length === 0) {
        section.style.display = 'none';
        return;
      }

      section.style.display = '';
      listEl.innerHTML = ratings.map((r) => {
        const scoreClass = r.totalScore >= 70 ? 'high' : r.totalScore >= 40 ? 'medium' : 'low';
        const date = new Date(r.testedAt).toLocaleString('ru-RU', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        return `
          <div class="mt-history-item">
            <span class="mt-history-model">${escapeHtml(r.modelId)}</span>
            <span class="mt-result-provider">${escapeHtml(r.provider)}</span>
            <span class="mt-history-date">${date}</span>
            ${r.userRating ? `<span>${'★'.repeat(r.userRating)}${'☆'.repeat(5 - r.userRating)}</span>` : ''}
            <span class="mt-history-score mt-result-score ${scoreClass}">${r.totalScore}</span>
          </div>
        `;
      }).join('');
    } catch {
      listEl.innerHTML = '<div class="mt-empty">Ошибка загрузки истории</div>';
    }
  }

  // ============================================================
  // Export
  // ============================================================

  private exportResults(): void {
    const results = Array.from(this.testResults.values()).sort((a, b) => b.totalScore - a.totalScore);
    const json = JSON.stringify(results, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `model-test-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // Error display
  // ============================================================

  private showError(message: string): void {
    const container = this.container.querySelector('#mt-error-container');
    if (container) {
      container.innerHTML = `<div class="mt-error">⚠️ ${escapeHtml(message)}</div>`;
    }
  }
}
