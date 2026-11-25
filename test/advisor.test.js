// Advisor: household context, embeddings retrieval, model pulls, and the saved conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt, householdPrompt, isLocalModelUrl, embed, pullModel } from '../server/ai.js';
import { cosine, nearest, fuse, pickEmbedModel, isEmbedModel, EmbeddingIndex, retrieve, passageKey } from '../server/retrieval.js';
import { modelName, splitName, estimateSize, modelFit, registrySize } from '../server/models.js';
import { Manual } from '../server/manual.js';
import { loadHistory, saveHistory, transcript, exchange, HISTORY_KEY, MAX_SAVED } from '../public/js/lib/advisor.js';
import { serve, tmpDir } from './helpers.js';

const GB = 1024 ** 3;

test('household context is only sent to a model server on this machine or the local network', () => {
  for (const url of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434', 'http://10.0.0.5:11434', 'http://172.20.1.1',
    'http://192.168.1.20:11434', 'http://169.254.1.1', 'http://100.64.0.9', 'http://ollama:11434', 'http://shelter-ollama:11434',
    'http://host.docker.internal:11434', 'http://box.local:1234/v1', 'http://nas.lan', 'http://x.home.arpa', 'http://[fd00::1]:11434', 'http://[fe80::1]']) {
    assert.equal(isLocalModelUrl(url), true, url);
  }
  for (const url of ['https://api.openai.com/v1', 'http://8.8.8.8:11434', 'http://172.32.0.1', 'http://192.169.0.1', 'https://models.example',
    'http://[2001:db8::1]', 'not a url', '', 'http://localhost.example.com']) {
    assert.equal(isLocalModelUrl(url), false, url);
  }
});

test('householdPrompt lists people and pets with allergies and medications, nothing else', () => {
  const text = householdPrompt([
    { name: 'Ana', kind: 'person', group: 'child', birthYear: 2019, allergies: 'peanuts', medications: [{ name: 'EpiPen', dose: '0.15 mg', schedule: 'if needed' }], bloodType: 'O+', notes: 'secret note' },
    { name: 'Rex', kind: 'pet', group: 'dog', medications: [] },
    { name: 'Joe', group: 'adult', conditions: 'diabetes', needs: 'wheelchair' },
  ], 2026);
  assert.equal(text, [
    '- Ana (child, age 7): allergies: peanuts; medications: EpiPen 0.15 mg if needed',
    '- Rex (pet (dog))',
    '- Joe (adult): conditions: diabetes; needs: wheelchair',
  ].join('\n'));
  assert.doesNotMatch(text, /O\+|secret/);
  assert.equal(householdPrompt([]), '');
  assert.equal(householdPrompt(null), '');
  const prompt = buildPrompt([], { household: text });
  assert.match(prompt, /HOUSEHOLD[^\n]*\n- Ana/);
  assert.ok(prompt.indexOf('HOUSEHOLD') < prompt.indexOf('FIELD MANUAL EXCERPTS'));
  assert.doesNotMatch(buildPrompt([]), /HOUSEHOLD/);
});

test('cosine, nearest and reciprocal rank fusion', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [-1, -1]) + 1) < 1e-12);
  assert.equal(cosine([1, 2], [1, 2, 3]), 0, 'different lengths');
  assert.equal(cosine([0, 0], [1, 1]), 0, 'a zero vector');
  assert.equal(cosine([], []), 0);
  assert.deepEqual(nearest([1, 0], [[0, 1], [1, 0.1], [1, 1]], 2).map((x) => x.i), [1, 2]);
  assert.deepEqual(fuse([['a', 'b', 'c'], ['c', 'a']]), ['a', 'c', 'b']);
  assert.deepEqual(fuse([]), []);
});

test('picking an embedding model', () => {
  assert.equal(pickEmbedModel('', ['llama3.2:3b', 'nomic-embed-text:latest']), 'nomic-embed-text:latest');
  assert.equal(pickEmbedModel('mine', ['nomic-embed-text']), 'mine', 'the configured model wins');
  assert.equal(pickEmbedModel('', ['llama3.2:3b', 'gemma3:4b']), '');
  for (const m of ['mxbai-embed-large', 'bge-m3', 'all-minilm', 'snowflake-arctic-embed', 'e5-large', 'gte-base']) assert.ok(isEmbedModel(m), m);
  for (const m of ['llama3.2:3b', 'qwen2.5', 'gemma3:4b']) assert.ok(!isEmbedModel(m), m);
});

