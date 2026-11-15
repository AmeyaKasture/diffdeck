'use strict';

// Minimal test runner: node test/run.js

const assert = require('assert');
const { parseDiff } = require('../lib/diff');
const { resolve } = require('../lib/breakdown');
const { sanitize, render } = require('../lib/feedback');

const PATCH = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,4 +1,5 @@ function top() {
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;

 module.exports = x;
@@ -10,2 +11,2 @@
-old
+new
\\ No newline at end of file
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.md b/new name.md
similarity index 100%
rename from old name.md
rename to new name.md
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('parses files, statuses and paths', () => {
  const files = parseDiff(PATCH);
  assert.deepStrictEqual(files.map((f) => [f.path, f.status]), [
    ['src/a.js', 'modified'], ['new.txt', 'added'], ['gone.txt', 'deleted'], ['new name.md', 'renamed'], ['img.png', 'modified'],
  ]);
  assert.strictEqual(files[3].oldPath, 'old name.md');
  assert.strictEqual(files[4].binary, true);
});

test('tracks line numbers per side and counts', () => {
  const [a] = parseDiff(PATCH);
  assert.strictEqual(a.hunks.length, 2);
  assert.strictEqual(a.hunks[0].context, 'function top() {');
  const lines = a.hunks[0].lines;
  assert.deepStrictEqual(lines[1], { t: 'del', o: 2, s: 'const y = 2;' });
  assert.deepStrictEqual(lines[2], { t: 'add', n: 2, s: 'const y = 3;' });
  assert.deepStrictEqual(lines[4], { t: 'ctx', o: 3, n: 4, s: '' });
  assert.strictEqual(a.additions, 3);
  assert.strictEqual(a.deletions, 2);
  assert.strictEqual(a.hunks[1].lines[1].noEol, true);
});

test('resolves refs by hunk, line range and whole file; reports problems', () => {
  const files = parseDiff(PATCH);
  const base = { title: 't', summary: 's' };
  const ok = resolve({ ...base, cards: [
    { id: 'one', title: 'One', summary: '', kind: 'fix', risk: 'low', refs: [{ file: 'src/a.js', hunks: [0] }] },
    { id: 'two', title: 'Two', summary: '', kind: 'chore', risk: 'low', refs: [{ file: 'src/a.js', lines: [11, 11] }, { file: 'new.txt' }, { file: 'gone.txt' }] },
  ] }, files);
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.cards[1].hunks.map((h) => `${h.file}#${h.hunk}`), ['src/a.js#1', 'new.txt#0', 'gone.txt#0']);
  assert.strictEqual(ok.uncovered.length, 0);

  const bad = resolve({ ...base, cards: [
    { id: 'Bad Id', title: 'x', summary: '', kind: 'nope', risk: 'low', refs: [{ file: 'missing.js' }, { file: 'src/a.js', hunks: [9] }],
      decisions: [{ question: 'q', chosen: { label: 'a', description: '', pros: [], cons: [] }, alternatives: [] }] },
  ] }, files);
  const text = bad.errors.join('\n');
  assert.match(text, /kebab-case/);
  assert.match(text, /kind/);
  assert.match(text, /missing\.js/);
  assert.match(text, /no hunk 9/);
  assert.match(text, /alternatives/);
  assert.ok(bad.uncovered.length > 0);
});

test('validates system and logic flows', () => {
  const files = parseDiff(PATCH);
  const card = (flow) => ({ id: 'one', title: 'One', summary: '', kind: 'fix', risk: 'low', refs: [{ file: 'src/a.js' }],
    decisions: [{ question: 'q', chosen: { label: 'a', description: '', pros: [], cons: [] }, alternatives: [{ label: 'b', description: '', pros: [], cons: [] }] }], flow });
  const good = resolve({ title: 't', summary: 's',
    flow: { nodes: [{ id: 'a', label: 'A', type: 'actor' }, { id: 'b', label: 'B', type: 'component', change: 'added', card: 'one' }], edges: [{ from: 'a', to: 'b', label: 'calls' }] },
    cards: [card({ nodes: [{ id: 's', label: 'start', shape: 'start' }, { id: 'd', label: 'ok?', shape: 'decision', decision: 0, ref: { file: 'src/a.js', lines: [2, 3] } }], edges: [{ from: 's', to: 'd' }] })],
  }, files);
  assert.deepStrictEqual(good.errors, []);
  const bad = resolve({ title: 't', summary: 's',
    flow: { nodes: [{ id: 'a', label: 'A', type: 'robot' }, { id: 'a', label: 'B', type: 'component', card: 'nope' }], edges: [{ from: 'a', to: 'zzz' }] },
    cards: [card({ nodes: [{ id: 's', label: 'S', shape: 'oval' }, { id: 'd', label: 'D', shape: 'step', decision: 4, ref: { file: 'x.js', lines: [1] } }], edges: [] })],
  }, files);
  const text = bad.errors.join('\n');
  for (const re of [/type: one of/, /duplicate "a"/, /no card with id "nope"/, /unknown node "zzz"/, /shape: one of/, /no decision 4/, /"x\.js" is not in the diff/, /\[start, end\]/]) assert.match(text, re);
});

