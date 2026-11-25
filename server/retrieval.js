// Advisor retrieval: optional embeddings over the field manual, with the keyword search as fallback.
// The ranking maths is pure and tested; EmbeddingIndex builds and caches vectors in the background.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { embed } from './ai.js';

/** Names of common embedding models, used to pick one automatically from the installed models. */
const EMBED_NAME = /embed|nomic|bge|minilm|mxbai|arctic|granite-embedding|(?:^|[^a-z])e5(?:[^a-z]|$)|(?:^|[^a-z])gte(?:[^a-z]|$)/i;

export const isEmbedModel = (name) => EMBED_NAME.test(String(name || ''));

/** The embedding model to use: the configured one, else the first installed embedding model, else ''. */
export function pickEmbedModel(configured, installed = []) {
  if (configured) return configured;
  return installed.find(isEmbedModel) || '';
}

/** Cosine similarity of two equal-length vectors; 0 when either has no length. */
export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Indexes of the k vectors most similar to query, best first, with their scores: [{ i, score }]. */
export function nearest(query, vectors, k) {
  const scored = [];
  for (let i = 0; i < vectors.length; i++) scored.push({ i, score: cosine(query, vectors[i]) });
  return scored.toSorted((x, y) => y.score - x.score).slice(0, k);
}

/**
 * Reciprocal rank fusion of several rankings (lists of keys, best first): each key scores the sum
 * of 1 / (k + rank). Returns the keys, best first. Keys missing from a ranking add nothing for it.
 */
export function fuse(rankings, k = 60) {
  const score = new Map();
  for (const list of rankings) list.forEach((key, rank) => score.set(key, (score.get(key) || 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

/** Stable key of one passage. */
export const passageKey = (p) => crypto.createHash('sha1').update(`${p.article.id}\n${p.heading}\n${p.text}`).digest('hex').slice(0, 16);

/** The text embedded for a passage: its title and heading give the vector context. */
const passageText = (p) => `${p.article.title}${p.heading ? ' — ' + p.heading : ''}\n${p.text}`.slice(0, 2000);

const BATCH = 16;
const round = (v) => v.map((x) => Math.round(x * 1e5) / 1e5);

/**
 * Embedding vectors for every manual passage, for one model. build() runs in the background and
 * saves vectors to cacheDir so a restart does not embed again; unchanged passages are reused.
 */
export class EmbeddingIndex {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.model = '';
    this.signature = null;
    this.passages = [];
    this.vectors = [];
    this.building = null;
    this.progress = { done: 0, total: 0 };
    this.error = null;
  }

  #cacheFile(model) {
    return path.join(this.cacheDir, `embeddings-${model.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}.json`);
  }

  /** Whether vectors exist for exactly these passages and this model. */
  ready(model, signature) {
    return !this.building && this.model === model && this.signature === signature && this.vectors.length === this.passages.length && this.passages.length > 0;
  }

  status(model, signature) {
    return {
      model, ready: this.ready(model, signature), building: !!this.building,
      done: this.progress.done, total: this.progress.total, error: this.error,
    };
  }

  /** Starts building vectors for passages (when not already built or building). Never throws. */
  build(ai, model, passages, signature) {
    if (this.ready(model, signature) || this.building) return this.building;
    this.error = null;
    this.building = this.#build(ai, model, passages, signature)
      .catch((error) => { this.error = error.message; })
      .finally(() => { this.building = null; });
    return this.building;
  }

  async #build(ai, model, passages, signature) {
    const file = this.#cacheFile(model);
    let cached = {};
    try { cached = JSON.parse(fs.readFileSync(file, 'utf8')).vectors || {}; } catch { /* no cache yet */ }
    const keys = passages.map(passageKey);
    const todo = keys.map((k, i) => (cached[k] ? -1 : i)).filter((i) => i >= 0);
    this.progress = { done: keys.length - todo.length, total: keys.length };
    for (let at = 0; at < todo.length; at += BATCH) {
      const batch = todo.slice(at, at + BATCH);
      // One batch at a time: a small machine runs the model on its CPU.
      // eslint-disable-next-line no-await-in-loop -- batches go one after another on purpose
      const vecs = await embed(ai, model, batch.map((i) => passageText(passages[i])), AbortSignal.timeout(120_000));
      batch.forEach((i, j) => { cached[keys[i]] = round(vecs[j]); });
      this.progress.done += batch.length;
    }
    const vectors = Object.fromEntries(keys.map((k) => [k, cached[k]]));
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ model, vectors }));
    fs.renameSync(file + '.tmp', file);
    Object.assign(this, { model, signature, passages, vectors: keys.map((k) => vectors[k]) });
  }

  /** The k passages nearest to a query vector: [{ passage, score }]. */
  search(queryVector, k) {
    return nearest(queryVector, this.vectors, k).map(({ i, score }) => ({ passage: this.passages[i], score }));
  }
}

/**
 * Best passages for a question. With an embedding model and a ready index, vector and keyword
 * rankings are fused; otherwise (no model, index still building, any error) the keyword passages
 * are used as they are. Returns { passages, mode: 'embeddings' | 'keyword' }.
 */
export async function retrieve({ manual, index, ai, embedModel, question, limit = 4 }) {
  const keyword = manual.passages(question, limit * 2);
  const fallback = { passages: keyword.slice(0, limit), mode: 'keyword' };
  if (!embedModel || !index) return fallback;
  const all = manual.chunks();
  const signature = manual.signature;
  if (!index.ready(embedModel, signature)) {
    index.build(ai, embedModel, all, signature);
    return fallback;
  }
  try {
    const [q] = await embed(ai, embedModel, [question.slice(0, 2000)], AbortSignal.timeout(8000));
    const near = index.search(q, limit * 2).filter((x) => x.score > 0.2);
    const byKey = new Map([...keyword, ...near.map((x) => x.passage)].map((p) => [passageKey(p), p]));
    const order = fuse([near.map((x) => passageKey(x.passage)), keyword.map(passageKey)]);
    const passages = order.slice(0, limit).map((key) => byKey.get(key));
    return passages.length ? { passages, mode: 'embeddings' } : fallback;
  } catch {
    return fallback;
  }
}
