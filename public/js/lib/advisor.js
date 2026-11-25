// Advisor helpers: the saved conversation and its Log transcript. Pure functions, no DOM.

export const HISTORY_KEY = 'shelter.advisor.history';
/** Most messages kept on this device (the oldest are dropped first). */
export const MAX_SAVED = 60;

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One message as it is stored: only known fields, with bounded lengths. null when it is not a message. */
function clean(m) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
  const out = { role: m.role, content: text(m.content, 20_000) };
  if (m.note) out.note = text(m.note, 300);
  if (m.household) out.household = true;
  if (Array.isArray(m.sources)) {
    out.sources = m.sources.slice(0, 12).filter((s) => s && typeof s.id === 'string')
      .map((s) => ({ id: text(s.id, 200), title: text(s.title, 200), category: text(s.category, 80), summary: text(s.summary, 400) }));
  }
  return out;
}

/** The conversation saved on this device, or [] when there is none or it cannot be read. */
export function loadHistory(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(saved) ? saved.map(clean).filter(Boolean).slice(-MAX_SAVED) : [];
  } catch {
    return [];
  }
}

/** Saves the conversation on this device. Returns false when storage is unavailable or full. */
export function saveHistory(storage, history) {
  try {
    const keep = history.map(clean).filter((m) => m && (m.content || m.note)).slice(-MAX_SAVED);
    if (keep.length) storage.setItem(HISTORY_KEY, JSON.stringify(keep));
    else storage.removeItem(HISTORY_KEY);
    return true;
  } catch {
    return false;
  }
}

const pad2 = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const oneLine = (s) => s.replaceAll(/\s+/g, ' ').trim();
/** A manual source as a Markdown link to its entry. */
const link = (s) => '[' + s.title.replaceAll(/[[\]]/g, '') + '](#/manual/' + s.id + ')';

/**
 * A Log entry for messages of the conversation: { title, body, tags }. The title is the first
 * question; each answer keeps its manual sources as links.
 */
export function transcript(messages, { model = '', now = new Date() } = {}) {
  const first = messages.find((m) => m.role === 'user');
  const q = first ? oneLine(first.content) : 'conversation';
  const title = `ADVISOR: ${q.length > 100 ? q.slice(0, 99) + '…' : q}`;
  const by = model ? ' · model ' + model : '';
  const head = `_Advisor conversation saved ${stamp(now)}${by}. Check anything that matters against the manual._`;
  const parts = messages.map((m) => {
    if (m.role === 'user') return `### Q: ${oneLine(m.content)}`;
    const note = m.note ? '> ' + m.note + '\n\n' : '';
    const sources = m.sources?.length ? '\n\n_Sources: ' + m.sources.map(link).join(', ') + '_' : '';
    return `${note}${m.content.trim()}${sources}`;
  });
  return { title: title.slice(0, 120), body: [head, ...parts].join('\n\n'), tags: ['advisor'] };
}

/** The question and answer around message i (an answer, or the question before it). */
export function exchange(history, i) {
  const at = history[i]?.role === 'user' ? i : i - 1;
  return history.slice(Math.max(0, at), at + 2);
}
