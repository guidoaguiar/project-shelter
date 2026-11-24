import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manual } from '../server/manual.js';
import { tmpDir } from './helpers.js';

function fixture(t) {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, '01-water.md'), [
    '# Boiling',
    'tags: Purify, Heat',
    '',
    'Bring water to a rolling boil for one minute to kill pathogens; at altitude boil for three minutes.',
    '',
    '## Fuel',
    '',
    'Boiling needs fuel.',
    '',
    '# Filters',
    'A ceramic filter removes protozoa and bacteria from water but not viruses or dissolved chemicals.',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '02-fire.md'), 'category: Firecraft\n\n# Tinder\nDry, fine material such as birch bark catches a spark and grows into a flame quickly.\n');
  fs.mkdirSync(path.join(dir, 'chapters', 'img'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chapters', '01-shelter.md'), [
    'category: Shelter',
    'group: Shelters',
    '',
    '# Shelters',
    `${'Long introduction about choosing a site, staying dry and keeping out of the wind. '.repeat(5)}`,
    '',
    '# Lean-to',
    '- a list is not a summary',
    '',
    'A lean-to is a sloped roof of branches against a ridge pole; build it with its back to the wind.',
    '',
    '# Lean-to',
    'Second entry with the same title gets its own id because the first one already took it.',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'chapters', 'notes.md'), '# Ignored\nFiles in subfolders must start with a number.');
  return dir;
}

test('parses sections, chapters, tags, summaries and ids', (t) => {
  const m = new Manual(fixture(t));
  const index = m.index();
  assert.deepEqual(index.map((a) => [a.id, a.category, a.group]), [
    ['boiling', 'WATER', ''], ['filters', 'WATER', ''], ['tinder', 'FIRECRAFT', ''],
    ['shelters', 'SHELTER', 'Shelters'], ['shelters-lean-to', 'SHELTER', 'Shelters'], ['shelters-lean-to-2', 'SHELTER', 'Shelters'],
  ]);
  assert.deepEqual(index[0].tags, ['purify', 'heat']);
  assert.match(index[0].summary, /^Bring water to a rolling boil/);
  assert.match(index[4].summary, /^A lean-to is a sloped roof/, 'lists are skipped when picking a summary');
  assert.ok(index[3].summary.length <= 238 && index[3].summary.endsWith('…'), 'long summaries are cut at a word');
});

test('get() returns the body, neighbours in the same section, and the figure folder', (t) => {
  const m = new Manual(fixture(t));
  const a = m.get('filters');
  assert.equal(a.prev.id, 'boiling');
  assert.equal(a.next, null, 'next entry is in another section');
  assert.equal(a.imgBase, null);
  assert.equal(m.get('shelters-lean-to').imgBase, '/content/chapters/');
  assert.equal(m.get('nope'), null);
  assert.ok(m.imageDir('chapters').endsWith(path.join('chapters', 'img')));
  assert.equal(m.imageDir('../etc'), null);
});

test('search ranks by relevance and matches prefixes', (t) => {
  const m = new Manual(fixture(t));
  assert.equal(m.search('boil water')[0].id, 'boiling');
  assert.equal(m.search('purif')[0].id, 'boiling', 'prefix of a tag');
  assert.equal(m.search('lean')[0].group, 'Shelters');
  assert.match(m.search('ceramic')[0].snippet, /ceramic filter/);
  assert.deepEqual(m.search('the and of'), [], 'stop words only');
  assert.deepEqual(m.search('zzzz'), []);
});

test('passages split articles at subheadings', (t) => {
  const m = new Manual(fixture(t));
  const p = m.passages('boiling fuel', 4);
  assert.ok(p.length >= 2);
  assert.ok(p.some((x) => x.article.id === 'boiling' && x.heading === 'Fuel'));
  assert.deepEqual(m.passages(''), []);
});

test('reloads when files change', (t) => {
  const dir = fixture(t);
  const m = new Manual(dir);
  const before = m.index().length;
  fs.writeFileSync(path.join(dir, '03-new.md'), '# Fresh entry\nAdded while running, and found without a restart of the node.');
  assert.equal(m.index().length, before + 1);
});

test('a missing folder gives an empty manual', (t) => {
  assert.deepEqual(new Manual(path.join(tmpDir(t), 'none')).index(), []);
});

test('shipped content: emergencies section, first aid cards and the radio reference', () => {
  const manual = new Manual(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'content', 'manual'));
  const index = manual.index();
  const ids = index.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'entry ids are unique');

  const emergencies = index.filter((a) => a.category === 'EMERGENCIES');
  assert.ok(emergencies.length >= 10, `EMERGENCIES has ${emergencies.length} entries`);

  const cards = index.filter((a) => a.tags.includes('card'));
  assert.ok(cards.length >= 10, `${cards.length} first aid cards`);
  for (const c of cards) {
    const body = manual.get(c.id).body.replaceAll('*', '');
    assert.match(body, /^Call emergency services/, `${c.title} starts with the call to emergency services`);
    assert.match(body, /\nSources?: /, `${c.title} cites a source`);
    assert.equal(c.category, 'MEDICAL');
    assert.equal(c.group, 'First Aid Cards');
    const steps = body.match(/^\d+\. /gm) || [];
    assert.ok(steps.length <= 8, `${c.title} has at most 8 numbered steps`);
  }

  for (const [q, want] of [['earthquake', 'Earthquake'], ['CPR', 'CPR'], ['shelter in place', 'Shelter in Place'], ['NOAA weather radio frequency', 'Emergency Radio Frequencies']]) {
    const hits = manual.search(q, 3).map((a) => a.title);
    assert.ok(hits.includes(want), `"${q}" finds ${want}: got ${hits.join(', ')}`);
  }
});
