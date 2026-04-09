// ============================================================
// Settings Modal — API keys, theme, preferences
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
          </section>
          <section class="settings-section">
            <h3>🎯 Провайдер и модель</h3>
            <div class="setting-group">
              <label for="sel-provider">Провайдер:</label>
              <select id="sel-provider" class="setting-select">
                <option value="openrouter" ${s.activeProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                <option value="z-ai" ${s.activeProvider === 'z-ai' ? 'selected' : ''}>z-ai</option>
              </select>
            </div>
            <div class="setting-group">
              <label for="inp-model">Модель:</label>
              <input type="text" id="inp-model" class="setting-input" value="${s.activeModel}" placeholder="anthropic/claude-sonnet-4" />
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
          <button class="primary-btn" id="btn-save">💾 Сохранить</button>
        </div>
      </div>`;

    document.body.appendChild(this.modal);
    this.bindEvents(s);
  }

  private close(): void { this.modal?.remove(); this.modal = null; }

  private bindEvents(current: Settings): void {
    this.modal?.querySelector('#btn-close')?.addEventListener('click', () => this.close());
    this.modal?.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });

    this.modal?.querySelector('#btn-save')?.addEventListener('click', async () => {
      const el = (id: string) => this.modal!.querySelector(id) as HTMLInputElement | HTMLSelectElement;
      await updateSettings({
        activeProvider: el('#sel-provider').value as Settings['activeProvider'],
        activeModel: el('#inp-model').value || current.activeModel,
        theme: el('#sel-theme').value as Settings['theme'],
        extractionDetail: el('#sel-detail').value as Settings['extractionDetail'],
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
