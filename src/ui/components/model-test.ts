// ============================================================
// Model Test / Benchmark — test AI models across providers
// ============================================================

import '../styles/components/model-test.css';
import { getSettings } from '../../db/index.js';
import { saveModelRating, clearModelRatings, getAllModelRatings } from '../../db/index.js';
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

interface TestDetailItem {
  testId: string;
  testName: string;
  pass: boolean;
  timeMs: number;
  error?: string;
  prompt: string;
  response?: string;
}

interface TestResult {
  modelId: string;
  provider: string;
  totalScore: number;
  testResults: TestDetailItem[];
}

interface TestDefinition {
  id: string;
  name: string;
  prompt: string;         // user message
  systemPrompt?: string;  // optional system message
  maxTokens: number;
  jsonMode: boolean;
  validate: (response: string) => boolean;
  weight: number;         // score points
  isBuiltIn?: boolean;
}

// ============================================================
// Built-in test definitions
// ============================================================

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

/** Strip markdown code fences from response */
function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/gm, '').replace(/\s*```$/gm, '').trim();
}

/** Default built-in tests — can be overridden by user */
function getDefaultTests(): TestDefinition[] {
  return [
    {
      id: 'simple', name: 'Простой ответ',
      prompt: 'Ответь одним словом: да',
      maxTokens: 50, jsonMode: false, weight: 20, isBuiltIn: true,
      validate: (r) => {
        const a = r.toLowerCase().trim();
        return a.includes('да') || a.includes('yes');
      },
    },
    {
      id: 'instruction', name: 'Инструкции',
      prompt: 'Напиши ровно три строки: первую с числом 42, вторую со словом \'тест\', третью пустую.',
      maxTokens: 200, jsonMode: false, weight: 25, isBuiltIn: true,
      validate: (r) => {
        // Strip code fences, find consecutive lines with 42 and тест
        const text = stripCodeFences(r);
        const lines = text.split('\n').map((l) => l.trim());
        let found42 = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('42')) {
            found42 = i;
            break;
          }
        }
        if (found42 < 0) return false;
        // Next non-empty line should contain 'тест'
        for (let i = found42 + 1; i < lines.length; i++) {
          if (lines[i] === '') continue; // skip empty lines between
          return lines[i].includes('тест');
        }
        return false;
      },
    },
    {
      id: 'json', name: 'JSON',
      prompt: 'Верни JSON: {"color": "blue", "count": 5}',
      maxTokens: 100, jsonMode: true, weight: 25, isBuiltIn: true,
      validate: (r) => {
        try {
          const p = JSON.parse(stripCodeFences(r));
          return p.color === 'blue' && p.count === 5;
        } catch { return false; }
      },
    },
    {
      id: 'extraction', name: 'Извлечение идей',
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      prompt: `Вот текст. Извлеки из него идеи.\n\n---\n${EXTRACTION_SAMPLE_TEXT}\n---`,
      maxTokens: 4096, jsonMode: true, weight: 30, isBuiltIn: true,
      validate: (r) => {
        try {
          const json = JSON.parse(stripCodeFences(r));
          const ideas = json.ideas || json;
          if (Array.isArray(ideas) && ideas.length > 0) {
            const first = ideas[0];
            return typeof first.title === 'string' && first.title.length > 0 &&
              typeof first.summary === 'string' && first.summary.length > 0;
          }
          return false;
        } catch { return false; }
      },
    },
  ];
}

const LS_CUSTOM_TESTS_KEY = 'ideograph_custom_tests';

function loadCustomTests(): TestDefinition[] {
  try {
    const raw = localStorage.getItem(LS_CUSTOM_TESTS_KEY);
    if (!raw) return [];
    const tests: TestDefinition[] = JSON.parse(raw);
    return tests;
  } catch { return []; }
}

function saveCustomTests(tests: TestDefinition[]): void {
  localStorage.setItem(LS_CUSTOM_TESTS_KEY, JSON.stringify(tests));
}

function getActiveTests(): TestDefinition[] {
  const builtIn = getDefaultTests();
  const custom = loadCustomTests();
  return [...builtIn, ...custom];
}

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

function computeScore(passResults: Array<{ testId: string; pass: boolean }>): number {
  const tests = getActiveTests();
  let score = 0;
  for (const pr of passResults) {
    const def = tests.find(t => t.id === pr.testId);
    if (def && pr.pass) score += def.weight;
  }
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

function truncateText(text: string, maxLen: number = 300): string {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
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

  // Test config state
  private customTests: TestDefinition[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async render(): Promise<void> {
    this.settings = await getSettings();
    this.customTests = loadCustomTests();
    this.renderHTML();
    this.bindEvents();
  }

  // ============================================================
  // HTML rendering
  // ============================================================

  private renderHTML(): void {
    const s = this.settings!;
    const activeTests = getActiveTests();

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

        <!-- Configure Tests (collapsible) -->
        <div class="mt-section" id="mt-test-config-section" style="display:none;">
          <details class="mt-config-details">
            <summary class="mt-config-summary">⚙️ Настроить тесты (${activeTests.length})</summary>
            <div class="mt-config-body">
              <div id="mt-test-config-list">
                ${this.renderTestConfigList(activeTests)}
              </div>
              <div class="mt-config-actions">
                <button class="mt-btn-add" id="mt-add-test">➕ Добавить тест</button>
                <button class="primary-btn" id="mt-save-tests" style="margin-left:auto;">💾 Сохранить</button>
              </div>
            </div>
          </details>
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
                  ${activeTests.map(t => `<th>${escapeHtml(t.name)}</th>`).join('')}
                  <th>Оценка</th>
                  <th>Балл</th>
                </tr>
              </thead>
              <tbody id="mt-results-body">
                ${this.renderResultRows(activeTests)}
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

  private renderResultRows(activeTests: TestDefinition[]): string {
    const results = Array.from(this.testResults.values()).sort((a, b) => b.totalScore - a.totalScore);
    if (results.length === 0) {
      return `<tr><td colspan="${activeTests.length + 3}" class="mt-empty">Нет результатов</td></tr>`;
    }

    return results.map((r) => {
      const scoreClass = r.totalScore >= 70 ? 'high' : r.totalScore >= 40 ? 'medium' : 'low';
      const testCells = activeTests.map(t => {
        const detail = r.testResults.find(tr => tr.testId === t.id);
        if (!detail) {
          return `<td><div class="mt-result-cell"><span class="mt-result-skip">—</span></div></td>`;
        }
        return `
          <td>
            <div class="mt-result-cell">
              <span class="${detail.pass ? 'mt-result-pass' : 'mt-result-fail'}">${detail.pass ? '✅' : '❌'}</span>
              <span class="mt-result-time">${detail.timeMs}ms</span>
            </div>
          </td>
        `;
      }).join('');

      return `
        <tr class="mt-result-row" data-result-model-id="${escapeHtml(r.modelId)}" style="cursor:pointer;">
          <td>
            <div class="mt-result-model">${escapeHtml(r.modelId)}</div>
            <div class="mt-result-provider">${escapeHtml(r.provider)}</div>
          </td>
          ${testCells}
          <td data-result-model="${escapeHtml(r.modelId)}">${starsHtml(undefined)}</td>
          <td><span class="mt-result-score ${scoreClass}">${r.totalScore}</span></td>
        </tr>
        <tr class="mt-detail-row" data-detail-model-id="${escapeHtml(r.modelId)}" style="display:none;">
          <td colspan="${activeTests.length + 3}">
            <div class="mt-detail-panel">
              ${this.renderDetailPanel(r)}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  private renderDetailPanel(result: TestResult): string {
    if (result.testResults.length === 0) {
      return '<div class="mt-empty">Нет данных</div>';
    }

    return result.testResults.map(tr => {
      const responseHtml = tr.response
        ? `<div class="mt-detail-response">
            <div class="mt-detail-label">Ответ:</div>
            <pre class="mt-detail-pre" data-full-text="${escapeHtml(tr.response)}" data-truncated="${escapeHtml(truncateText(tr.response, 500))}">${escapeHtml(truncateText(tr.response, 500))}</pre>
            ${tr.response.length > 500 ? `<button class="mt-btn-toggle-full mt-btn-export">Показать полностью</button>` : ''}
          </div>`
        : '';

      const errorHtml = tr.error
        ? `<div class="mt-detail-error">⚠️ Ошибка: ${escapeHtml(tr.error)}</div>`
        : '';

      return `
        <div class="mt-detail-test-item">
          <div class="mt-detail-header">
            <span class="mt-detail-name">${escapeHtml(tr.testName)}</span>
            <span class="${tr.pass ? 'mt-result-pass' : 'mt-result-fail'}">${tr.pass ? '✅ Пройден' : '❌ Не пройден'}</span>
            <span class="mt-result-time">${tr.timeMs}мс</span>
          </div>
          <div class="mt-detail-prompt">
            <div class="mt-detail-label">Запрос:</div>
            <pre class="mt-detail-pre">${escapeHtml(tr.prompt)}</pre>
          </div>
          ${responseHtml}
          ${errorHtml}
        </div>
      `;
    }).join('');
  }

  // ============================================================
  // Test configuration rendering
  // ============================================================

  private renderTestConfigList(allTests: TestDefinition[]): string {
    const builtInTests = getDefaultTests();
    return allTests.map((t, idx) => {
      const isBuiltin = t.isBuiltIn || builtInTests.some(b => b.id === t.id);
      const badge = isBuiltin ? '<span class="mt-test-badge mt-test-badge-builtin">встроенный</span>' : '';
      const deleteBtn = isBuiltin ? '' : `<button class="mt-btn-delete" data-test-idx="${idx}">🗑</button>`;
      const readonly = isBuiltin ? 'readonly' : '';

      return `
        <div class="mt-test-config-item ${isBuiltin ? 'mt-test-config-builtin' : ''}" data-test-id="${escapeHtml(t.id)}">
          <div class="mt-test-config-header">
            <input class="mt-test-name-input" type="text" value="${escapeHtml(t.name)}" placeholder="Название теста" ${readonly} />
            ${badge}
            ${deleteBtn}
          </div>
          <textarea class="mt-test-prompt-input" placeholder="Запрос для модели..." ${readonly}>${escapeHtml(t.prompt)}</textarea>
          <div class="mt-test-config-row">
            <label class="mt-test-config-field">
              Системный промпт:
              <input class="mt-test-system-input" type="text" value="${escapeHtml(t.systemPrompt || '')}" placeholder="(необязательно)" ${readonly} />
            </label>
            <label class="mt-test-config-field">
              Вес (баллы):
              <input class="mt-test-weight-input" type="number" value="${t.weight}" min="1" max="100" ${readonly} />
            </label>
            <label class="mt-test-config-field">
              Max tokens:
              <input class="mt-test-tokens-input" type="number" value="${t.maxTokens}" min="10" max="32768" ${readonly} />
            </label>
            <label class="mt-test-config-field mt-test-config-checkbox">
              JSON:
              <input class="mt-test-json-input" type="checkbox" ${t.jsonMode ? 'checked' : ''} ${readonly} />
            </label>
          </div>
        </div>
      `;
    }).join('');
  }

  private readCustomTestsFromUI(): TestDefinition[] {
    const items = this.container.querySelectorAll('.mt-test-config-item:not(.mt-test-config-builtin)');
    const tests: TestDefinition[] = [];

    items.forEach((item) => {
      const name = (item.querySelector('.mt-test-name-input') as HTMLInputElement)?.value.trim() || 'Без названия';
      const prompt = (item.querySelector('.mt-test-prompt-input') as HTMLTextAreaElement)?.value.trim() || '';
      const systemPrompt = (item.querySelector('.mt-test-system-input') as HTMLInputElement)?.value.trim() || undefined;
      const weight = parseInt((item.querySelector('.mt-test-weight-input') as HTMLInputElement)?.value || '10', 10);
      const maxTokens = parseInt((item.querySelector('.mt-test-tokens-input') as HTMLInputElement)?.value || '200', 10);
      const jsonMode = (item.querySelector('.mt-test-json-input') as HTMLInputElement)?.checked || false;
      const id = (item as HTMLElement).dataset.testId || `custom_${Date.now()}_${tests.length}`;

      // Re-use built-in validate functions for built-in test IDs
      const builtIn = getDefaultTests().find(t => t.id === id);

      tests.push({
        id,
        name,
        prompt,
        systemPrompt,
        maxTokens: isNaN(maxTokens) ? 200 : maxTokens,
        jsonMode,
        weight: isNaN(weight) ? 10 : weight,
        validate: builtIn ? builtIn.validate : (_r) => false, // Custom tests: manual validation (user inspects response)
        isBuiltIn: false,
      });
    });

    return tests;
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

    // Result row click → toggle detail panel
    this.container.querySelector('#mt-results-body')?.addEventListener('click', (e) => {
      // Don't toggle if clicking on a star
      if ((e.target as HTMLElement).closest('.mt-star')) return;
      const row = (e.target as HTMLElement).closest('.mt-result-row') as HTMLElement | null;
      if (!row) return;
      const modelId = row.dataset.resultModelId;
      if (!modelId) return;
      const detailRow = this.container.querySelector(`tr[data-detail-model-id="${CSS.escape(modelId)}"]`) as HTMLElement | null;
      if (!detailRow) return;

      const isHidden = detailRow.style.display === 'none';
      detailRow.style.display = isHidden ? '' : 'none';
    });

    // Toggle full text in detail panel
    this.container.querySelector('#mt-results-body')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.mt-btn-toggle-full') as HTMLElement | null;
      if (!btn) return;
      const pre = btn.previousElementSibling as HTMLPreElement | null;
      if (!pre) return;
      const fullText = pre.dataset.fullText || '';
      const truncated = pre.dataset.truncated || '';
      if (btn.textContent === 'Показать полностью') {
        pre.textContent = fullText;
        btn.textContent = 'Свернуть';
      } else {
        pre.textContent = truncated;
        btn.textContent = 'Показать полностью';
      }
    });

    // --- Test config events ---
    // Add test
    this.container.querySelector('#mt-add-test')?.addEventListener('click', () => {
      const newId = `custom_${Date.now()}`;
      const newTest: TestDefinition = {
        id: newId,
        name: '',
        prompt: '',
        maxTokens: 200,
        jsonMode: false,
        weight: 10,
        validate: (_r) => false,
        isBuiltIn: false,
      };
      this.customTests.push(newTest);
      this.rerenderTestConfig();
    });

    // Delete test
    this.container.querySelector('#mt-test-config-list')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.mt-btn-delete') as HTMLElement | null;
      if (!btn) return;
      const idx = parseInt(btn.dataset.testIdx || '-1', 10);
      if (idx < 0) return;
      const allTests = getActiveTests();
      if (idx >= allTests.length) return;
      const testId = allTests[idx].id;
      this.customTests = this.customTests.filter(t => t.id !== testId);
      this.rerenderTestConfig();
    });

    // Save tests
    this.container.querySelector('#mt-save-tests')?.addEventListener('click', () => {
      this.customTests = this.readCustomTestsFromUI();
      saveCustomTests(this.customTests);
      // Show test section and config section, update results header
      this.showTestSections();
      this.showErrorCustom('✅ Пользовательские тесты сохранены');
    });
  }

  private rerenderTestConfig(): void {
    const allTests = getActiveTests();
    const listEl = this.container.querySelector('#mt-test-config-list');
    if (listEl) listEl.innerHTML = this.renderTestConfigList(allTests);
    // Update summary count
    const summary = this.container.querySelector('.mt-config-summary');
    if (summary) summary.textContent = `⚙️ Настроить тесты (${allTests.length})`;
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
      this.showTestSections();

      countEl.textContent = `Найдено: ${this.allModels.length} моделей`;
    } catch (err) {
      this.showError(`Ошибка загрузки моделей: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      btn.textContent = '📥 Загрузить модели';
      btn.removeAttribute('disabled');
    }
  }

  private showTestSections(): void {
    const section = this.container.querySelector('#mt-model-list-section') as HTMLElement | null;
    if (section) section.style.display = '';

    const testSection = this.container.querySelector('#mt-test-section') as HTMLElement | null;
    if (testSection) testSection.style.display = '';

    const configSection = this.container.querySelector('#mt-test-config-section') as HTMLElement | null;
    if (configSection) configSection.style.display = '';

    // Re-render results table header to reflect current tests
    const resultsSection = this.container.querySelector('#mt-results-section') as HTMLElement | null;
    if (resultsSection) {
      const activeTests = getActiveTests();
      const thead = resultsSection.querySelector('thead tr');
      if (thead) {
        thead.innerHTML = `
          <th>Модель</th>
          ${activeTests.map(t => `<th>${escapeHtml(t.name)}</th>`).join('')}
          <th>Оценка</th>
          <th>Балл</th>
        `;
      }
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
  // Test execution — dynamic test runner
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

    const activeTests = getActiveTests();
    // Filter tests: skip extraction if disabled
    const testsToRun = activeTests.filter(t => {
      if (t.id === 'extraction' && !this.runExtractionTest) return false;
      return true;
    });

    const providerMap = new Map<string, AIProvider>();

    const modelsToTest = this.filteredModels.filter((m) => this.selectedModelIds.has(m.id));
    const totalModels = modelsToTest.length;
    const totalSteps = totalModels * testsToRun.length;
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
          const errorResult: TestResult = {
            modelId: model.id,
            provider: model.provider,
            totalScore: 0,
            testResults: testsToRun.map(t => ({
              testId: t.id,
              testName: t.name,
              pass: false,
              timeMs: 0,
              error: `Ошибка провайдера: ${err}`,
              prompt: t.prompt,
            })),
          };
          this.testResults.set(model.id, errorResult);
          currentStep += testsToRun.length;
          this.updateProgress(model.id, `Ошибка провайдера`, currentStep, totalSteps);
          continue;
        }
      }

      const testResults: TestDetailItem[] = [];

      for (const testDef of testsToRun) {
        if (this.isCancelled) break;

        this.updateProgress(model.id, testDef.name + '...', currentStep, totalSteps);

        // Build messages
        const messages: ChatMessage[] = [];
        if (testDef.systemPrompt) {
          messages.push({ role: 'system', content: testDef.systemPrompt });
        }
        messages.push({ role: 'user', content: testDef.prompt });

        const detail: TestDetailItem = {
          testId: testDef.id,
          testName: testDef.name,
          pass: false,
          timeMs: 0,
          prompt: testDef.prompt,
        };

        try {
          const start = Date.now();
          const resp = await provider.chat(messages, {
            model: model.id,
            temperature: testDef.jsonMode ? 0 : 0,
            maxTokens: testDef.maxTokens,
            jsonMode: testDef.jsonMode,
          });
          detail.timeMs = Date.now() - start;
          detail.response = resp.content;
          detail.pass = testDef.validate(resp.content);
        } catch (err) {
          detail.timeMs = 0;
          detail.error = err instanceof Error ? err.message : String(err);
        }

        testResults.push(detail);
        currentStep++;

        // Rate limit delay
        if (s.requestDelayMs && !this.isCancelled && testDef !== testsToRun[testsToRun.length - 1]) {
          await sleep(s.requestDelayMs);
        }
      }

      // Compute score from pass results
      const totalScore = computeScore(testResults.map(tr => ({ testId: tr.testId, pass: tr.pass })));
      const result: TestResult = {
        modelId: model.id,
        provider: model.provider,
        totalScore,
        testResults,
      };
      this.testResults.set(model.id, result);

      // Save to DB
      await this.saveRating(result, undefined);

      // Update results table
      this.refreshResults(activeTests);
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

  private refreshResults(activeTests?: TestDefinition[]): void {
    const tbody = this.container.querySelector('#mt-results-body');
    if (tbody) tbody.innerHTML = this.renderResultRows(activeTests || getActiveTests());
  }

  // ============================================================
  // Rating persistence — new dynamic format
  // ============================================================

  private async saveRating(result: TestResult, userRating: number | undefined): Promise<void> {
    // Build legacy fields from dynamic results for backward compatibility
    const findTest = (id: string) => result.testResults.find(t => t.testId === id);

    const simpleTest = findTest('simple');
    const instructionTest = findTest('instruction');
    const jsonTest = findTest('json');
    const extractionTest = findTest('extraction');

    const rating: ModelRating = {
      modelId: result.modelId,
      provider: result.provider,
      testedAt: Date.now(),
      // Legacy fields
      simplePass: simpleTest?.pass ?? false,
      simpleTimeMs: simpleTest?.timeMs ?? 0,
      instructionPass: instructionTest?.pass ?? false,
      instructionTimeMs: instructionTest?.timeMs ?? 0,
      jsonPass: jsonTest?.pass ?? false,
      jsonTimeMs: jsonTest?.timeMs ?? 0,
      extractionPass: extractionTest?.pass ?? false,
      extractionTimeMs: extractionTest?.timeMs ?? 0,
      totalScore: result.totalScore,
      // New dynamic format
      testDetailsJson: JSON.stringify(result.testResults),
    };
    if (userRating !== undefined) {
      rating.userRating = userRating;
    }
    await saveModelRating(rating);
  }

  // ============================================================
  // History — show per-test results
  // ============================================================

  private async loadHistory(): Promise<void> {
    const section = this.container.querySelector('#mt-history-section') as HTMLElement;
    const listEl = this.container.querySelector('#mt-history-list') as HTMLElement;
    if (!section || !listEl) return;

    try {
      const ratings = await getAllModelRatings();
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

        // Parse test details if available
        let testBadges = '';
        if (r.testDetailsJson) {
          try {
            const details: TestDetailItem[] = JSON.parse(r.testDetailsJson);
            testBadges = details.map(d =>
              `<span class="mt-history-badge ${d.pass ? 'mt-result-pass' : 'mt-result-fail'}" title="${escapeHtml(d.testName)}">${d.pass ? '✅' : '❌'} ${escapeHtml(d.testName)}</span>`
            ).join('');
          } catch {
            // Fallback to legacy display
            testBadges = `
              <span class="mt-history-badge ${r.simplePass ? 'mt-result-pass' : 'mt-result-fail'}">Простой</span>
              <span class="mt-history-badge ${r.instructionPass ? 'mt-result-pass' : 'mt-result-fail'}">Инструкции</span>
              <span class="mt-history-badge ${r.jsonPass ? 'mt-result-pass' : 'mt-result-fail'}">JSON</span>
              ${r.extractionPass !== undefined ? `<span class="mt-history-badge ${r.extractionPass ? 'mt-result-pass' : 'mt-result-fail'}">Извлечение</span>` : ''}
            `;
          }
        } else {
          // Legacy display
          testBadges = `
            <span class="mt-history-badge ${r.simplePass ? 'mt-result-pass' : 'mt-result-fail'}">Простой</span>
            <span class="mt-history-badge ${r.instructionPass ? 'mt-result-pass' : 'mt-result-fail'}">Инструкции</span>
            <span class="mt-history-badge ${r.jsonPass ? 'mt-result-pass' : 'mt-result-fail'}">JSON</span>
            ${r.extractionPass !== undefined ? `<span class="mt-history-badge ${r.extractionPass ? 'mt-result-pass' : 'mt-result-fail'}">Извлечение</span>` : ''}
          `;
        }

        return `
          <div class="mt-history-item">
            <div class="mt-history-main">
              <span class="mt-history-model">${escapeHtml(r.modelId)}</span>
              <span class="mt-result-provider">${escapeHtml(r.provider)}</span>
              <span class="mt-history-date">${date}</span>
              ${r.userRating ? `<span class="mt-history-stars">${'★'.repeat(r.userRating)}${'☆'.repeat(5 - r.userRating)}</span>` : ''}
              <span class="mt-history-score mt-result-score ${scoreClass}">${r.totalScore}</span>
            </div>
            <div class="mt-history-tests">${testBadges}</div>
          </div>
        `;
      }).join('');
    } catch {
      listEl.innerHTML = '<div class="mt-empty">Ошибка загрузки истории</div>';
    }
  }

  // ============================================================
  // Export — include prompts and responses
  // ============================================================

  private exportResults(): void {
    const results = Array.from(this.testResults.values()).sort((a, b) => b.totalScore - a.totalScore);
    const exportData = results.map(r => ({
      modelId: r.modelId,
      provider: r.provider,
      totalScore: r.totalScore,
      tests: r.testResults.map(tr => ({
        testId: tr.testId,
        testName: tr.testName,
        pass: tr.pass,
        timeMs: tr.timeMs,
        error: tr.error || undefined,
        prompt: tr.prompt,
        response: tr.response || undefined,
      })),
    }));
    const json = JSON.stringify(exportData, null, 2);
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

  private showErrorCustom(message: string): void {
    const container = this.container.querySelector('#mt-error-container');
    if (container) {
      container.innerHTML = `<div class="mt-error mt-error-success">✅ ${escapeHtml(message)}</div>`;
    }
  }
}
