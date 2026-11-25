// Configuration, host only: pull an Ollama model with a size and memory check first, and the
// Advisor's options (household context, embedding model).
import { h, api, state, bytes, toast, field, isHost, saveSettings, refreshStatus } from '../../lib/core.js';

const SUGGESTED = [
  ['llama3.2:1b', 'small chat model, runs on 4 GB'],
  ['llama3.2:3b', 'chat model, about 2 GB'],
  ['qwen2.5:3b', 'chat model, about 2 GB'],
  ['gemma3:4b', 'chat model, about 3 GB'],
  ['nomic-embed-text', 'embeddings for better manual search'],
];

const VERDICT = {
  ok: ['FITS', 'This machine has the memory and disk space for it.'],
  tight: ['TIGHT', 'It should run, but it will use most of the memory.'],
  'too-big': ['TOO BIG', 'This machine is unlikely to run it.'],
  unknown: ['UNKNOWN SIZE', 'The size could not be found.'],
};

/** Calls onEvent for each NDJSON line of a streamed response body. */
async function readEvents(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (buf + dec.decode(value, { stream: true })).split('\n');
    buf = lines.pop();
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
  }
  if (buf.trim()) onEvent(JSON.parse(buf));
}

function pullBox() {
  const name = h('input', { placeholder: 'llama3.2:3b', list: 'pull-models', autocomplete: 'off', 'aria-label': 'Model to pull' });
  const options = h('datalist', { id: 'pull-models' }, SUGGESTED.map(([v, label]) => h('option', { value: v }, label)));
  const check = h('button.btn', { type: 'button' }, 'CHECK');
  const go = h('button.btn.primary', { type: 'button', disabled: true }, 'PULL MODEL');
  const report = h('div.model-check');
  const bar = h('progress.model-progress', { max: 1, value: 0, hidden: true });
  const line = h('div.hint');
  let checked = null, pulling = null;

  name.addEventListener('input', () => { checked = null; go.disabled = true; report.replaceChildren(); });

  check.addEventListener('click', async () => {
    const model = name.value.trim();
    if (!model) return;
    check.disabled = true;
    report.replaceChildren(h('span.hint', 'CHECKING…'));
    try {
      const r = await api('/api/ai/pull/check', { method: 'POST', body: { model } });
      checked = r;
      const [label, text] = VERDICT[r.fit.verdict] || VERDICT.unknown;
      let sizeText = r.size ? bytes(r.size) : 'unknown';
      if (r.size && r.source === 'estimate') sizeText += ' (estimated from the name)';
      report.replaceChildren(
        h('div', h('span.tag' + (r.fit.verdict === 'too-big' ? '.bad' : ''), label), ' ', text),
        h('div.hint', `Download ${sizeText} · needs about ${r.fit.ramNeeded ? bytes(r.fit.ramNeeded) : '?'} of memory · this machine: ${bytes(r.memTotal)} memory (${bytes(r.memFree)} free), ${r.diskFree == null ? '?' : bytes(r.diskFree)} free disk`),
        ...r.fit.reasons.map((x) => h('div.hint', x)));
      go.disabled = false;
    } catch (error) {
      report.replaceChildren(h('span.hint', error.message));
    }
    check.disabled = false;
  });

  go.addEventListener('click', async () => {
    if (pulling) { pulling.abort(); return; }
    if (!checked) return;
    if (checked.fit.verdict === 'too-big' && !confirm(`${checked.model} looks too big for this machine. Pull it anyway?`)) return;
    pulling = new AbortController();
    go.textContent = 'STOP';
    bar.hidden = false; bar.value = 0;
    line.textContent = 'STARTING…';
    let failed = null;
    try {
      const r = await fetch('/api/ai/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: checked.model }), signal: pulling.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await readEvents(r.body, (ev) => {
        if (ev.type === 'progress') {
          bar.value = ev.total ? ev.completed / ev.total : 0;
          line.textContent = ev.total ? `${ev.status.toUpperCase()} ${bytes(ev.completed)} / ${bytes(ev.total)}` : ev.status.toUpperCase();
        } else if (ev.type === 'error') failed = ev.message;
      });
    } catch (error) {
      failed = error.name === 'AbortError' ? 'stopped' : error.message;
    }
    pulling = null;
    go.textContent = 'PULL MODEL';
    bar.hidden = true;
    line.textContent = failed ? `PULL FAILED: ${failed}` : `${checked.model} INSTALLED`;
    toast(failed ? `pull failed: ${failed}` : 'MODEL INSTALLED', !!failed);
    await refreshStatus();
  });

  return h('div.model-pull',
    h('div.row', field('PULL A MODEL (OLLAMA)', name), check, go), options, report, bar, line);
}

function advisorOptions() {
  const ai = state.settings?.ai || {};
  const local = state.status?.ai?.householdLocal !== false;
  const household = h('input', { type: 'checkbox', checked: !!ai.householdContext });
  const embedModel = h('input', { value: ai.embedModel || '', placeholder: 'AUTO (AN INSTALLED EMBEDDING MODEL)', list: 'models', autocomplete: 'off' });
  const save = h('button.btn', { type: 'button' }, 'SAVE ADVISOR OPTIONS');
  save.addEventListener('click', async () => {
    try {
      await saveSettings({ ai: { householdContext: household.checked, embedModel: embedModel.value.trim() } });
      toast('ADVISOR OPTIONS SAVED');
    } catch (error) { toast(error.message, true); }
  });
  return h('div.advisor-options',
    h('label.advisor-check', household, ' Give the Advisor household context: people, ages, allergies, conditions and medications from the plan.'),
    h('p.hint', local
      ? 'Only sent to the model server configured above, and only for devices that may see household data.'
      : 'The model server above is not on this machine or the local network, so household context will not be sent to it.'),
    h('div.row', field('EMBEDDING MODEL', embedModel), save),
    h('p.hint', 'With an embedding model installed (for example nomic-embed-text) the Advisor finds manual passages by meaning; without one it uses keyword search.'));
}

/** The model tools for the Configuration panel; null on other devices. */
export function modelTools() {
  if (!isHost()) return null;
  const ollama = (state.settings?.ai?.provider || 'ollama') === 'ollama';
  return h('div.pb.model-tools',
    h('div.model-tools-title', 'ADVISOR AND MODELS'),
    ollama ? pullBox() : h('p.hint', 'Pulling models is only available for an Ollama server.'),
    advisorOptions());
}
