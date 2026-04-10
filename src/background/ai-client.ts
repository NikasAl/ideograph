import type { LLMExtractedIdea, LLMRelation } from '../db/schema.js';

// ============================================================
// AI Client — unified interface for multiple LLM providers
// With fallback model support for rate-limiting and errors
// ============================================================

export interface AIProvider {
  name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  chatVision(messages: VisionMessage[], options?: ChatOptions): Promise<ChatResponse>;
  listModels?(): Promise<AIModel[]>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface VisionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | VisionContent[];
}

export interface VisionContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface ChatOptions {
  model?: string;
  fallbackModels?: string[];  // models to try if primary fails
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** Max retry attempts per model before moving to next (default: 2) */
  retriesPerModel?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AIModel {
  id: string;
  name: string;
  supportsVision: boolean;
}

/** Status codes that trigger retry on the same model (transient errors) */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 529]);

/** Status codes that trigger fallback to the next model (permanent for this model) */
const FALLBACK_STATUS_CODES = new Set([400, 401, 403, 422]);

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = Number((msg.match(/API error (\d+)/) || [])[1]);
  return RETRYABLE_STATUS_CODES.has(code);
}

function isFallbackError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = Number((msg.match(/API error (\d+)/) || [])[1]);
  // Fallback if it's a known fallback status code OR if the error mentions "Provider returned error"
  // (which indicates the upstream provider rejected the request, e.g. location restrictions)
  if (FALLBACK_STATUS_CODES.has(code)) return true;
  if (msg.includes('Provider returned error')) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// OpenRouter Provider
// ============================================================

export class OpenRouterProvider implements AIProvider {
  name = 'OpenRouter';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    const resp = await fetch(`https://openrouter.ai/api/v1${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://ideograph.local',
        'X-Title': 'Ideograph',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenRouter API error ${resp.status}: ${err}`);
    }
    return resp.json();
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    return this.callWithFallback(messages, options, false);
  }

  async chatVision(messages: VisionMessage[], options?: ChatOptions): Promise<ChatResponse> {
    return this.callWithFallback(messages as unknown as ChatMessage[], options, true);
  }

  /**
   * Try primary model, then fallback models.
   * Retries transient errors (429/502/503/529) per model before moving to next.
   * Permanent errors (400/401/403/"Provider returned error") skip immediately to next model.
   */
  private async callWithFallback(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    isVision: boolean,
  ): Promise<ChatResponse> {
    const models = buildModelList(options?.model, options?.fallbackModels);
    const maxRetries = options?.retriesPerModel ?? 2;
    const errors: string[] = [];

    for (const model of models) {
      let lastErr: Error | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const opts = { ...options, model };
          return await this.doChat(messages, opts);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          lastErr = err instanceof Error ? err : new Error(errMsg);
          console.warn(`[AI] Model ${model} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg}`);

          if (isFallbackError(err)) {
            // Permanent error for this model — skip to next model immediately
            errors.push(`${model}: ${errMsg}`);
            break;
          }

          if (isRetryableError(err) && attempt < maxRetries) {
            // Transient error — retry with exponential backoff
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            console.warn(`[AI] Retrying ${model} in ${delay}ms...`);
            await sleep(delay);
            continue;
          }

          // Exhausted retries or non-retryable error
          errors.push(`${model}: ${errMsg}`);
        }
      }
    }

    // All models failed
    throw new Error(
      `Все модели недоступны (${models.length} шт., ${maxRetries + 1} попытки каждая):\n${errors.join('\n')}`,
    );
  }

  private async doChat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: options?.model || 'anthropic/claude-sonnet-4',
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 4096,
    };
    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    const data = await this.request('/chat/completions', body) as Record<string, unknown>;
    const choice = (data.choices as Array<Record<string, unknown>>)[0];
    const message = choice.message as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    return {
      content: message.content as string,
      model: data.model as string,
      usage: usage ? {
        promptTokens: usage.prompt_tokens as number,
        completionTokens: usage.completion_tokens as number,
        totalTokens: usage.total_tokens as number,
      } : undefined,
    };
  }

  async listModels(): Promise<AIModel[]> {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    const data = await resp.json() as Record<string, unknown>;
    const models = (data.data as Array<Record<string, unknown>>) || [];
    return models.map((m) => ({
      id: m.id as string,
      name: (m.name as string) || (m.id as string),
      supportsVision: ['vision', 'image'].some(k =>
        ((m.architecture as Record<string, unknown>)?.modality as string || '').includes(k)
      ),
    }));
  }
}