test('renders actionable feedback and approved cards', () => {
  const cards = [
    { id: 'retry', title: 'Retry', hunks: [{ file: 'src/a.js', hunk: 0 }], decisions: [{
      question: 'Which errors?', chosen: { label: 'All', description: 'everything', pros: [], cons: [] },
      alternatives: [{ label: 'Idempotent only', description: 'GET/PUT', pros: ['safe'], cons: ['less coverage'] }],
    }] },
    { id: 'docs', title: 'Docs', hunks: [{ file: 'new.txt', hunk: 0 }], decisions: [] },
  ];
  const fb = sanitize({
    cards: { retry: { status: 'changes' }, docs: { status: 'approved' } },
    decisions: { 'retry::0': { preferred: 0, comment: 'no POST retries' } },
    lines: [{ id: '1', cardId: 'retry', file: 'src/a.js', side: 'new', line: 2, code: 'const y = 3;', comment: 'use a constant' }, { id: '2', comment: '   ' }],
  });
  assert.strictEqual(fb.lines.length, 1, 'blank comments are dropped');
  const { markdown, actionable } = render({ label: 'main...HEAD' }, cards, fb);
  assert.strictEqual(actionable, 2);
  assert.match(markdown, /Switch to: \*\*Idempotent only\*\*/);
  assert.match(markdown, /`src\/a\.js:2`/);
  assert.match(markdown, /## Approved — do not change\n\n- Docs `docs`/);
});

test('github review maps lines to the PR diff and summarises the rest', () => {
  const { buildReview } = require('../lib/github');
  const files = parseDiff(PATCH);
  const cards = [{ id: 'retry', title: 'Retry', hunks: [], decisions: [{
    question: 'Which errors?', chosen: { label: 'All', description: 'everything', pros: [], cons: [] },
    alternatives: [{ label: 'Idempotent only', description: 'GET/PUT', pros: ['safe'], cons: [] }] }] },
    { id: 'docs', title: 'Docs', hunks: [], decisions: [] }];
  const fb = sanitize({
    cards: { retry: { status: 'changes' }, docs: { status: 'approved' } },
    decisions: { 'retry::0': { preferred: 0 } },
    lines: [
      { id: '1', cardId: 'retry', file: 'src/a.js', side: 'new', line: 2, comment: 'inline me' },
      { id: '2', cardId: 'retry', file: 'src/a.js', side: 'old', line: 2, comment: 'old side' },
      { id: '3', cardId: 'retry', file: 'src/a.js', side: 'new', line: 99, comment: 'not in diff' },
    ],
  });
  const r = buildReview(cards, fb, files);
  assert.deepStrictEqual(r.inline.map((c) => [c.path, c.line, c.side]), [['src/a.js', 2, 'RIGHT'], ['src/a.js', 2, 'LEFT']]);
  assert.strictEqual(r.unplaced.length, 1);
  assert.match(r.body, /switch from \*All\* to \*\*Idempotent only\*\*/);
  assert.match(r.body, /`src\/a\.js:99`: not in diff/);
  assert.match(r.body, /### Looks good\n- Docs/);
  assert.strictEqual(r.suggestedEvent, 'REQUEST_CHANGES');
  const ok = buildReview([cards[1]], sanitize({ cards: { docs: { status: 'approved' } } }), files);
  assert.strictEqual(ok.suggestedEvent, 'APPROVE');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
