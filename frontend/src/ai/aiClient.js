export const AI_STORAGE_KEYS = {
  apiKey: 'simpletasker_api_key',
  apiBase: 'simpletasker_api_base',
  model: 'simpletasker_ai_model',
};

export const DEFAULT_AI_API_BASE = 'https://api.deepseek.com';
export const DEFAULT_AI_MODEL = 'deepseek-chat';

export function getAiConfig() {
  return {
    apiKey: localStorage.getItem(AI_STORAGE_KEYS.apiKey) || '',
    apiBase: (localStorage.getItem(AI_STORAGE_KEYS.apiBase) || DEFAULT_AI_API_BASE).replace(/\/+$/, ''),
    model: localStorage.getItem(AI_STORAGE_KEYS.model) || DEFAULT_AI_MODEL,
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        return typeof part?.text === 'string' ? part.text : '';
      })
      .join('');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

export function extractChatCompletionResult(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const message = choice?.message;
  const content = message?.content;
  const text = contentToText(content);
  const contentFormat = !text.trim()
    ? 'empty'
    : Array.isArray(content)
      ? 'parts'
    : typeof content === 'string'
      ? 'text'
      : content == null
        ? 'empty'
        : typeof content;
  const reasoningContent = message?.reasoning_content;

  return {
    text,
    responseMeta: {
      finishReason: choice?.finish_reason ?? null,
      model: typeof data?.model === 'string' ? data.model : null,
      contentFormat,
      hasReasoningContent: typeof reasoningContent === 'string'
        ? !!reasoningContent.trim()
        : Array.isArray(reasoningContent) && reasoningContent.length > 0,
      completionTokens: Number.isFinite(data?.usage?.completion_tokens)
        ? data.usage.completion_tokens
        : null,
    },
  };
}

export async function callChatCompletion({
  systemPrompt,
  userMessage,
  maxTokens = 1200,
  temperature = 0.4,
  includeResponseMetadata = false,
}) {
  const { apiKey, apiBase, model } = getAiConfig();
  if (!apiKey) {
    throw new Error('请先在设置页配置 API Key');
  }

  const res = await fetch(`${apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `AI 请求失败 (${res.status})`);
  }

  const data = await res.json();
  const result = extractChatCompletionResult(data);
  return includeResponseMetadata ? result : result.text;
}
