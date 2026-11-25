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
  } catch (error) {
    value = { online: false, models: [], error: error.cause?.code || error.message };
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Drops the cached model list, so the next status check sees a model that was just pulled. */
export const forgetStatus = () => cache.clear();

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
  const parse = openai ? openaiEvent : ollamaEvent;
  for await (const line of lines(r.body)) {
    const ev = parse(line);
    if (ev?.done) break;
    if (ev?.text) onDelta(ev.text);
  }
}

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** One server-sent-events line of an OpenAI-style stream: { text }, { done } or null to skip. */
function openaiEvent(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (payload === '[DONE]') return { done: true };
  const obj = parseJson(payload);
  return obj && { text: obj.choices?.[0]?.delta?.content };
}

/** One NDJSON line of an Ollama stream: { text } or null to skip. Throws the server's error. */
function ollamaEvent(line) {
  const obj = parseJson(line);
  if (obj?.error) throw new Error(obj.error);
  return obj && { text: obj.message?.content };
}

/**
 * The system prompt. household: optional text from householdPrompt(), added only when the host has
 * allowed it and the model server is on this machine or the local network (see isLocalModelUrl).
 */
export function buildPrompt(passages, { household = '' } = {}) {
  const context = passages.map((p) => `### ${p.article.title}${p.heading ? ' — ' + p.heading : ''} [${p.article.category}]\n${p.text}`).join('\n\n');
  const lines = [
    'You are SHELTER ADVISOR, an offline field assistant for survival, self-reliance and preparedness.',
    'Answer concisely and practically. Use numbered steps for procedures.',
    'Ground your answer in the FIELD MANUAL excerpts below when they are relevant, and cite them by title in [brackets].',
    'If the excerpts do not cover the question, say so, then give careful general guidance.',
    'Never invent doses, quantities or frequencies. For medical problems give first-aid guidance and say when professional care is essential.',
  ];
  if (household) {
    lines.push('', 'HOUSEHOLD (from the household plan; take allergies, medications, ages and mobility into account when they matter):', household);
  }
  lines.push('', 'FIELD MANUAL EXCERPTS:', context || '(no relevant entries found)');
  return lines.join('\n');
}

// ---------- household context ----------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.home.arpa', '.localdomain'];

/** Whether an IPv4 address is loopback, private (RFC 1918), CGNAT or link-local. */
function privateV4(host) {
  const m = IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** Whether an IPv6 address is loopback, unique-local (fc00::/7) or link-local (fe80::/10). */
function privateV6(host) {
  const h = host.toLowerCase();
  if (h === '::1') return true;
  if (h.startsWith('::ffff:')) return privateV4(h.slice(7));
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
}

/**
 * Whether a model server URL points at this machine or the local network: a loopback or private
 * address, a single-label name (a Docker service such as "ollama") or a local suffix (.local, .lan,
 * .internal, .home.arpa). Household data is only ever sent to such a server.
 */
export function isLocalModelUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  host = host.replaceAll(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (IPV4.test(host)) return privateV4(host);
  if (host.includes(':')) return privateV6(host);
  if (!host.includes('.')) return true;
  return LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

const age = (birthYear, year) => (Number.isInteger(birthYear) ? year - birthYear : null);
const clipText = (s, max) => String(s || '').trim().slice(0, max);

/** "pet (dog)", "child, age 7" or "". */
function describe(p, year) {
  const group = clipText(p.group, 30);
  if (p.kind === 'pet') return group ? 'pet (' + group + ')' : 'pet';
  const a = age(p.birthYear, year);
  return [group, a === null ? null : 'age ' + a].filter(Boolean).join(', ');
}

/**
 * People and pets from the household plan as a short text for the system prompt: names, age group,
 * allergies, conditions, needs and medications. No contacts, places or blood types. '' when empty.
 */
export function householdPrompt(people, year = new Date().getFullYear()) {
  const lines = (Array.isArray(people) ? people : []).slice(0, 30).map((p) => {
    const who = describe(p, year);
    const meds = (p.medications || []).slice(0, 10).map((m) => [m.name, m.dose, m.schedule].map((x) => clipText(x, 60)).filter(Boolean).join(' ')).filter(Boolean);
    const parts = [
      p.allergies && `allergies: ${clipText(p.allergies, 300)}`,
      p.conditions && `conditions: ${clipText(p.conditions, 300)}`,
      p.needs && `needs: ${clipText(p.needs, 300)}`,
      meds.length && `medications: ${meds.join('; ')}`,
    ].filter(Boolean);
    const label = (clipText(p.name, 60) || 'unnamed') + (who ? ' (' + who + ')' : '');
    return '- ' + label + (parts.length ? ': ' + parts.join('; ') : '');
  });
  return lines.join('\n');
}

// ---------- embeddings and model downloads (Ollama; embeddings also on OpenAI-compatible servers) ----------

/** Embedding vectors for inputs (strings), in order. Throws when the server cannot embed. */
export async function embed(ai, model, inputs, signal) {
  const openai = ai.provider === 'openai';
  const r = await fetch(openai ? `${ai.baseUrl}/embeddings` : `${ai.baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(ai) },
    body: JSON.stringify({ model, input: inputs }),
    signal,
  });
  if (!r.ok) throw new Error(`embedding request returned HTTP ${r.status}`);
  const data = await r.json();
  const vectors = openai ? (data.data || []).map((d) => d.embedding) : data.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== inputs.length || !vectors.every((v) => Array.isArray(v) && v.length)) {
    throw new Error('the model server returned no embeddings');
  }
  return vectors;
}

/**
 * Pulls a model on an Ollama server, calling onProgress({ status, total, completed }) for each
 * progress line. Resolves when the pull succeeded; throws the server's error.
 */
export async function pullModel(ai, name, onProgress, signal) {
  const r = await fetch(`${ai.baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(ai) },
    body: JSON.stringify({ model: name, stream: true }),
    signal,
  });
  if (!r.ok) throw new Error(`model server returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  let ok = false;
  for await (const line of lines(r.body)) {
    const ev = parseJson(line);
    if (!ev) continue;
    if (ev.error) throw new Error(ev.error);
    if (ev.status === 'success') ok = true;
    onProgress({ status: String(ev.status || ''), total: +ev.total || 0, completed: +ev.completed || 0 });
  }
  forgetStatus();
  if (!ok) throw new Error('the pull ended before it finished');
}
