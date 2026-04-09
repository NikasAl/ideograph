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

/** Status codes that trigger fallback to next model */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 529]);

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Match "OpenRouter API error 429:", "error 503:", etc.
  return RETRYABLE_STATUS_CODES.has(Number((msg.match(/API error (\d+)/) || [])[1]));
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
   * Try primary model, then fallback models on retryable errors.
   */
  private async callWithFallback(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    isVision: boolean,
  ): Promise<ChatResponse> {
    const models = buildModelList(options?.model, options?.fallbackModels);
    const errors: string[] = [];

    for (const model of models) {
      try {
        const opts = { ...options, model };
        if (isVision) {
          // For vision, we still go through chat (messages already have image_url content)
          return await this.doChat(messages, opts);
        }
        return await this.doChat(messages, opts);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[AI] Model ${model} failed: ${errMsg}`);

        if (isRetryableError(err)) {
          errors.push(`${model}: ${errMsg}`);
          continue; // try next fallback
        }
        // Non-retryable error — throw immediately
        throw err;
      }
    }

    // All models failed
    throw new Error(
      `Все модели недоступны (${models.length} шт.):\n${errors.join('\n')}`,
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
// z-ai Provider (coming soon)
// ============================================================

export class ZAIProvider implements AIProvider {
  name = 'z-ai';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    // TODO: implement z-ai API call
    throw new Error('z-ai provider not yet implemented');
  }

  async chatVision(messages: VisionMessage[], options?: ChatOptions): Promise<ChatResponse> {
    throw new Error('z-ai vision not yet implemented');
  }
}

// ============================================================
// Provider factory
// ============================================================

export function createProvider(provider: string, apiKey: string): AIProvider {
  switch (provider) {
    case 'openrouter':
      return new OpenRouterProvider(apiKey);
    case 'z-ai':
      return new ZAIProvider(apiKey);
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
