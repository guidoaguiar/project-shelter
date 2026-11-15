// 03 ADVISOR — local-model chat grounded in the field manual. Falls back to manual lookup with no model.
import { h, state, onStatus, viewHeader, panel, toast } from '../lib/core.js';
import { md } from '../lib/md.js';

const history = []; // { role, content, sources?, note? } — kept while the tab stays open
let busy = null;    // AbortController while a reply is streaming

const STARTERS = [
  'How do I make stream water safe to drink?',
  'Someone is shivering and confused. What do I do?',
  'How do I find north without a compass?',
  'How do I keep food without a fridge?',
];

export async function render(root) {
  const log = h('div.chat-log');
  const input = h('textarea', { placeholder: 'Ask a question. Enter to send, Shift+Enter for a new line.', 'aria-label': 'Question' });
  const send = h('button.btn.primary', 'SEND');
  const mode = h('span.code');

  function paintMode() {
    const ai = state.status?.ai;
    mode.textContent = ai?.online && ai.model ? `MODEL ${ai.model.toUpperCase()}` : 'MANUAL LOOKUP MODE';
  }

  function bubble(m, streaming) {
    const el = h('div.msg.' + m.role, h('div.who', m.role === 'user' ? 'YOU' : 'ADVISOR'));
    if (m.role === 'user') el.append(h('div.body', m.content));
    else {
      if (m.note) el.append(h('div.hint', { style: 'margin-bottom:6px' }, m.note));
      el.append(h('div.prose' + (streaming ? '.cursor' : ''), { html: md(m.content || '') }));
      if (m.sources?.length) {
        el.append(h('div.sources', h('span.hint', 'SOURCES'),
          m.sources.map((s) => h('a.tag', { href: `#/manual/${s.id}` }, s.title))));
      }
    }
    return el;
  }

  function paint() {
    if (!history.length) {
      log.replaceChildren(h('div', { style: 'margin:auto;max-width:520px;text-align:center' },
        h('div.empty', 'ADVISOR READY'),
        h('p.hint', { style: 'margin-bottom:14px' }, 'Answers draw on the field manual stored on this node. With no model linked, the advisor returns the closest manual entries instead.'),
        h('div.row', { style: 'justify-content:center' }, STARTERS.map((q) => h('button.btn.ghost', { style: 'text-transform:none;letter-spacing:.02em', onclick: () => ask(q) }, q)))));
      return;
    }
    log.replaceChildren(...history.map((m, i) => bubble(m, busy && i === history.length - 1)));
    log.scrollTop = log.scrollHeight;
  }

  async function ask(text) {
    const q = (text ?? input.value).trim();
    if (!q || busy) return;
    input.value = '';
    history.push({ role: 'user', content: q });
    const reply = { role: 'assistant', content: '', sources: [] };
    history.push(reply);
    busy = new AbortController();
    send.textContent = 'STOP';
    paint();
    try {
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: busy.signal,
        body: JSON.stringify({ messages: history.slice(0, -1).map(({ role, content }) => ({ role, content })) }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'sources') reply.sources = ev.items;
          else if (ev.type === 'delta') reply.content += ev.text;
          else if (ev.type === 'error') reply.content += `\n\n> **FAULT** ${ev.message}`;
          else if (ev.type === 'offline') {
            reply.note = `NO MODEL LINK (${ev.reason}). Showing the closest field manual entries.`;
            reply.content = reply.sources.length
              ? reply.sources.map((s) => `**${s.title}** — ${s.summary}`).join('\n\n')
              : 'Nothing in the field manual matches that question. Try different words, or browse the Manual module.';
          }
          paint();
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') { reply.content += `\n\n> **FAULT** ${e.message}`; toast(e.message, true); }
    }
    busy = null;
    send.textContent = 'SEND';
    paint();
  }

  send.addEventListener('click', () => (busy ? busy.abort() : ask()));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });

  root.append(
    viewHeader('03', 'ADVISOR', 'Ask in plain language. Runs on a local model; nothing leaves this node.',
      h('button.btn.ghost', { onclick: () => { if (!busy) { history.length = 0; paint(); } } }, 'CLEAR')),
    h('section.panel', h('div.ph', h('span', 'CHANNEL'), mode),
      h('div.chat', log, h('div.chat-in', input, send))),
    h('p.hint', { style: 'margin-top:8px' }, 'Models make mistakes. For anything that matters, open the cited manual entry and check it.'));

  paintMode();
  paint();
  return onStatus(paintMode);
}
