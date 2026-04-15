# Идеограф — План рефакторинга архитектуры

> **Дата:** 2026-04-15  
> **Базовый коммит:** `bb2ad61`  
> **Цель:** Введение сервисного слоя, устранение дублирования, декомпозиция god-файлов, стандартизация паттернов

---

## Содержание

- [Контекст и мотивация](#1-контекст-и-мотивация)
- [Целевая архитектура](#2-целевая-архитектура)
- [Инварианты](#3-инварианты)
- [Фаза 1: shared/ — общие утилиты и константы](#фаза-1-shared--общие-утилиты-и-константы)
- [Фаза 2: services/ — сервисный слой](#фаза-2-services--сервисный-слой)
- [Фаза 3: Миграция UI на services/](#фаза-3-миграция-ui-на-services)
- [Фаза 4: Декомпозиция god-файлов](#фаза-4-декомпозиция-god-файлов)
- [Фаза 5: Extraction без прямых DB-записей](#фаза-5-extraction-без-прямых-db-записей)
- [Фаза 6: Стандартизация и очистка](#фаза-6-стандартизация-и-очистка)
- [Проверочный чеклист](#проверочный-чеклист)

---

## 1. Контекст и мотивация

### Текущая структура (9 625 строк TS)

```
src/
├── background/          # ai-client.ts, index.ts
├── db/                  # schema.ts, index.ts
├── extraction/          # pipeline.ts, toc-extractor.ts, text-extractor.ts, ...
│   └── prompts/         # extract-ideas.ts, build-relations.ts, ...
├── types/               # djvujs-dist.d.ts
└── ui/
    ├── app.ts           # SPA-роутер
    ├── components/      # 7 компонентов (973–1351 строк)
    ├── utils/           # file-store.ts, native-messaging.ts, ...
    └── styles/          # global.css, themes/, components/
```

### Ключевые проблемы (из анализа архитектуры)

| # | Проблема | Серьёзность | Затронутые файлы |
|---|----------|-------------|-----------------|
| 1 | UI напрямую импортирует extraction/ и background/ | **Критично** | 6 из 7 UI-компонентов |
| 2 | Бизнес-логика встроена в UI-компоненты | **Критично** | idea-list.ts, analysis-panel.ts, toc-panel.ts, model-test.ts |
| 3 | Extraction пишет напрямую в IndexedDB | **Средне** | pipeline.ts, toc-extractor.ts |
| 4 | God-файлы (>800 строк) | **Средне** | model-test.ts, idea-graph.ts, idea-list.ts, toc-extractor.ts, pipeline.ts |
| 5 | Дублирование кода (~200 строк) | **Средне** | 10 паттернов в 8+ файлах |
| 6 | localStorage + IndexedDB (несогласованность) | **Низко** | toc-panel.ts, model-test.ts |
| 7 | Мёртвый код | **Низко** | file-access.ts, vite-алиасы, неиспользуемые импорты |
| 8 | Несогласованная обработка ошибок | **Низко** | alert(), пустые catch, console.warn |

---

## 2. Целевая архитектура

### Структура после рефакторинга

```
src/
├── background/              # Без изменений
│   ├── ai-client.ts
│   └── index.ts
├── db/                      # Без изменений
│   ├── index.ts
│   └── schema.ts
├── extraction/              # Чистые функции (без прямых DB-записей)
│   ├── pipeline.ts          # Возвращает результат, не пишет в DB
│   ├── toc-extractor.ts     # Разбивается на модули
│   ├── text-extractor.ts
│   ├── djvu-extractor.ts
│   ├── mode-detector.ts
│   ├── vlm-extractor.ts
│   └── prompts/
├── shared/                  # НОВЫЙ: общие утилиты
│   ├── utils.ts             # sleep(), esc(), blobToBase64()
│   ├── constants.ts         # STATUS_LABELS, FAM_LABELS, TYPE_ICONS, DEPTH_LABELS
│   └── types/
│       └── chrome.d.ts      # showOpenFilePicker, File System Access API, chrome.runtime
├── services/                # НОВЫЙ: оркестрационный слой
│   ├── provider-factory.ts  # createProvider(), getModelConfig()
│   ├── analysis-service.ts  # runAnalysis(), cancelAnalysis()
│   ├── toc-service.ts       # extractTOC(), summarizeChapter(), calibrateOffset()
│   ├── chat-service.ts      # sendChatMessage(), buildSystemPrompt(), getChatHistory()
│   └── model-service.ts     # testModel(), fetchModels(), rateModel()
├── ui/
│   ├── app.ts               # Без изменений
│   ├── components/          # Только импорт из services/, db/, shared/
│   │   ├── analysis-panel/
│   │   │   ├── index.ts     # UI-рендеринг и события
│   │   │   └── log.ts       # addLogEntry(), форматирование
│   │   ├── idea-list/
│   │   │   ├── index.ts     # Карточки, фильтры, редактирование
│   │   │   ├── chat-panel.ts # UI чата (делегирует в chat-service)
│   │   │   ├── filters.ts   # Логика фильтрации
│   │   │   └── markdown.ts  # renderMarkdown() с KaTeX
│   │   ├── idea-graph/
│   │   │   ├── index.ts     # D3-визуализация
│   │   │   ├── layout.ts    # computeDimensions, tree layout
│   │   │   ├── colors.ts    # propagateHue, node colors
│   │   │   └── navigation.ts # keyboard nav, autopan
│   │   ├── model-test/
│   │   │   ├── index.ts     # Тест-раннер, отображение
│   │   │   ├── results.ts   # Таблица результатов, экспорт
│   │   │   ├── custom-tests.ts # CRUD пользовательских тестов
│   │   │   └── history.ts   # История запусков
│   │   ├── toc-panel.ts
│   │   ├── book-list.ts
│   │   └── settings-modal.ts
│   ├── utils/
│   │   ├── file-store.ts    # Без изменений
│   │   ├── native-messaging.ts # Без изменений
│   │   └── reader-integration.ts # Без изменений
│   └── styles/
└── types/
    └── djvujs-dist.d.ts
```

### Правило зависимостей

```
ui/components/  →  services/, db/, shared/
services/       →  extraction/, background/, db/, shared/
extraction/     →  db/schema.ts (только типы!), shared/
background/     →  db/schema.ts (только типы!)
db/             →  (только schema.ts)
shared/         →  (нет зависимостей от src/)
```

**Строго запрещено:** `ui/components/*` импортировать из `extraction/*` или `background/*`.

---

## 3. Инварианты

Следующие принципы НЕДОПУСТИМО нарушать при рефакторинге:

1. **Поведение не меняется** — каждый коммит должен сохранять 100% функциональность. Пользователь не должен заметить разницы.
2. **Билд проходит** — `npm run build` должен компилироваться без ошибок после каждого шага.
3. **DB-схема не меняется** — рефакторинг не трогает `db/schema.ts` и структуру IndexedDB.
4. **Инкрементальность** — каждый шаг — отдельный коммит. Можно остановиться после любого шага.
5. **Нет новых зависимостей** — не добавлять npm-пакеты без явной необходимости.
6. **Сохранение нумерации строк** — при разбиении файлов используй barrel-exports (index.ts), чтобы не ломать импорты.

---

## Фаза 1: shared/ — общие утилиты и константы

**Цель:** Вынести дублирующийся код в `src/shared/`.  
**Риск:** Низкий.  
**Коммиты:** 3-4.

### Шаг 1.1: `src/shared/utils.ts`

Создать `src/shared/utils.ts` с общими утилитами:

```typescript
/** Задержка в миллисекундах */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** HTML-экранирование текста */
export function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/** HTML-экранирование для атрибутов (single-quote safe) */
export function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Конвертация Blob/File в base64 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // data:image/png;base64,... → выделяем только base64 часть
      resolve(result.split(',')[1] ?? result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
```

**Затронутые файлы:**
- `src/extraction/text-extractor.ts` — удалить `blobToBase64`, импортировать из shared
- `src/extraction/djvu-extractor.ts` — удалить `imageDataToBase64` (то же самое), использовать `blobToBase64` из shared
- `src/extraction/ai-client.ts` — удалить `sleep()`, импортировать
- `src/extraction/pipeline.ts` — удалить `sleep()`, импортировать
- `src/extraction/toc-extractor.ts` — удалить `sleep()`, импортировать
- `src/ui/components/model-test.ts` — удалить `sleep()`, импортировать
- `src/ui/components/analysis-panel.ts` — удалить `esc()`, импортировать
- `src/ui/components/book-list.ts` — удалить `esc()`, импортировать
- `src/ui/components/idea-list.ts` — удалить `esc()`, `escAttr()`, импортировать
- `src/ui/components/toc-panel.ts` — удалить `esc()`, импортировать

### Шаг 1.2: `src/shared/constants.ts`

Вынести дублирующиеся константы:

```typescript
import type { IdeaStatus, Familiarity, IdeaType, IdeaDepth } from '../db/schema.js';

/** Лейблы для статусов идей */
export const STATUS_LABELS: Record<IdeaStatus, string> = {
  unseen: 'Не просмотрена',
  in_progress: 'В процессе',
  mastered: 'Освоена',
  applied: 'Применяю',
  confused: 'Не понятно',
};

/** Лейблы для знакомства */
export const FAM_LABELS: Record<Familiarity, string> = {
  unknown: 'Не знаю',
  heard: 'Слышал',
  known: 'Знаю',
  new: 'Новая',
};

/** Иконки для типов идей */
export const TYPE_ICONS: Record<IdeaType, string> = {
  definition: '◇',
  method: '⚙',
  theorem: '▷',
  insight: '💡',
  example: '▶',
  analogy: '⇔',
};

/** Лейблы для глубины идей */
export const DEPTH_LABELS: Record<IdeaDepth, string> = {
  basic: 'Базовая',
  medium: 'Средняя',
  advanced: 'Продвинутая',
};

/** CSS-классы для цветов статусов */
export const STAT_COLORS: Record<IdeaStatus, string> = {
  unseen: 'stat-unseen',
  in_progress: 'stat-in-progress',
  mastered: 'stat-mastered',
  applied: 'stat-applied',
  confused: 'stat-confused',
};
```

**Затронутые файлы:**
- `src/ui/components/idea-list.ts` — удалить локальные `TYPE_ICONS`, `DEPTH_LABELS`, `STAT_COLORS`, `STATUS_LABELS`, `FAM_LABELS`
- `src/ui/components/idea-graph.ts` — удалить локальные `STATUS_LABELS`, `FAM_LABELS` (убедиться что значения совпадают, если нет — унифицировать)
- `src/ui/components/model-test.ts` — проверить наличие дубликатов

### Шаг 1.3: `src/shared/types/chrome.d.ts`

Типы для Chrome Extension API и File System Access API:

```typescript
/** File System Access API — глобальные типы */
interface Window {
  showOpenFilePicker?(options?: {
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
    multiple?: boolean;
  }): Promise<FileSystemFileHandle[]>;
}

/** Chrome runtime extension */
interface ChromeRuntime {
  sendMessage: chrome.runtime.RuntimeStatic['sendMessage'];
  connect: chrome.runtime.RuntimeStatic['connect'];
}
```

**Затронутые файлы:**
- `src/ui/components/book-list.ts` — удалить касты `(window as unknown as { showOpenFilePicker: ... })`
- `src/ui/utils/file-store.ts` — удалить касты `(window as unknown as { showOpenFilePicker: ... })`
- `src/ui/utils/native-messaging.ts` — удалить каст `(window as any).chrome?.runtime`

### Шаг 1.4: Удалить мёртвый код

- Удалить `src/ui/utils/file-access.ts` (35 строк, нигде не импортируется)
- Удалить неиспользуемые алиасы из `vite.config.ts` (строки с `resolve.alias`)
- Удалить неиспользуемые импорты `LLMExtractedIdea`, `LLMRelation` из `src/background/ai-client.ts`

---

## Фаза 2: services/ — сервисный слой

**Цель:** Создать оркестрационный слой между UI и extraction/background.  
**Риск:** Низкий (создание нового кода, без изменения существующего).  
**Коммиты:** 5.

### Шаг 2.1: `src/services/provider-factory.ts`

Централизованная фабрика провайдеров. Вынести общую логику из UI-компонентов:

```typescript
import { getSettings } from '../db/index.js';
import { createProvider, parseFallbackModels } from '../background/ai-client.js';
import type { AIProvider } from '../background/ai-client.js';

/** Создать провайдер с текущими настройками */
export async function createActiveProvider(): Promise<{
  provider: AIProvider;
  settings: Awaited<ReturnType<typeof getSettings>>;
} | null> {
  const settings = await getSettings();
  const apiKey = settings.providerKeys[settings.activeProvider];
  if (!apiKey) return null;
  const provider = createProvider(settings.activeProvider, apiKey, {
    zaiBaseUrl: settings.zaiBaseUrl,
  });
  return { provider, settings };
}

/** Получить конфигурацию моделей из настроек */
export async function getModelConfig() {
  const settings = await getSettings();
  return {
    model: settings.activeModel,
    ocrModel: settings.ocrModel,
    vlmModel: settings.vlmModel,
    fallbackModels: parseFallbackModels(settings.fallbackModels),
    requestDelayMs: settings.requestDelayMs,
    relationsChunkSize: settings.relationsChunkSize ?? 40,
  };
}
```

### Шаг 2.2: `src/services/analysis-service.ts`

Инкапсулировать всю логику запуска анализа:

```typescript
import type { LLMLogEntry, PipelineResult } from '../extraction/pipeline.js';
import { readFileAsArrayBuffer } from '../ui/utils/file-store.js';

export interface AnalysisRunOptions {
  bookId: string;
  pageFrom: number;
  pageTo: number;
  mode: 'text' | 'ocr' | 'vlm';
  detail: 'low' | 'medium' | 'high';
  signal: AbortSignal;
  onProgress: (msg: string, pct: number) => void;
  onLogEntry: (entry: LLMLogEntry) => void;
}

/** Запустить анализ. Возвращает результат или бросает ошибку. */
export async function runAnalysis(options: AnalysisRunOptions): Promise<PipelineResult>;

/** Проверить доступность файла для анализа */
export async function ensureAnalysisFileAccess(bookId: string): Promise<boolean>;
```

Внутри `runAnalysis`:
1. Вызвать `ensureFileAccess(bookId)` 
2. Вызвать `createActiveProvider()` — если null, бросить ошибку с сообщением
3. Вызвать `getModelConfig()`
4. Прочитать файл через `readFileAsArrayBuffer()`
5. Вызвать `runPipeline()` с параметрами
6. Вернуть `PipelineResult`

**Источники логики для переноса:**
- `analysis-panel.ts:startAnalysis()` строки ~334-421 — основная логика
- `analysis-panel.ts:render()` строки ~39-122 — предварительная оценка текстового слоя

### Шаг 2.3: `src/services/chat-service.ts`

Вынести AI-чат из idea-list.ts:

```typescript
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatSendOptions {
  ideaId: string;
  userMessage: string;
  bookId: string;
  onChunk?: (text: string) => void;
}

/** Отправить сообщение в чат об идеи */
export async function sendChatMessage(options: ChatSendOptions): Promise<string>;

/** Загрузить историю чата */
export async function loadChatHistory(ideaId: string): Promise<ChatMessage[]>;

/** Построить системный промпт для чата об идеи */
export function buildIdeaSystemPrompt(idea: Idea, bookTitle: string, chapterTitle?: string): string;
```

**Источники логики для переноса:**
- `idea-list.ts:sendChatMessage()` — ~80 строк
- `idea-list.ts:buildSystemPrompt()` — ~60 строк
- `idea-list.ts` — загрузка/сохранение чата через IndexedDB

### Шаг 2.4: `src/services/toc-service.ts`

Вынести логику работы с TOC из toc-panel.ts:

```typescript
export interface TOCExtractOptions {
  bookId: string;
  pdfData: ArrayBuffer;
  mode: 'text' | 'ocr' | 'vlm';
  signal: AbortSignal;
  onProgress: (msg: string) => void;
}

/** Извлечь оглавление */
export async function extractTOC(options: TOCExtractOptions): Promise<TOCEntry[]>;

/** Суммаризировать главы */
export async function summarizeChapter(bookId: string, chapterId: string, signal: AbortSignal): Promise<string>;

/** Калибровать page offset */
export async function calibrateOffset(bookId: string, newOffset: number): Promise<void>;
```

**Источники логики для переноса:**
- `toc-panel.ts:handleExtract()` — создание провайдера и вызов extractTOC
- `toc-panel.ts:handleSummarize()` — вызов summarizeTOCChapters

### Шаг 2.5: `src/services/model-service.ts`

Вынести логику тестирования моделей из model-test.ts:

```typescript
/** Получить список моделей из активного провайдера */
export async function fetchModels(): Promise<ModelInfo[]>;

/** Запустить один тест для модели */
export async function runModelTest(model: string, test: TestCase): Promise<TestResult>;

/** Сохранить оценку модели */
export async function rateModel(modelId: string, provider: string, rating: number): Promise<void>;
```

**Источники логики для переноса:**
- `model-test.ts:fetchOpenRouterModels()` — дублирует OpenRouterProvider.listModels
- `model-test.ts:runSingleTest()` — выполнение теста
- `model-test.ts` — сохранение в IndexedDB через db.saveModelRating

---

## Фаза 3: Миграция UI на services/

**Цель:** Переписать UI-компоненты, чтобы они использовали services/ вместо прямых импортов.  
**Риск:** Средний (изменение существующего кода, но пошагово).  
**Коммиты:** 5 (по одному на компонент).

### Общий паттерн миграции для каждого компонента

Для каждого UI-компонента:

1. **Заменить прямые импорты** из `extraction/*` и `background/*` на импорты из `services/*`
2. **Удалить локальную бизнес-логику** (создание провайдера, вызов pipeline, построение промптов)
3. **Вызвать соответствующие service-функции** вместо прямых вызовов
4. **Сохранить UI-логику** (рендеринг DOM, обработку событий, стили) без изменений
5. **Проверить билд** — `npm run build` без ошибок
6. **Протестировать вручную** — функциональность не изменилась

### Шаг 3.1: `analysis-panel.ts`

**До:**
```typescript
import { createProvider, parseFallbackModels } from '../../background/ai-client.js';
import { runPipeline } from '../../extraction/pipeline.js';
import { evaluateTextLayerMultiple } from '../../extraction/mode-detector.js';
import { extractTextFromPDFPage } from '../../extraction/text-extractor.js';
// ... ~30 строк логики создания провайдера и вызова pipeline
```

**После:**
```typescript
import { runAnalysis, ensureAnalysisFileAccess } from '../../services/analysis-service.js';
// ... вызов runAnalysis(options) вместо прямого runPipeline()
```

**Что убрать из компонента:**
- Импорты: `createProvider`, `parseFallbackModels`, `runPipeline`, `LLMLogEntry`, `PipelineOptions`
- Локальный код: создание `AbortController`, вызов `createProvider()`, построение `PipelineOptions`, вызов `runPipeline()`
- Сохранить: `addLogEntry()`, `render()`, `bindEvents()`, `repreview()`, прогресс-бар UI

**Примечание:** Предпросмотр текстового слоя (`evaluateTextLayerMultiple`, `extractTextFromPDFPage`) можно оставить в компоненте, т.к. это UI-операция (предпросмотр), а не часть пайплайна. Либо вынести в `analysis-service.ts` как отдельную функцию `previewTextQuality()`.

### Шаг 3.2: `toc-panel.ts`

**До:**
```typescript
import { createProvider } from '../../background/ai-client.js';
import { extractTOC, summarizeTOCChapters } from '../../extraction/toc-extractor.js';
// ... локальное создание провайдера и вызовы
```

**После:**
```typescript
import { extractTOC as serviceExtractTOC, summarizeChapter } from '../../services/toc-service.js';
// ... вызов serviceExtractTOC() вместо прямого extractTOC()
```

**Что убрать:**
- Импорты: `createProvider` из background, `extractTOC`, `summarizeTOCChapters` из extraction
- Локальный код: создание провайдера в `handleExtract()` и `handleSummarize()`

### Шаг 3.3: `idea-list.ts`

**До:**
```typescript
import { createProvider } from '../../background/ai-client.js';
import { assignChapterIds } from '../../extraction/toc-extractor.js';
// ... sendChatMessage() с createProvider(), buildSystemPrompt()
```

**После:**
```typescript
import { sendChatMessage, loadChatHistory } from '../../services/chat-service.js';
import { assignChapterIds } from '../../services/toc-service.js'; // или shared
```

**Что убрать:**
- `sendChatMessage()` метод класса (~80 строк) — заменить на вызов `chatService.sendChatMessage()`
- `buildSystemPrompt()` метод класса (~60 строк) — перенесён в `chat-service.ts`
- Локальный `createProvider()` вызов

**Сохранить:**
- `renderMarkdown()` с KaTeX — на этом этапе оставляем в компоненте (будет извлечён в Фазе 4)
- Фильтры, сортировка, рендеринг карточек, рейтинги, редактирование

### Шаг 3.4: `model-test.ts`

**До:**
```typescript
import { createProvider } from '../../background/ai-client.js';
// ... fetchOpenRouterModels() — дубликат логики из ai-client.ts
// ... EXTRACTION_SYSTEM_PROMPT — дубликат из prompts/extract-ideas.ts
```

**После:**
```typescript
import { fetchModels, runModelTest, rateModel } from '../../services/model-service.js';
// ... вызовы service-функций вместо локальной реализации
```

**Что убрать:**
- Локальный `fetchOpenRouterModels()` — использовать `model-service.fetchModels()`
- Локальный `EXTRACTION_SYSTEM_PROMPT` — импортировать из `extraction/prompts/extract-ideas.ts`

### Шаг 3.5: `book-list.ts`

**До:**
```typescript
const textExtractor = await import('../../extraction/text-extractor.js');
const modeDetector = await import('../../extraction/mode-detector.js');
const djvuExtractor = await import('../../extraction/djvu-extractor.js');
```

**После:** Оставить динамические импорты text-extractor и djvu-extractor (они нужны для подсчёта страниц и предпросмотра, это не бизнес-логика пайплайна). Можно вынести в helper-функцию в `shared/utils.ts` или оставить как есть.

**Минимальное изменение:** только убрать `mode-detector` прямые вызовы если они есть, либо оставить (evaluateTextLayer — это UI-операция).

### Шаг 3.6: `idea-graph.ts`

**Что изменить:**
- Импорт `assignChapterIds` из `toc-extractor.ts` → перенести в `shared/` или `services/`
- `assignChapterIds` — это чистая функция, не требует провайдера. Лучше вынести в `shared/chapter-utils.ts` или оставить в `toc-extractor.ts` и импортировать через `services/toc-service.ts` (re-export).

---

## Фаза 4: Декомпозиция god-файлов

**Цель:** Разбить файлы >800 строк на модули с единственной ответственностью.  
**Риск:** Средний.  
**Коммиты:** 5 (по одному на файл).

### Общий подход: barrel-exports

Для каждого разбитого компонента создать директорию с `index.ts` (barrel-export), чтобы существующие импорты не сломались:

```typescript
// src/ui/components/idea-list/index.ts
export { IdeaListView } from './index.js';
// Старый импорт `from '../../ui/components/idea-list.js'` продолжит работать
// благодаря barrel-export (если в tsconfig/vite настроен resolve для .ts → ./index.ts)
```

> **Важно:** Vite и TypeScript резолвят `import from './idea-list.js'` → `./idea-list/index.js`. Это сохраняет обратную совместимость.

### Шаг 4.1: `model-test.ts` (1351 строк) → `model-test/`

```
src/ui/components/model-test/
├── index.ts          # ModelTestView — рендеринг, событийные обработчики (~300 строк)
├── results.ts        # displayResults(), exportResults(), таблица результатов (~250 строк)
├── custom-tests.ts   # CRUD пользовательских тестов, localStorage→IndexedDB миграция (~200 строк)
├── history.ts        # история запусков, очистка (~150 строк)
└── test-runner.ts    # runSingleTest(), runAllTests(), evaluateResponse() (~300 строк)
```

**Критерии разделения:**
- `index.ts` — только рендеринг DOM, `render()`, `bindEvents()`, фильтры
- `test-runner.ts` — чистые функции выполнения тестов (можно будет тестировать без DOM)
- `results.ts` — генерация HTML таблиц результатов, экспорт
- `custom-tests.ts` — всё что связано с пользовательскими тестами
- `history.ts` — всё что связано с историей

### Шаг 4.2: `idea-graph.ts` (1280 строк) → `idea-graph/`

```
src/ui/components/idea-graph/
├── index.ts          # IdeaGraphView — render(), initD3(), updateGraph() (~400 строк)
├── layout.ts         # computeDimensions(), wrapText(), nodeSize (~150 строк)
├── colors.ts         # propagateHue(), getNodeColor(), status colors (~100 строк)
└── navigation.ts     # keyboard navigation, autopan, fitView, zoom (~200 строк)
```

**Критерии разделения:**
- `layout.ts` — чистые функции вычисления размеров и обёртки текста
- `colors.ts` — чистые функции получения цветов (нет зависимости от D3)
- `navigation.ts` — логика навигации (зависит от D3 zoom, но выделена)
- `index.ts` — D3 enter/update/exit, тултипы, легенда, основные методы

### Шаг 4.3: `idea-list.ts` (973 строки) → `idea-list/`

```
src/ui/components/idea-list/
├── index.ts          # IdeaListView — render(), bindEvents(), card rendering (~400 строк)
├── chat-panel.ts     # toggleChat(), renderChatMessages(), UI чата (~200 строк)
├── filters.ts        # applyFilters(), buildTocPaths(), sorting (~150 строк)
└── markdown.ts       # renderMarkdown() с KaTeX + marked (~60 строк)
```

**Критерии разделения:**
- `markdown.ts` — `renderMarkdown()` полностью (без зависимости от состояния компонента)
- `filters.ts` — `buildTocPaths()`, логика фильтрации и сортировки
- `chat-panel.ts` — UI чата: render, toggle, scroll (делегирует в chat-service)
- `index.ts` — рендеринг карточек, рейтинги, редактирование, контекст

### Шаг 4.4: `toc-extractor.ts` (905 строк) — частичное разбиение

```
src/extraction/
├── toc-extractor.ts      # extractTOC(), extractTOCFromOutline() (~400 строк)
├── toc-hierarchy.ts      # inferHierarchyFromFlat(), buildTree() (~200 строк)
└── toc-chapter-mapper.ts # assignChapterIds(), computePageRanges(), findChapterForPage() (~200 строк)
```

**Критерии разделения:**
- `toc-hierarchy.ts` — чистая эвристика, не требует AI-провайдера
- `toc-chapter-mapper.ts` — чистые функции работы с главами
- `toc-extractor.ts` — AI-зависимая логика (вызовы провайдера)

### Шаг 4.5: `pipeline.ts` (827 строк) — частичное разбиение

```
src/extraction/
├── pipeline.ts              # runPipeline() — основная оркестрация (~400 строк)
├── pipeline-persist.ts      # savePartialIdeas(), logAnalysis(), updateProgress() (~200 строк)
└── pipeline-chunking.ts     # finalizeIdeas(), chunkIdeasForRelations() (~150 строк)
```

**Критерии разделения:**
- `pipeline-persist.ts` — все операции с IndexedDB (bulkPut, update, add в analysisLog)
- `pipeline-chunking.ts` — чистые функции разбиения идей на чанки
- `pipeline.ts` — чистая оркестрация (вызовы extraction, chunking, persist)

---

## Фаза 5: Extraction без прямых DB-записей

**Цель:** Функции extraction/ возвращают результаты, не пишут в DB напрямую.  
**Риск:** Высокий (меняется контракт функций).  
**Коммиты:** 2-3.

### Шаг 5.1: `pipeline.ts` — убрать прямые DB-записи

**Текущее поведение:**
```typescript
// Внутри runPipeline():
await db.ideas.bulkPut(dedupedIdeas);
await db.relations.bulkPut(allRelations);
await db.books.update(bookId, { lastAnalyzedPage: pageTo });
await db.analysisLog.add({ ... });
```

**Целевое поведение:**
- `runPipeline()` возвращает `PipelineResult` (уже делает) + side-effect данные:
  ```typescript
  interface PipelineResult {
    ideas: Idea[];
    relations: Relation[];
    mode: ExtractionMode;
    pagesProcessed: number;
    textLayerReport?: ...;
    // НОВОЕ: данные для персистенции
    persistence: {
      ideas: Idea[];
      relations: Relation[];
      bookUpdate: { lastAnalyzedPage: number };
      analysisLog: Omit<AnalysisLog, 'id'>;
    };
  }
  ```
- `analysis-service.ts` вызывает `db.ideas.bulkPut()` после получения результата

**Миграция:**
1. Добавить `persistence` поле в `PipelineResult`
2. Перенести DB-операции из pipeline в `analysis-service.ts:runAnalysis()`
3. Внутри pipeline оставить только `pageCache.put()` (кэширование — это часть extraction)
4. Сохранить `updateLastAnalyzedPage()` внутри pipeline (для resume support)

### Шаг 5.2: `toc-extractor.ts` — убрать прямые DB-записи

**Текущее:**
```typescript
await db.books.update(bookId, { tableOfContents: toc });
```

**Целевое:** `extractTOC()` возвращает `TOCEntry[]`, вызывающий (toc-service) сохраняет в DB.

---

## Фаза 6: Стандартизация и очистка

**Цель:** Устранить мелкие несоответствия.  
**Риск:** Низкий.  
**Коммиты:** 3-4.

### Шаг 6.1: Миграция localStorage → IndexedDB

**Затронутые файлы:**
- `toc-panel.ts` — `localStorage.getItem('toc-collapsed-...')` → таблица `uiState` в IndexedDB
- `model-test.ts` — `localStorage.getItem('ideograph-custom-tests')` → таблица `modelTests` в IndexedDB
- `model-test.ts` — `localStorage.getItem('ideograph-test-history')` → таблица `modelTests` в IndexedDB

**Реализация:**
1. Добавить таблицу `uiState` в `db/schema.ts` (schema v5):
   ```typescript
   uiState: { key: string; value: any; }
   ```
2. Создать хелперы в `db/index.ts`: `getUIState(key)`, `setUIState(key, value)`
3. Заменить все `localStorage.getItem/setItem` на хелперы

### Шаг 6.2: Стандартизация обработки ошибок

**Замены:**
- `alert('...')` → inline error messages (показывать в прогресс-баре или красном блоке)
- Пустые `catch {}` → `catch (err) { console.error('...', err); }` как минимум
- `console.warn()` при фатальных ошибках → показать пользователю через `onProgress`

**Файлы:**
- `analysis-panel.ts` — 2 вызова `alert()`
- `book-list.ts` — 1 вызов `alert()`
- `pipeline.ts` — `console.warn()` при ошибке чанка связей
- `toc-extractor.ts` — `console.warn()` при ошибке батча
- `djvu-extractor.ts` — пустые catch блоки

### Шаг 6.3: Устранение `as any`

Заменить type assertions на правильные типы:

| Файл | Вхождения | Решение |
|------|-----------|---------|
| `text-extractor.ts` | 6x `as any` | Использовать `pdfjsLib.PDFDocumentProxy` типы |
| `file-store.ts` | 2x `as any` | Глобальный тип из `shared/types/chrome.d.ts` (Шаг 1.3) |
| `native-messaging.ts` | 2x `as any` | Глобальный тип из `shared/types/chrome.d.ts` (Шаг 1.3) |
| `idea-list.ts` | 1x `as any` | Определить конкретный тип |

### Шаг 6.4: Дедупликация preview-рендеринга в analysis-panel.ts

Методы `render()` и `repreview()` содержат ~40 строк идентичного HTML-генерации для preview-секции. Вынести в приватный метод:

```typescript
private buildPreviewHtml(qualityReport: QualityReport, previewText: string, previewPage: number): string { ... }
```

---

## Проверочный чеклист

После каждого шага:

- [ ] `npm run build` компилируется без ошибок
- [ ] `npm run build` — нет новых warnings (кроме существующих chunk size)
- [ ] Нет циклических зависимостей (проверить: зависимости идут только вниз)
- [ ] `ui/components/*` не импортирует из `extraction/*` или `background/*` (после Фазы 3)
- [ ] Все существующие импорты продолжают работать (barrel-exports)
- [ ] DB schema не изменилась (нет новых версий Dexie)

После завершения всех фаз:

- [ ] Ни один файл не превышает 600 строк
- [ ] Нет дублирования кода >5 строк
- [ ] Нет `localStorage` usage (всё через IndexedDB)
- [ ] Нет `as any` (кроме минимально необходимого для внешних API)
- [ ] Нет `alert()` / `confirm()`
- [ ] Нет прямых `import` из `extraction/*` в `ui/components/*`
- [ ] Общее количество файлов <55 (рост justified декомпозицией)
