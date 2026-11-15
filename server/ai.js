// Local model link: Ollama or any OpenAI-compatible server (LM Studio, llama.cpp, ...).

const cache = new Map();

const authHeaders = (ai) => (ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {});

export async function aiStatus(ai) {
  const key = `${ai.provider}|${ai.baseUrl}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 8000) return hit.value;
  let value;
  try {
    const url = ai.provider === 'openai' ? `${ai.baseUrl}/models` : `${ai.baseUrl}/api/tags`;
    const r = await fetch(url, { headers: authHeaders(ai), signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const models = ai.provider === 'openai' ? (data.data || []).map((m) => m.id) : (data.models || []).map((m) => m.name);
    value = { online: true, models };
  } catch (e) {
    value = { online: false, models: [], error: e.cause?.code || e.message };
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function* lines(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) yield line; }
  }
  if (buf.trim()) yield buf.trim();
}

/** Streams a chat completion, calling onDelta(text) for each fragment. */
export async function streamChat(ai, model, messages, onDelta, signal) {
  const openai = ai.provider === 'openai';
  const r = await fetch(openai ? `${ai.baseUrl}/chat/completions` : `${ai.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(ai) },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!r.ok) throw new Error(`model server returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  for await (const line of lines(r.body)) {
    if (openai) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const text = obj.choices?.[0]?.delta?.content;
      if (text) onDelta(text);
    } else {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.error) throw new Error(obj.error);
      if (obj.message?.content) onDelta(obj.message.content);
    }
  }
}

export function buildPrompt(passages) {
  const context = passages.map((p) => `### ${p.article.title}${p.heading ? ' — ' + p.heading : ''} [${p.article.category}]\n${p.text}`).join('\n\n');
  return [
    'You are SHELTER ADVISOR, an offline field assistant for survival, self-reliance and preparedness.',
    'Answer concisely and practically. Use numbered steps for procedures.',
    'Ground your answer in the FIELD MANUAL excerpts below when they are relevant, and cite them by title in [brackets].',
    'If the excerpts do not cover the question, say so, then give careful general guidance.',
    'Never invent doses, quantities or frequencies. For medical problems give first-aid guidance and say when professional care is essential.',
    '',
    'FIELD MANUAL EXCERPTS:',
    context || '(no relevant entries found)',
  ].join('\n');
}
