// Model downloads: name checks, size lookup and a RAM/disk fit check before an Ollama pull.

const GB = 1024 ** 3;

/** Ollama model names: [namespace/]name[:tag], letters, digits and . _ - only. */
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}(?:\/[a-z0-9][a-z0-9._-]{0,79})?(?::[a-z0-9][a-z0-9._-]{0,79})?$/i;

/** The name trimmed, or null when it is not a model name Shelter will ask Ollama to pull. */
export function modelName(name) {
  const s = String(name ?? '').trim();
  return MODEL_NAME.test(s) && !s.includes('..') ? s : null;
}

/** { repo, tag } of a model name: "llama3.2:3b" is library/llama3.2, tag 3b. */
export function splitName(name) {
  const [path, tag = 'latest'] = name.split(':');
  return { repo: path.includes('/') ? path : `library/${path}`, tag };
}

/**
 * Download size estimated from the parameter count in the tag ("3b", "1.5b", "270m"), assuming
 * the 4-bit quantisation Ollama serves by default (about 0.6 bytes per parameter). null when unknown.
 */
export function estimateSize(name) {
  const { tag } = splitName(name);
  const m = /(?:^|[^a-z0-9.])(\d{1,4}(?:\.\d{1,2})?)([bm])(?![a-z])/i.exec(`-${tag}`);
  if (!m) return null;
  const params = Number(m[1]) * (m[2].toLowerCase() === 'b' ? 1e9 : 1e6);
  return Math.round(params * 0.6);
}

/** Total layer size of a model in the Ollama registry, or null when it cannot be reached. */
export async function registrySize(name, { registry = 'https://registry.ollama.ai', timeout = 6000 } = {}) {
  const { repo, tag } = splitName(name);
  try {
    const r = await fetch(`${registry}/v2/${repo}/manifests/${tag}`, {
      headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' },
      signal: AbortSignal.timeout(timeout),
    });
    if (r.status === 404) return { size: null, missing: true };
    if (!r.ok) return null;
    const data = await r.json();
    const size = (data.layers || []).reduce((s, l) => s + (+l.size || 0), 0);
    return size > 0 ? { size, missing: false } : null;
  } catch {
    return null;
  }
}

/**
 * Whether a model of size bytes fits this machine. Running a model needs about its file size in
 * RAM plus working memory; downloading needs the file size on disk.
 * Returns { verdict: 'ok' | 'tight' | 'too-big' | 'unknown', ramNeeded, reasons }.
 */
export function modelFit({ size, memTotal, memFree, diskFree }) {
  if (!Number.isFinite(size) || size <= 0) {
    return { verdict: 'unknown', ramNeeded: null, reasons: ['The model size is unknown: check it on ollama.com before pulling.'] };
  }
  const ramNeeded = Math.round(size * 1.2 + 0.5 * GB);
  const reasons = [];
  let verdict = 'ok';
  if (Number.isFinite(diskFree) && size * 1.05 > diskFree) {
    verdict = 'too-big';
    reasons.push('Not enough free disk space for the download.');
  }
  if (Number.isFinite(memTotal) && ramNeeded > memTotal) {
    verdict = 'too-big';
    reasons.push('The model needs more memory than this machine has; it would not load, or would be very slow.');
  } else if (Number.isFinite(memTotal) && ramNeeded > memTotal * 0.75) {
    if (verdict === 'ok') verdict = 'tight';
    reasons.push('The model would use most of this machine\'s memory; other services may slow down.');
  } else if (Number.isFinite(memFree) && ramNeeded > memFree) {
    if (verdict === 'ok') verdict = 'tight';
    reasons.push('Less memory is free right now than the model needs; close other services before using it.');
  }
  return { verdict, ramNeeded, reasons };
}
