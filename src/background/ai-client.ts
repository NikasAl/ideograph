import type { LLMExtractedIdea, LLMRelation } from '../db/schema.js';

// ============================================================
// AI Client — unified interface for multiple LLM providers
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

  async chatVision(messages: VisionMessage[], options?: ChatOptions): Promise<ChatResponse> {
    return this.chat(messages as unknown as ChatMessage[], options);
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
    const body: Record<string, unknown> = {
      model: options?.model || 'default',
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 4096,
    };
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
