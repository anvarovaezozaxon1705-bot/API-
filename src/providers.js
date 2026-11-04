// Единый интерфейс к пяти нейросетям: chat(modelId, messages, system) -> текст.
// Используется встроенный fetch (Node 20+), никаких внешних зависимостей.

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;

export const PROVIDERS = {
  chatgpt: {
    name: 'ChatGPT',
    keyVar: 'OPENAI_API_KEY',
    model: () => env('OPENAI_MODEL', 'gpt-5'),
    call: (p) => openAICompatible('https://api.openai.com/v1/chat/completions', p),
  },
  gemini: {
    name: 'Gemini',
    keyVar: 'GEMINI_API_KEY',
    model: () => env('GEMINI_MODEL', 'gemini-2.5-flash'),
    call: gemini,
  },
  claude: {
    name: 'Claude',
    keyVar: 'ANTHROPIC_API_KEY',
    model: () => env('ANTHROPIC_MODEL', 'claude-opus-5-5'),
    call: claude,
  },
  deepseek: {
    name: 'DeepSeek',
    keyVar: 'DEEPSEEK_API_KEY',
    model: () => env('DEEPSEEK_MODEL', 'deepseek-chat'),
    call: (p) => openAICompatible('https://api.deepseek.com/chat/completions', p),
  },
  grok: {
    name: 'Grok',
    keyVar: 'XAI_API_KEY',
    model: () => env('XAI_MODEL', 'grok-4'),
    call: (p) => openAICompatible('https://api.x.ai/v1/chat/completions', p),
  },
};

export const isMock = () => env('MOCK', '0') === '1';

export function listModels() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    name: p.name,
    model: p.model(),
    available: isMock() || Boolean(env(p.keyVar)),
  }));
}

/**
 * Отправить запрос модели.
 * @param {string} id      chatgpt | gemini | claude | deepseek | grok
 * @param {string} prompt  текст запроса пользователя
 * @param {string} system  системная инструкция
 */
export async function chat(id, prompt, system = '') {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Неизвестная модель: ${id}`);
  if (isMock()) return mockAnswer(id, prompt);
  const key = env(p.keyVar);
  if (!key) throw new Error(`Нет ключа ${p.keyVar}`);
  return p.call({ key, model: p.model(), prompt, system });
}

async function postJSON(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(env('TIMEOUT_MS', '180000'))),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// OpenAI, DeepSeek и xAI (Grok) используют один и тот же формат
async function openAICompatible(url, { key, model, prompt, system }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const data = await postJSON(url, { authorization: `Bearer ${key}` }, { model, messages });
  return data.choices?.[0]?.message?.content ?? '';
}

async function gemini({ key, model, prompt, system }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const data = await postJSON(url, { 'x-goog-api-key': key }, body);
  return (data.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
}

async function claude({ key, model, prompt, system }) {
  const body = {
    model,
    max_tokens: Number(env('ANTHROPIC_MAX_TOKENS', '4096')),
    messages: [{ role: 'user', content: prompt }],
  };
  if (system) body.system = system;
  const data = await postJSON(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body,
  );
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// ---------- Демо-режим без ключей ----------
async function mockAnswer(id, prompt) {
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
  const name = PROVIDERS[id].name;
  if (prompt.includes('"reviews"')) {
    const others = [...prompt.matchAll(/=== Ответ (\w+) ===/g)].map((m) => m[1]).filter((m) => m !== id);
    return JSON.stringify({
      reviews: others.map((m) => ({
        model: m,
        strengths: [`${PROVIDERS[m]?.name || m}: понятная структура`, 'есть конкретный пример'],
        weaknesses: ['мало источников', 'можно короче'],
        score: 5 + Math.floor(Math.random() * 5),
      })),
      best: others[Math.floor(Math.random() * others.length)],
      comment: `${name}: в целом ответы хорошие, но различаются глубиной.`,
    });
  }
  if (prompt.includes('ИТОГОВЫЙ ОТВЕТ')) {
    return `**Итоговый ответ (собрал ${name})**\n\nОбъединены выбранные части в один связный текст.`;
  }
  if (prompt.includes('КРИТИКА')) {
    return `**${name} — улучшенный ответ**\n\nУчёл замечания коллег: добавил пример и сократил лишнее.`;
  }
  return `**${name}** отвечает на вопрос.\n\nПервый абзац: основная идея от ${name}.\n\nВторой абзац: пример и пояснение.\n\nТретий абзац: вывод и совет.`;
}
