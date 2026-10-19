// Endpoint factories: one AI SDK v7 LanguageModel per (endpoint, model) pair.
// Spike code. Ports are the runtimes' defaults; override with env vars.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';

export const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
export const LLAMA_SERVER = process.env.LLAMA_SERVER_URL ?? 'http://127.0.0.1:8080';
export const LMSTUDIO = process.env.LMSTUDIO_URL ?? 'http://127.0.0.1:1234';

export type EndpointId =
  | 'ollama-native' // Ollama /api/chat via ollama-ai-provider-v2
  | 'ollama-openai' // Ollama /v1/chat/completions via @ai-sdk/openai-compatible
  | 'ollama-anthropic' // Ollama /v1/messages via @ai-sdk/anthropic
  | 'llama-server' // llama.cpp llama-server --jinja /v1/chat/completions
  | 'lmstudio'; // LM Studio /v1/chat/completions

export const ENDPOINTS: EndpointId[] = [
  'ollama-native',
  'ollama-openai',
  'ollama-anthropic',
  'llama-server',
  'lmstudio',
];

export function makeModel(endpoint: EndpointId, model: string): LanguageModel {
  switch (endpoint) {
    case 'ollama-native':
      return createOllama({ baseURL: `${OLLAMA}/api`, compatibility: 'strict' })(model);
    case 'ollama-openai':
      return createOpenAICompatible({
        name: 'ollama',
        baseURL: `${OLLAMA}/v1`,
        includeUsage: true,
        supportsStructuredOutputs: true,
      }).chatModel(model);
    case 'ollama-anthropic':
      // Ollama ignores the key but the provider requires one.
      return createAnthropic({ baseURL: `${OLLAMA}/v1`, apiKey: 'ollama' })(model);
    case 'llama-server':
      // llama-server serves one model; the id is only echoed back.
      return createOpenAICompatible({
        name: 'llamacpp',
        baseURL: `${LLAMA_SERVER}/v1`,
        includeUsage: true,
        supportsStructuredOutputs: true,
      }).chatModel(model);
    case 'lmstudio':
      return createOpenAICompatible({
        name: 'lmstudio',
        baseURL: `${LMSTUDIO}/v1`,
        includeUsage: true,
        supportsStructuredOutputs: true,
      }).chatModel(model);
  }
}