test('model names, sizes and the fit check', () => {
  assert.equal(modelName(' llama3.2:3b '), 'llama3.2:3b');
  assert.equal(modelName('library/qwen2.5:3b-instruct-q4_K_M'), 'library/qwen2.5:3b-instruct-q4_K_M');
  for (const bad of ['', '../x', 'a b', 'x;rm -rf', 'http://x', 'a/b/c', null]) assert.equal(modelName(bad), null, String(bad));
  assert.deepEqual(splitName('llama3.2:3b'), { repo: 'library/llama3.2', tag: '3b' });
  assert.deepEqual(splitName('me/model'), { repo: 'me/model', tag: 'latest' });
  assert.equal(estimateSize('llama3.2:3b'), 1.8e9);
  assert.equal(estimateSize('qwen2.5:1.5b-instruct'), 0.9e9);
  assert.equal(estimateSize('gemma3:270m'), 162e6);
  assert.equal(estimateSize('llama3.2'), null);

  const ok = modelFit({ size: 2 * GB, memTotal: 16 * GB, memFree: 10 * GB, diskFree: 100 * GB });
  assert.equal(ok.verdict, 'ok');
  assert.equal(ok.ramNeeded, Math.round(2.4 * GB + 0.5 * GB));
  assert.equal(modelFit({ size: 2 * GB, memTotal: 3.5 * GB, memFree: 3 * GB, diskFree: 100 * GB }).verdict, 'tight');
  assert.equal(modelFit({ size: 2 * GB, memTotal: 16 * GB, memFree: 1 * GB, diskFree: 100 * GB }).verdict, 'tight');
  const big = modelFit({ size: 40 * GB, memTotal: 16 * GB, memFree: 10 * GB, diskFree: 100 * GB });
  assert.equal(big.verdict, 'too-big');
  assert.equal(big.reasons.length, 1);
  assert.equal(modelFit({ size: 2 * GB, memTotal: 16 * GB, memFree: 10 * GB, diskFree: 1 * GB }).verdict, 'too-big');
  assert.equal(modelFit({ size: null, memTotal: 16 * GB }).verdict, 'unknown');
});

test('registry size: layer sizes from the manifest, missing models, unreachable registry', async (t) => {
  const seen = [];
  const registry = await serve(t, (req, res) => {
    seen.push(req.url);
    if (req.url.includes('nope')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ layers: [{ size: 1000 }, { size: 24 }] }));
  });
  assert.deepEqual(await registrySize('llama3.2:3b', { registry }), { size: 1024, missing: false });
  assert.equal(seen[0], '/v2/library/llama3.2/manifests/3b');
  assert.deepEqual(await registrySize('nope', { registry }), { size: null, missing: true });
  assert.equal(await registrySize('x', { registry: 'http://127.0.0.1:9', timeout: 500 }), null);
});

/** A fake Ollama server for embeddings and pulls. Vectors: [1, 0] for text about water or drinking, else [0, 1]. */
async function fakeOllama(t, { failEmbed = false } = {}) {
  const seen = [];
  const url = await serve(t, async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, body: json });
    if (req.url === '/api/embed') {
      if (failEmbed) { res.writeHead(500); res.end('no'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embeddings: json.input.map((s) => (/water|drink/i.test(s) ? [1, 0] : [0, 1])) }));
      return;
    }
    if (req.url === '/api/pull') {
      res.writeHead(200);
      if (json.model === 'bad') { res.end('{"error":"pull model manifest: file does not exist"}\n'); return; }
      res.write('{"status":"pulling manifest"}\n{"status":"pulling abc","total":100,"completed":40}\n');
      res.end(json.model === 'cut' ? '' : '{"status":"pulling abc","total":100,"completed":100}\n{"status":"success"}\n');
      return;
    }
    res.writeHead(404); res.end();
  });
  return { url, seen };
}

test('embed and pullModel talk to Ollama', async (t) => {
  const { url, seen } = await fakeOllama(t);
  const ai = { provider: 'ollama', baseUrl: url };
  assert.deepEqual(await embed(ai, 'nomic', ['water', 'fire']), [[1, 0], [0, 1]]);
  assert.deepEqual(seen.at(-1), { url: '/api/embed', body: { model: 'nomic', input: ['water', 'fire'] } });
  const progress = [];
  await pullModel(ai, 'llama3.2:1b', (p) => progress.push(p));
  assert.deepEqual(seen.at(-1).body, { model: 'llama3.2:1b', stream: true });
  assert.deepEqual(progress.map((p) => p.completed), [0, 40, 100, 0]);
  assert.equal(progress.at(-1).status, 'success');
  await assert.rejects(pullModel(ai, 'bad', () => {}), /file does not exist/);
  await assert.rejects(pullModel(ai, 'cut', () => {}), /ended before it finished/);
});

function manualDir(t) {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'category: BASICS\n\n# Purify\nMake it safe to drink by boiling.\n\n# Fire\nHow to start a fire with a flint.\n');
  return dir;
}

