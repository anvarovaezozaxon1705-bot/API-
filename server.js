import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));

const { listModels, isMock } = await import('./src/providers.js');
const { ask, discuss, revise, synthesize } = await import('./src/council.js');

const routes = {
  'POST /api/ask': (b) => {
    if (!b.question?.trim()) throw badRequest('Пустой вопрос');
    return ask({ question: b.question, models: pickModels(b.models) });
  },
  'POST /api/discuss': (b) => discuss(b),
  'POST /api/revise': (b) => revise(b),
  'POST /api/synthesize': (b) => synthesize(b),
  // Всё за один запрос: ответы → обсуждение → (опционально) улучшение → лучший
  'POST /api/council': async (b) => {
    if (!b.question?.trim()) throw badRequest('Пустой вопрос');
    const rounds = Math.min(Math.max(Number(b.rounds) || 1, 1), 3);
    let answers = await ask({ question: b.question, models: pickModels(b.models) });
    const history = [];
    let d;
    for (let i = 0; i < rounds; i++) {
      d = await discuss({ question: b.question, answers });
      history.push({ round: i + 1, answers, ...d });
      if (i < rounds - 1) answers = await revise({ question: b.question, answers, reviews: d.reviews });
    }
    const best = d.ranking.find((r) => r.avg !== null);
    return { history, answers, ranking: d.ranking, best: best && answers.find((a) => a.model === best.model) };
  },
};

function pickModels(models) {
  const available = listModels().filter((m) => m.available).map((m) => m.id);
  const chosen = Array.isArray(models) && models.length ? models.filter((m) => available.includes(m)) : available;
  if (!chosen.length) throw badRequest('Нет доступных моделей. Добавьте ключи в .env или запустите с MOCK=1');
  return chosen;
}

function badRequest(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

const server = http.createServer(async (req, res) => {
  const send = (status, data, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
  };
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/models') return send(200, { mock: isMock(), models: listModels() });

    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      return send(200, await handler(body));
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(200, fs.readFileSync(path.join(__dirname, 'public/index.html')), 'text/html; charset=utf-8');
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(e.status || 500, { error: e.message });
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`AI Council: http://localhost:${port}${isMock() ? '  (демо-режим MOCK=1)' : ''}`);
  for (const m of listModels()) console.log(`  ${m.available ? '✓' : '✗'} ${m.name} (${m.model})`);
});