// ============================================================
// z-ai Provider — OpenAI-compatible API with custom headers
// ============================================================

export class ZAIProvider implements AIProvider {
  name = 'z-ai';
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || '').replace(/\/+$/, ''); // strip trailing slashes
    if (!this.baseUrl) throw new Error('z-ai: baseUrl is required (set in Settings)');
  }

  private async request(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'X-Z-AI-From': 'Z',
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`z-ai API error ${resp.status}: ${err}`);
    }
    return resp.json();
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    return this.callWithFallback(messages, options, false);
  }

  async chatVision(messages: VisionMessage[], options?: ChatOptions): Promise<ChatResponse> {
    return this.callWithFallback(messages as unknown as ChatMessage[], options, true);
  }

  /**
   * Try primary model, then fallback models.
   * Retries transient errors per model before moving to next.
   */
  private async callWithFallback(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    isVision: boolean,
  ): Promise<ChatResponse> {
    const models = buildModelList(options?.model, options?.fallbackModels);
    const maxRetries = options?.retriesPerModel ?? 2;
    const errors: string[] = [];

    for (const model of models) {
      let lastErr: Error | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const opts = { ...options, model };
          return await this.doChat(messages, opts, isVision);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          lastErr = err instanceof Error ? err : new Error(errMsg);
          console.warn(`[z-ai] Model ${model} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg}`);

          if (isFallbackError(err)) {
            errors.push(`${model}: ${errMsg}`);
            break;
          }

          if (isRetryableError(err) && attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            console.warn(`[z-ai] Retrying ${model} in ${delay}ms...`);
            await sleep(delay);
            continue;
          }

          errors.push(`${model}: ${errMsg}`);
        }
      }
    }

    throw new Error(
      `z-ai: все модели недоступны (${models.length} шт.):\n${errors.join('\n')}`,
    );
  }

  private async doChat(messages: ChatMessage[], options?: ChatOptions, isVision?: boolean): Promise<ChatResponse> {
    const endpoint = isVision ? '/chat/completions/vision' : '/chat/completions';
    const body: Record<string, unknown> = {
      model: options?.model || 'glm-4-plus',
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 4096,
      thinking: { type: 'disabled' },
    };
    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    const data = await this.request(endpoint, body) as Record<string, unknown>;
    const choice = (data.choices as Array<Record<string, unknown>>)[0];
    const message = choice.message as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    return {
      content: message.content as string,
      model: data.model as string,
      usage: usage ? {
        promptTokens: usage.prompt_tokens as number,
        completionTokens: usage.completion_tokens as number,
        totalTokens: usage.total_tokens as number,
      } : undefined,
    };
  }
}

// ============================================================
// Provider factory
// ============================================================

export function createProvider(provider: string, apiKey: string, extra?: { zaiBaseUrl?: string }): AIProvider {
  switch (provider) {
    case 'openrouter':
      return new OpenRouterProvider(apiKey);
    case 'z-ai':
      return new ZAIProvider(apiKey, extra?.zaiBaseUrl);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Build ordered list of models: primary first, then fallbacks.
 * Skips empty strings and duplicates.
 */
export function buildModelList(primary: string | undefined, fallbacks: string[] | undefined): string[] {
  const models: string[] = [];
  const seen = new Set<string>();

  if (primary?.trim()) {
    models.push(primary.trim());
    seen.add(primary.trim());
  }

  if (fallbacks) {
    for (const m of fallbacks) {
      const trimmed = m.trim();
      if (trimmed && !seen.has(trimmed)) {
        models.push(trimmed);
        seen.add(trimmed);
      }
    }
  }

  // Always have at least one model
  if (models.length === 0) {
    models.push('anthropic/claude-sonnet-4');
  }

  return models;
}

/**
 * Parse comma-separated fallback models string into array.
 */
export function parseFallbackModels(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}
