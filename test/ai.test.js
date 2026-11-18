import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiStatus, streamChat, buildPrompt } from '../server/ai.js';
import { serve } from './helpers.js';

/** A fake model server. stream: lines written one by one, with a pause between them. */
async function modelServer(t, { models, stream, status = 200 }) {
  const seen = [];
  const url = await serve(t, async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(models)); return; }
    res.writeHead(status);
    for (const line of stream) { res.write(line); await new Promise((ok) => setTimeout(ok, 2)); }
    res.end();
  });
  return { url, seen };
}

test('Ollama: models, streamed reply, and errors', async (t) => {
  const { url, seen } = await modelServer(t, {
    models: { models: [{ name: 'llama3.2' }] },
    stream: ['{"message":{"content":"Boil "}}\n{"message":{"con', 'tent":"water."}}\n', 'not json\n', '{"done":true}'],
  });
  const ai = { provider: 'ollama', baseUrl: url, apiKey: '' };
  assert.deepEqual(await aiStatus(ai), { online: true, models: ['llama3.2'] });
  const parts = [];
  await streamChat(ai, 'llama3.2', [{ role: 'user', content: 'water?' }], (s) => parts.push(s));
  assert.deepEqual(parts, ['Boil ', 'water.']);
  assert.equal(seen.at(-1).url, '/api/chat');
  assert.deepEqual(seen.at(-1).body, { model: 'llama3.2', messages: [{ role: 'user', content: 'water?' }], stream: true });
});

test('Ollama: an error line ends the stream', async (t) => {
  const { url } = await modelServer(t, { models: {}, stream: ['{"message":{"content":"a"}}\n{"error":"model not found"}\n'] });
  await assert.rejects(streamChat({ provider: 'ollama', baseUrl: url }, 'x', [], () => {}), /model not found/);
});

test('OpenAI-compatible: models, bearer key, server-sent events', async (t) => {
  const { url, seen } = await modelServer(t, {
    models: { data: [{ id: 'gpt-local' }, { id: 'other' }] },
    stream: [': keep-alive\n', 'data: {"choices":[{"delta":{"content":"Find "}}]}\n', 'data: {"choices":[{"delta":{}}]}\n', 'data: {"choices":[{"delta":{"content":"north."}}]}\n', 'data: [DONE]\n', 'data: {"choices":[{"delta":{"content":"ignored"}}]}\n'],
  });
  const ai = { provider: 'openai', baseUrl: url, apiKey: 'sk-test' };
  assert.deepEqual((await aiStatus(ai)).models, ['gpt-local', 'other']);
  const parts = [];
  await streamChat(ai, 'gpt-local', [], (s) => parts.push(s));
  assert.deepEqual(parts, ['Find ', 'north.']);
  assert.equal(seen.at(-1).url, '/chat/completions');
  assert.equal(seen.at(-1).auth, 'Bearer sk-test');
});

test('HTTP errors and unreachable servers', async (t) => {
  const { url } = await modelServer(t, { models: {}, status: 500, stream: ['overloaded'] });
  await assert.rejects(streamChat({ provider: 'ollama', baseUrl: url }, 'x', [], () => {}), /HTTP 500: overloaded/);
  const down = await aiStatus({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9' });
  assert.equal(down.online, false);
  assert.deepEqual(down.models, []);
  assert.ok(down.error);
});

test('the system prompt cites manual passages', () => {
  const prompt = buildPrompt([{ article: { title: 'Boiling', category: 'WATER' }, heading: 'Fuel', text: 'Boil for a minute.' }]);
  assert.match(prompt, /### Boiling — Fuel \[WATER\]\nBoil for a minute\./);
  assert.match(buildPrompt([]), /\(no relevant entries found\)/);
});
