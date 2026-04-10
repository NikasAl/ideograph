// ============================================================
// Settings Modal — API keys, models, theme, preferences
// ============================================================

import { db, getSettings, updateSettings } from '../../db/index.js';
import type { Settings } from '../../db/schema.js';

export class SettingsModal {
  private modal: HTMLDivElement | null = null;

  async open(): Promise<void> {
    const s = await getSettings();

    this.modal = document.createElement('div');
    this.modal.className = 'modal-overlay';
    this.modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2>⚙️ Настройки</h2>
          <button class="icon-btn modal-close" id="btn-close">✕</button>
        </div>
        <div class="modal-body">
          <section class="settings-section">
            <h3>🤖 AI провайдеры</h3>
            <div class="setting-group">
              <label for="key-openrouter">OpenRouter API Key:</label>
              <input type="password" id="key-openrouter" class="setting-input" value="${s.providerKeys.openrouter || ''}" placeholder="sk-or-v1-..." />
            </div>
            <div class="setting-group">
              <label for="key-z-ai">z-ai API Key:</label>
              <input type="password" id="key-z-ai" class="setting-input" value="${s.providerKeys['z-ai'] || ''}" placeholder="Ваш z-ai ключ" />
            </div>
            <div class="setting-group">
              <label for="inp-zai-url">
                z-ai Base URL:
                <span class="setting-hint">Адрес API сервера z-ai (напр. http://172.25.136.193:8080/v1)</span>
              </label>
              <input type="text" id="inp-zai-url" class="setting-input" value="${s.zaiBaseUrl || ''}" placeholder="http://host:port/v1" />
            </div>
          </section>

          <section class="settings-section">
            <h3>🎯 Провайдер</h3>
            <div class="setting-group">
              <label for="sel-provider">Провайдер:</label>
              <select id="sel-provider" class="setting-select">
                <option value="openrouter" ${s.activeProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                <option value="z-ai" ${s.activeProvider === 'z-ai' ? 'selected' : ''}>z-ai</option>
              </select>
            </div>
          </section>

          <section class="settings-section">
            <h3>🧠 Модели для анализа</h3>
            <div class="setting-group">
              <label for="inp-model">
                Основная модель (извлечение идей):
                <span class="setting-hint">Текстовая модель. Извлекает идеи из текста/Markdown. Должна хорошо работать на русском.</span>
              </label>
              <input type="text" id="inp-model" class="setting-input" value="${s.activeModel}" placeholder="anthropic/claude-sonnet-4" />
            </div>
            <div class="setting-group">
              <label for="inp-ocr-model">
                OCR модель (изображение → Markdown+LaTeX):
                <span class="setting-hint">Vision модель. Конвертирует страницу изображения в текст с формулами. Средняя цена, высокая точность OCR.</span>
              </label>
              <input type="text" id="inp-ocr-model" class="setting-input" value="${s.ocrModel}" placeholder="google/gemini-2.0-flash-001" />
            </div>
            <div class="setting-group">
              <label for="inp-vlm-model">
                VLM модель (полный визуальный анализ):
                <span class="setting-hint">Vision модель для извлечения идей напрямую из изображения. Нужна для геометрии, чертежей, графиков.</span>
              </label>
              <input type="text" id="inp-vlm-model" class="setting-input" value="${s.vlmModel}" placeholder="anthropic/claude-sonnet-4" />
            </div>
            <div class="setting-group model-presets">
              <span class="preset-label">Presets — OpenRouter:</span>
              <button class="preset-btn" data-target="inp-model" data-value="anthropic/claude-sonnet-4">claude-sonnet-4</button>
              <button class="preset-btn" data-target="inp-ocr-model" data-value="google/gemini-2.0-flash-001">gemini-flash (OCR)</button>
              <button class="preset-btn" data-target="inp-vlm-model" data-value="anthropic/claude-sonnet-4">claude-sonnet-4 (VLM)</button>
              <button class="preset-btn" data-target="inp-vlm-model" data-value="google/gemini-2.5-pro-preview">gemini-pro (VLM)</button>
              <button class="preset-btn" data-target="inp-model" data-value="openai/gpt-4o-mini">gpt-4o-mini</button>
              <button class="preset-btn" data-target="inp-ocr-model" data-value="openai/gpt-4o">gpt-4o (OCR)</button>
            </div>
            <div class="setting-group model-presets">
              <span class="preset-label">Presets — z-ai:</span>
              <button class="preset-btn" data-target="inp-model" data-value="GLM-4.7-Flash">GLM-4.7-Flash</button>
              <button class="preset-btn" data-target="inp-ocr-model" data-value="GLM-4.6V-Flash">GLM-4.6V-Flash (OCR)</button>
              <button class="preset-btn" data-target="inp-vlm-model" data-value="GLM-4.6V-Flash">GLM-4.6V-Flash (VLM)</button>
            </div>
          </section>

          <section class="settings-section">
            <h3>🔄 Fallback-модели</h3>
            <div class="setting-group">
              <label for="inp-fallback">
                Резервные модели (через запятую):
                <span class="setting-hint">Если основная модель вернёт ошибку 429 (rate limit) или 5xx — автоматически переключится на следующую из списка. Применяется ко всем режимам (текст, OCR, VLM).</span>
              </label>
              <input type="text" id="inp-fallback" class="setting-input" value="${s.fallbackModels || ''}" placeholder="google/gemma-4-26b-a4b-it:free,openai/gpt-4o-mini,meta-llama/llama-3.1-70b-instruct" />
            </div>
          </section>

          <section class="settings-section">
            <h3>⏱️ Задержка между запросами</h3>
            <div class="setting-group">
              <label for="inp-delay">
                Пауза между API-запросами (мс):
                <span class="setting-hint">Задержка между последовательными запросами к API. Помогает избежать rate-limit (ошибка 429). Установите 1000–5000 мс для бесплатных моделей с жёсткими лимитами.</span>
              </label>
              <input type="number" id="inp-delay" class="setting-input" value="${s.requestDelayMs ?? 0}" min="0" max="60000" step="500" placeholder="0" />
            </div>
          </section>

          <section class="settings-section">
            <h3>🎨 Оформление</h3>
            <div class="setting-group">
              <label for="sel-theme">Тема:</label>
              <select id="sel-theme" class="setting-select">
                <option value="system" ${s.theme === 'system' ? 'selected' : ''}>Системная</option>
                <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Светлая</option>
                <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Тёмная</option>
              </select>
            </div>
          </section>

          <section class="settings-section">
            <h3>📊 Детализация</h3>
            <div class="setting-group">
              <label for="sel-detail">Уровень:</label>
              <select id="sel-detail" class="setting-select">
                <option value="low" ${s.extractionDetail === 'low' ? 'selected' : ''}>Низкая</option>
                <option value="medium" ${s.extractionDetail === 'medium' ? 'selected' : ''}>Средняя</option>
                <option value="high" ${s.extractionDetail === 'high' ? 'selected' : ''}>Высокая</option>
              </select>
            </div>
          </section>
        </div>
        <div class="modal-footer">
          <button class="secondary-btn" id="btn-cancel">Отменить</button>
          <button class="primary-btn" id="btn-save">💾 Сохранить</button>
        </div>
      </div>`;

    document.body.appendChild(this.modal);
    this.bindEvents(s);
  }

  private close(): void { this.modal?.remove(); this.modal = null; }

  private bindEvents(current: Settings): void {
    // Only close via explicit buttons — no overlay click close to prevent
    // accidental closing when pasting, focusing inputs, or context menus
    this.modal?.querySelector('#btn-close')?.addEventListener('click', () => this.close());
    this.modal?.querySelector('#btn-cancel')?.addEventListener('click', () => this.close());

    // Prevent any click inside the modal card from closing
    this.modal?.querySelector('.modal')?.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    }, true);

    // Preset buttons — stop propagation to prevent any bubbling issues
    this.modal?.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = (btn as HTMLElement).dataset.target;
        const value = (btn as HTMLElement).dataset.value;
        if (target && value) {
          (this.modal!.querySelector(`#${target}`) as HTMLInputElement).value = value;
        }
      });
    });

    this.modal?.querySelector('#btn-save')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const el = (id: string) => this.modal!.querySelector(id) as HTMLInputElement | HTMLSelectElement;
      await updateSettings({
        activeProvider: el('#sel-provider').value as Settings['activeProvider'],
        activeModel: el('#inp-model').value || current.activeModel,
        ocrModel: el('#inp-ocr-model').value || current.ocrModel,
        vlmModel: el('#inp-vlm-model').value || current.vlmModel,
        fallbackModels: el('#inp-fallback').value || current.fallbackModels,
        requestDelayMs: parseInt(el('#inp-delay').value, 10) || 0,
        theme: el('#sel-theme').value as Settings['theme'],
        extractionDetail: el('#sel-detail').value as Settings['extractionDetail'],
        zaiBaseUrl: el('#inp-zai-url').value || undefined,
        providerKeys: {
          ...current.providerKeys,
          openrouter: el('#key-openrouter').value || undefined,
          'z-ai': el('#key-z-ai').value || undefined,
        },
      });
      document.dispatchEvent(new CustomEvent('settings-changed'));
      this.close();
    });
  }
}