test('retrieval: keyword search until the index is built, then embeddings fused with keywords', async (t) => {
  const { url } = await fakeOllama(t);
  const manual = new Manual(manualDir(t));
  const cache = tmpDir(t);
  const index = new EmbeddingIndex(cache);
  const ai = { provider: 'ollama', baseUrl: url };

  const none = await retrieve({ manual, index, ai, embedModel: '', question: 'safe water' });
  assert.equal(none.mode, 'keyword');

  const first = await retrieve({ manual, index, ai, embedModel: 'nomic', question: 'water' });
  assert.equal(first.mode, 'keyword', 'the index is still building');
  await index.building;
  assert.ok(index.ready('nomic', manual.signature));
  assert.ok(fs.existsSync(path.join(cache, 'embeddings-nomic.json')));

  // The fake model puts "drink" and "water" close together; keyword search knows no such link.
  assert.deepEqual(manual.passages('stay hydrated water', 4), []);
  const second = await retrieve({ manual, index, ai, embedModel: 'nomic', question: 'stay hydrated water' });
  assert.equal(second.mode, 'embeddings');
  assert.deepEqual(second.passages.map((p) => p.article.title), ['Purify']);
  const both = await retrieve({ manual, index, ai, embedModel: 'nomic', question: 'flint water' });
  assert.deepEqual(both.passages.map((p) => p.article.title).sort(), ['Fire', 'Purify'], 'vector and keyword hits are fused');

  // A restart reuses the cache: no passage is embedded again.
  const again = new EmbeddingIndex(cache);
  await again.build(ai, 'nomic', manual.chunks(), manual.signature);
  assert.equal(again.progress.done, again.progress.total);
  assert.equal(again.vectors.length, manual.chunks().length);
  assert.equal(passageKey(manual.chunks()[0]).length, 16);
});

test('retrieval falls back to keywords when the embedding server fails', async (t) => {
  const { url } = await fakeOllama(t, { failEmbed: true });
  const manual = new Manual(manualDir(t));
  const index = new EmbeddingIndex(tmpDir(t));
  const ai = { provider: 'ollama', baseUrl: url };
  const r = await retrieve({ manual, index, ai, embedModel: 'nomic', question: 'boiling' });
  await index.building;
  assert.equal(r.mode, 'keyword');
  assert.equal(r.passages[0].article.title, 'Purify');
  assert.match(index.error, /HTTP 500/);
  assert.equal((await retrieve({ manual, index, ai, embedModel: 'nomic', question: 'boiling' })).mode, 'keyword');
});

/** An in-memory Storage. */
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('the conversation is saved on the device and survives a reload', () => {
  const s = memoryStorage();
  const history = [
    { role: 'user', content: 'How do I purify water?' },
    { role: 'assistant', content: 'Boil it.', sources: [{ id: 'purify', title: 'Purify', category: 'WATER', summary: 's', extra: 'x' }], household: true, junk: 1 },
    { role: 'assistant', content: '' },
  ];
  assert.equal(saveHistory(s, history), true);
  const back = loadHistory(s);
  assert.deepEqual(back, [history[0], { role: 'assistant', content: 'Boil it.', sources: [{ id: 'purify', title: 'Purify', category: 'WATER', summary: 's' }], household: true }]);
  assert.equal(saveHistory(s, []), true);
  assert.equal(s.getItem(HISTORY_KEY), null);

  s.setItem(HISTORY_KEY, 'not json');
  assert.deepEqual(loadHistory(s), []);
  s.setItem(HISTORY_KEY, JSON.stringify([{ role: 'system', content: 'x' }, { role: 'user', content: 5 }, { role: 'user', content: 'ok' }]));
  assert.deepEqual(loadHistory(s), [{ role: 'user', content: 'ok' }]);
  assert.deepEqual(loadHistory(null), []);
  const many = Array.from({ length: MAX_SAVED + 10 }, (_, i) => ({ role: 'user', content: `q${i}` }));
  saveHistory(s, many);
  assert.equal(loadHistory(s).length, MAX_SAVED);
  assert.equal(loadHistory(s)[0].content, 'q10');
  assert.equal(saveHistory({ setItem: () => { throw new Error('full'); } }, many), false);
});

test('Save to Log: a transcript with the question as title and sources as links', () => {
  const history = [
    { role: 'user', content: 'How do I\npurify water?' },
    { role: 'assistant', content: 'Boil it.', sources: [{ id: 'purify', title: 'Purify [x]' }] },
    { role: 'user', content: 'And then?' },
    { role: 'assistant', content: 'Let it cool.', note: 'NO MODEL LINK' },
  ];
  const t = transcript(history, { model: 'llama3.2', now: new Date(2026, 10, 24, 9, 5) });
  assert.equal(t.title, 'ADVISOR: How do I purify water?');
  assert.deepEqual(t.tags, ['advisor']);
  assert.match(t.body, /^_Advisor conversation saved 2026-11-24 09:05 · model llama3\.2\./);
  assert.match(t.body, /### Q: How do I purify water\?\n\nBoil it\.\n\n_Sources: \[Purify x\]\(#\/manual\/purify\)_/);
  assert.match(t.body, /> NO MODEL LINK\n\nLet it cool\./);
  assert.deepEqual(exchange(history, 3), history.slice(2, 4));
  assert.deepEqual(exchange(history, 0), history.slice(0, 2));
  assert.ok(transcript([{ role: 'user', content: 'x'.repeat(300) }]).title.length <= 120);
});
