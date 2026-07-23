export const AI_STORAGE_KEYS = {
  apiKey: 'simpletasker_api_key',
  apiBase: 'simpletasker_api_base',
  model: 'simpletasker_ai_model',
  prompt: 'simpletasker_ai_prompt',
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

export async function callChatCompletion({ systemPrompt, userMessage, maxTokens = 1200, temperature = 0.4 }) {
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
  return data.choices?.[0]?.message?.content || '';
}
