// Логика "совета нейросетей": ответить, обсудить, улучшить, выбрать лучшее, собрать из частей.
import { chat, PROVIDERS } from './providers.js';

const nameOf = (id) => PROVIDERS[id]?.name || id;

async function runAll(ids, fn) {
  const results = await Promise.allSettled(ids.map((id) => fn(id)));
  return ids.map((id, i) =>
    results[i].status === 'fulfilled'
      ? { model: id, name: nameOf(id), ok: true, ...results[i].value }
      : { model: id, name: nameOf(id), ok: false, error: String(results[i].reason?.message || results[i].reason) },
  );
}

function answersBlock(answers) {
  return answers
    .filter((a) => a.ok !== false && a.text)
    .map((a) => `=== Ответ ${a.model} ===\n${a.text}`)
    .join('\n\n');
}

/** 1. Все выбранные модели отвечают на вопрос параллельно */
export async function ask({ question, models }) {
  const system = 'Ты участник совета экспертов. Отвечай по существу, структурировано, на языке вопроса.';
  return runAll(models, async (id) => {
    const t = Date.now();
    const text = await chat(id, question, system);
    return { text, ms: Date.now() - t };
  });
}

/** 2. Каждая модель разбирает ответы остальных: сильные/слабые стороны и оценка 1-10 */
export async function discuss({ question, answers, models }) {
  const valid = answers.filter((a) => a.ok !== false && a.text);
  const reviewers = models?.length ? models : valid.map((a) => a.model);

  const reviews = await runAll(reviewers, async (id) => {
    const others = valid.filter((a) => a.model !== id);
    if (!others.length) throw new Error('Нет чужих ответов для обсуждения');
    const prompt =
      `Вопрос пользователя:\n${question}\n\n` +
      `Ответы других нейросетей:\n\n${answersBlock(others)}\n\n` +
      `Проанализируй каждый ответ честно и конкретно. Верни ТОЛЬКО JSON без markdown в формате:\n` +
      `{"reviews":[{"model":"<id>","strengths":["..."],"weaknesses":["..."],"score":<1-10>}],` +
      `"best":"<id лучшего ответа>","comment":"<общий вывод 1-3 предложения>"}\n` +
      `Допустимые id: ${others.map((a) => a.model).join(', ')}. Пиши на языке вопроса.`;
    const raw = await chat(id, prompt, 'Ты строгий и справедливый рецензент. Отвечаешь только валидным JSON.');
    return { review: parseJSON(raw), raw };
  });

  return { reviews, ranking: rank(valid, reviews) };
}

/** Средняя оценка, которую каждый ответ получил от других моделей */
function rank(answers, reviews) {
  const table = Object.fromEntries(answers.map((a) => [a.model, { model: a.model, name: nameOf(a.model), scores: [], votes: 0 }]));
  for (const r of reviews) {
    if (!r.ok || !r.review) continue;
    for (const item of r.review.reviews || []) {
      const s = Number(item.score);
      if (table[item.model] && s >= 1 && s <= 10) table[item.model].scores.push(s);
    }
    if (table[r.review.best]) table[r.review.best].votes++;
  }
  return Object.values(table)
    .map((t) => ({
      ...t,
      avg: t.scores.length ? +(t.scores.reduce((x, y) => x + y, 0) / t.scores.length).toFixed(2) : null,
    }))
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.votes - a.votes);
}

/** 3. Каждая модель улучшает свой ответ с учётом критики коллег */
export async function revise({ question, answers, reviews }) {
  const valid = answers.filter((a) => a.ok !== false && a.text);
  return runAll(valid.map((a) => a.model), async (id) => {
    const mine = valid.find((a) => a.model === id).text;
    const critique = (reviews || [])
      .filter((r) => r.ok && r.review && r.model !== id)
      .map((r) => {
        const it = (r.review.reviews || []).find((x) => x.model === id);
        if (!it) return '';
        return `${nameOf(r.model)} (оценка ${it.score}/10):\n+ ${(it.strengths || []).join('; ')}\n- ${(it.weaknesses || []).join('; ')}`;
      })
      .filter(Boolean)
      .join('\n\n');
    const prompt =
      `Вопрос:\n${question}\n\nТвой предыдущий ответ:\n${mine}\n\n` +
      `КРИТИКА от других нейросетей:\n${critique || '(нет замечаний)'}\n\n` +
      `Ответы коллег для сравнения:\n\n${answersBlock(valid.filter((a) => a.model !== id))}\n\n` +
      `Напиши улучшенную версию своего ответа: исправь слабые места, возьми лучшие идеи коллег. Выдай только новый ответ.`;
    const t = Date.now();
    const text = await chat(id, prompt, 'Ты участник совета экспертов и улучшаешь свой ответ после обсуждения.');
    return { text, ms: Date.now() - t };
  });
}

/**
 * 4. Собрать итоговый ответ.
 *  mode "best"  — вернуть ответ с наибольшей средней оценкой (или указанный best)
 *  mode "parts" — объединить выбранные пользователем фрагменты (parts: [{model, text}])
 *  mode "all"   — судья сам берёт лучшее из всех ответов
 */
export async function synthesize({ question, answers = [], parts = [], mode = 'parts', judge, best, ranking }) {
  if (mode === 'best') {
    const id = best || ranking?.find((r) => r.avg !== null)?.model;
    const a = answers.find((x) => x.model === id);
    if (!a) throw new Error('Не удалось определить лучший ответ — сначала запустите обсуждение или укажите best');
    return { mode, model: id, name: nameOf(id), text: a.text };
  }

  if (!judge) throw new Error('Укажите judge — какая нейросеть собирает итог');
  let material;
  if (mode === 'parts') {
    if (!parts.length) throw new Error('Не выбрано ни одной части');
    material = parts.map((p, i) => `--- Фрагмент ${i + 1} (от ${nameOf(p.model)}) ---\n${p.text}`).join('\n\n');
  } else {
    material = answersBlock(answers);
  }
  const prompt =
    `Вопрос:\n${question}\n\nМатериал:\n\n${material}\n\n` +
    (mode === 'parts'
      ? 'Собери из этих фрагментов ИТОГОВЫЙ ОТВЕТ: сохрани их содержание, убери повторы, сделай плавные переходы. Не добавляй новых фактов без необходимости.'
      : 'Составь ИТОГОВЫЙ ОТВЕТ, взяв лучшее из каждого ответа и исправив ошибки.') +
    ' Выдай только итоговый текст.';
  const text = await chat(judge, prompt, 'Ты редактор, объединяющий работу нескольких экспертов в один лучший ответ.');
  return { mode, judge, name: nameOf(judge), text };
}

function parseJSON(raw) {
  const s = String(raw).replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}
