// 03 ADVISOR — local-model chat grounded in the field manual. Falls back to manual lookup with no model.
// The conversation is kept in this browser's storage, so it survives leaving the view and reloads.
import { h, api, state, onStatus, viewHeader, toast, isGuest } from '../lib/core.js';
import { md } from '../lib/md.js';
import { loadHistory, saveHistory, transcript, exchange } from '../lib/advisor.js';

/** This browser's storage, or null where it is blocked (private mode, sandboxed frames). */
function storage() {
  try { return window.localStorage; } catch { return null; }
}

const history = loadHistory(storage()); // { role, content, sources?, note?, household? }
let busy = null;      // AbortController while a reply is streaming
let repaint = () => {}; // redraws the open view; a reply keeps streaming when the view is left

const persist = () => saveHistory(storage(), history);

const STARTERS = [
  'How do I make stream water safe to drink?',
  'Someone is shivering and confused. What do I do?',
  'How do I find north without a compass?',
  'How do I keep food without a fridge?',
];

/** Calls onLine for each non-blank line of a streamed body, as the bytes arrive. */
async function readLines(reader, onLine, dec = new TextDecoder(), buf = '') {
  const { value, done } = await reader.read();
  if (done) return;
  const lines = (buf + dec.decode(value, { stream: true })).split('\n');
  const rest = lines.pop(); // incomplete last line: wait for more bytes
  for (const line of lines) if (line.trim()) onLine(line);
  await readLines(reader, onLine, dec, rest);
}

/** Updates the reply being built from one server event (see /api/chat). */
function applyEvent(reply, ev) {
  if (ev.type === 'sources') reply.sources = ev.items;
  else if (ev.type === 'context') reply.household = !!ev.household;
  else if (ev.type === 'delta') reply.content += ev.text;
  else if (ev.type === 'error') reply.content += `\n\n> **FAULT** ${ev.message}`;
  else if (ev.type === 'offline') {
    reply.note = `NO MODEL LINK (${ev.reason}). Showing the closest field manual entries.`;
    reply.content = reply.sources.length
      ? reply.sources.map((s) => `**${s.title}** — ${s.summary}`).join('\n\n')
      : 'Nothing in the field manual matches that question. Try different words, or browse the Manual module.';
  }
}

/** Saves messages as a new Log entry. */
async function saveToLog(messages) {
  if (!messages.some((m) => m.content)) return;
  try {
    await api('/api/db/notes', { method: 'POST', body: transcript(messages, { model: state.status?.ai?.model || '' }) });
    toast('SAVED TO LOG');
  } catch (error) { toast(error.message, true); }
}

async function ask(text) {
  const q = String(text ?? '').trim();
  if (!q || busy) return;
  history.push({ role: 'user', content: q });
  const reply = { role: 'assistant', content: '', sources: [] };
  history.push(reply);
  busy = new AbortController();
  repaint();
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: busy.signal,
      body: JSON.stringify({ messages: history.slice(0, -1).map(({ role, content }) => ({ role, content })) }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    await readLines(r.body.getReader(), (line) => { applyEvent(reply, JSON.parse(line)); repaint(); });
  } catch (error) {
    if (error.name !== 'AbortError') { reply.content += `\n\n> **FAULT** ${error.message}`; toast(error.message, true); }
  }
  busy = null;
  persist();
  repaint();
}

/** "MODEL X · EMBEDDINGS · HOUSEHOLD" for the channel bar. */
function modeText() {
  const ai = state.status?.ai;
  if (!ai?.online || !ai.model) return 'MANUAL LOOKUP MODE';
  const parts = [`MODEL ${ai.model.toUpperCase()}`];
  const r = ai.retrieval;
  if (r?.mode === 'embeddings') parts.push('EMBEDDINGS');
  else if (r?.building) parts.push(`INDEXING ${r.done}/${r.total}`);
  if (ai.household && !isGuest()) parts.push('HOUSEHOLD CONTEXT');
  return parts.join(' · ');
}

export function render(root, _arg, { code } = {}) {
  const log = h('div.chat-log');
  const input = h('textarea', { placeholder: 'Ask a question. Enter to send, Shift+Enter for a new line.', 'aria-label': 'Question' });
  const send = h('button.btn.primary', 'SEND');
  const mode = h('span.code');
  const guest = isGuest();

  const paintMode = () => { mode.textContent = modeText(); };

  function bubble(m, i, streaming) {
    const el = h('div.msg.' + m.role, h('div.who', m.role === 'user' ? 'YOU' : 'ADVISOR'));
    if (m.role === 'user') { el.append(h('div.body', m.content)); return el; }
    if (m.note) el.append(h('div.hint', { style: 'margin-bottom:6px' }, m.note));
    if (m.household) el.append(h('div.hint.advisor-household', 'USED THE HOUSEHOLD PLAN (PEOPLE, ALLERGIES, MEDICATIONS)'));
    el.append(h('div.prose' + (streaming ? '.cursor' : ''), { html: md(m.content || '') }));
    const foot = h('div.sources');
    if (m.sources?.length) foot.append(h('span.hint', 'SOURCES'), ...m.sources.map((s) => h('a.tag', { href: `#/manual/${s.id}` }, s.title)));
    if (!guest && !streaming && m.content) {
      foot.append(h('button.btn.ghost.advisor-save', { type: 'button', title: 'Save this question and answer as a Log entry', onclick: () => saveToLog(exchange(history, i)) }, 'SAVE TO LOG'));
    }
    if (foot.childNodes.length) el.append(foot);
    return el;
  }

  function paint() {
    send.textContent = busy ? 'STOP' : 'SEND';
    if (!history.length) {
      log.replaceChildren(h('div', { style: 'margin:auto;max-width:520px;text-align:center' },
        h('div.empty', 'ADVISOR READY'),
        h('p.hint', { style: 'margin-bottom:14px' }, 'Answers draw on the field manual stored on this node. With no model linked, the advisor returns the closest manual entries instead.'),
        h('div.row', { style: 'justify-content:center' }, STARTERS.map((q) => h('button.btn.ghost', { style: 'text-transform:none;letter-spacing:.02em', onclick: () => ask(q) }, q)))));
      return;
    }
    log.replaceChildren(...history.map((m, i) => bubble(m, i, busy && i === history.length - 1)));
    log.scrollTop = log.scrollHeight;
  }
  repaint = paint;

  const submit = () => {
    const q = input.value;
    input.value = '';
    return ask(q);
  };
  send.addEventListener('click', () => (busy ? busy.abort() : submit()));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    return submit();
  });

  const clear = () => {
    if (busy || !history.length) return;
    if (!confirm('Clear this conversation from this device?')) return;
    history.length = 0;
    persist();
    paint();
  };

  root.append(
    viewHeader(code, 'ADVISOR', 'Ask in plain language. Runs on a local model; nothing leaves this node.',
      guest ? null : h('button.btn.ghost', { onclick: () => (busy ? null : saveToLog(history)) }, 'SAVE TO LOG'),
      h('button.btn.ghost', { onclick: clear }, 'CLEAR')),
    h('section.panel', h('div.ph', h('span', 'CHANNEL'), mode),
      h('div.chat', log, h('div.chat-in', input, send))),
    h('p.hint', { style: 'margin-top:8px' }, 'Models make mistakes. For anything that matters, open the cited manual entry and check it. The conversation is kept on this device until you clear it.'));

  paintMode();
  paint();
  const off = onStatus(paintMode);
  return () => { off(); if (repaint === paint) repaint = () => {}; };
}
