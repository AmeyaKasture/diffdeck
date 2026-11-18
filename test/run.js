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

test('hub gives each repository its own address', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-hub-'));
  process.env.DIFFDECK_HOME = path.join(tmp, 'home');
  delete require.cache[require.resolve('../lib/hub')];
  const hub = require('../lib/hub');
  const mk = (rel) => { const r = path.join(tmp, rel); fs.mkdirSync(path.join(r, '.diffdeck'), { recursive: true }); fs.writeFileSync(path.join(r, '.diffdeck', 'diff.json'), '{}'); return r; };
  const a = mk('one/My Repo'); const b = mk('two/My Repo'); const c = mk('api');
  assert.strictEqual(hub.register(a), 'my-repo');
  assert.strictEqual(hub.register(b), 'my-repo-2', 'same folder name, different repo');
  assert.strictEqual(hub.register(a), 'my-repo', 'stable for the same repo');
  assert.strictEqual(hub.register(c, 'demo'), 'demo');
  assert.deepStrictEqual(Object.keys(hub.repos()).sort(), ['demo', 'my-repo', 'my-repo-2']);
  assert.strictEqual(hub.unregister(b), 'my-repo-2');
  fs.rmSync(path.join(c, '.diffdeck'), { recursive: true });
  assert.deepStrictEqual(Object.keys(hub.repos()), ['my-repo'], 'unprepared repos are dropped');
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.DIFFDECK_HOME;
});

function gitRepo() {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-git-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (root, f, text) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); };
  return { fs, path, tmp, git, write, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const lines = (n, tag) => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag && tag[i + 1] ? ` ${tag[i + 1]}` : ''}`).join('\n') + '\n';

test('prefers origin/main when local main is behind, and says so', () => {
  const { tmp, git, write, path, done } = gitRepo();
  const origin = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, work);
  write(work, 'a.txt', 'one\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'one'); git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-qb', 'feature');
  write(work, 'b.txt', 'feature\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'feature');
  // Someone else lands two commits on main; this clone only fetches them.
  const other = path.join(tmp, 'other');
  git(tmp, 'clone', '-q', origin, other);
  write(other, 'c.txt', 'c\n'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'c');
  write(other, 'd.txt', 'd\n'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'd'); git(other, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q');
  git(work, 'rebase', '-q', 'origin/main');

  delete require.cache[require.resolve('../lib/source')];
  const source = require('../lib/source');
  assert.strictEqual(source.defaultBranch(work), 'origin/main');
  const { meta, files } = source.collect(work, { branch: 'feature' });
  assert.deepStrictEqual(files.map((f) => f.path), ['b.txt'], 'only the feature change, not main\'s new commits');
  assert.strictEqual(meta.base, 'origin/main');
  assert.match(meta.notes[0], /local main is 2 commit\(s\) behind origin\/main; using origin\/main/);
  assert.strictEqual(meta.baseSha, git(work, 'rev-parse', 'origin/main'));
  const explicit = source.collect(work, { branch: 'feature', base: 'main' });
  assert.match(explicit.meta.notes[0], /behind origin\/main.*--base origin\/main/);
  const md = require('../lib/feedback').render(meta, [], require('../lib/feedback').sanitize({})).markdown;
  assert.match(md, new RegExp(`- Base: \`origin/main\` @ \`${meta.baseSha.slice(0, 7)}\``));
  assert.match(md, new RegExp(`- Head: \`feature\` @ \`${meta.head}\``));
  done();
});

test('a new round keeps unchanged cards and approvals, and marks changed ones stale', () => {
  const { tmp, git, write, fs, path, done } = gitRepo();
  git(tmp, 'init', '-q', '-b', 'main');
  write(tmp, 'a.txt', lines(40)); write(tmp, 'b.txt', lines(10));
  git(tmp, 'add', '.'); git(tmp, 'commit', '-qm', 'base');
  write(tmp, 'a.txt', lines(40, { 5: 'changed', 30: 'also' })); write(tmp, 'b.txt', lines(10, { 2: 'b' }));

  delete require.cache[require.resolve('../lib/source')];
  const { prepare } = require('../lib/source');
  const { load } = require('../lib/breakdown');
  const r1 = prepare(tmp, {});
  assert.strictEqual(r1.meta.round, 1);
  const dir = r1.dir;
  const card = (id, refs, flow) => ({ id, title: id, summary: 's', kind: 'fix', risk: 'low', refs, flow });
  const flow = { nodes: [{ id: 's', label: 'start', shape: 'start' }, { id: 'x', label: 'x', shape: 'step', ref: { file: 'a.txt', lines: [30, 30] } }], edges: [{ from: 's', to: 'x' }] };
  fs.writeFileSync(path.join(dir, 'breakdown.json'), JSON.stringify({ title: 't', summary: 's', cards: [
    card('top', [{ file: 'a.txt', hunks: [0] }]), card('bottom', [{ file: 'a.txt', hunks: [1] }], flow), card('other', [{ file: 'b.txt' }]),
  ] }));
  fs.writeFileSync(path.join(dir, 'feedback.json'), JSON.stringify({ cards: { top: { status: 'approved' }, bottom: { status: 'approved' }, other: { status: 'changes' } }, lines: [] }));

  // Round 2: a.txt grows by two lines at the top-hunk, b.txt's change is reworked.
  write(tmp, 'a.txt', lines(40, { 5: 'changed', 30: 'also' }).replace('line 1\n', 'line 1\nnew 1\nnew 2\n'));
  write(tmp, 'b.txt', lines(10, { 2: 'reworked' }));
  const r2 = prepare(tmp, {});
  assert.strictEqual(r2.meta.round, 2);
  assert.ok(fs.existsSync(path.join(dir, 'rounds', '1', 'breakdown.json')), 'round 1 archived');
  const { kept, stale, removed, approvals } = r2.rounds;
  assert.deepStrictEqual(kept.map((c) => c.id), ['bottom']);
  assert.deepStrictEqual(stale.map((c) => c.id), ['top', 'other'], 'edited hunks follow their cards, which become stale');
  assert.deepStrictEqual(removed.map((c) => c.id), []);
  assert.deepStrictEqual(approvals, ['bottom']);
  const loaded = load(dir);
  assert.deepStrictEqual(loaded.errors, []);
  const bottom = loaded.cards.find((c) => c.id === 'bottom');
  assert.deepStrictEqual(bottom.flow.nodes[1].ref.lines, [32, 32], 'flow step follows its code down two lines');
  assert.strictEqual(bottom.carried, 1);
  assert.match(loaded.warnings.join('\n'), /top\) is stale/);
  assert.match(fs.readFileSync(path.join(dir, 'refresh.md'), 'utf8'), /`top`.*1 of its 1 hunk\(s\) were edited/);
  assert.strictEqual(loaded.uncovered.length, 0, 'every hunk still has a card');

  // Preparing again with no change keeps everything.
  const r3 = prepare(tmp, {});
  assert.strictEqual(r3.unchanged, true);
  assert.strictEqual(r3.meta.round, 2);
  assert.ok(fs.existsSync(path.join(dir, 'breakdown.json')));

  // Reverting b.txt removes the card that only covered it.
  write(tmp, 'b.txt', lines(10));
  const r4 = prepare(tmp, {});
  assert.deepStrictEqual(r4.rounds.removed.map((c) => c.id), ['other']);
  assert.deepStrictEqual(r4.rounds.stale.map((c) => c.id), ['top'], 'still stale until the agent updates it');
  assert.strictEqual(r4.meta.round, 3);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'feedback.json'), 'utf8')).cards.bottom.status, 'approved');
  done();
});

test('validate warns about flow steps that cannot open code', () => {
  const files = parseDiff(PATCH);
  const r = resolve({ title: 't', summary: 's', cards: [{ id: 'one', title: 'One', summary: '', kind: 'fix', risk: 'low', refs: [{ file: 'src/a.js', hunks: [0] }],
    flow: { nodes: [
      { id: 's', label: 'start', shape: 'start' },
      { id: 'u', label: 'unchanged', shape: 'step', ref: { file: 'src/a.js', lines: [7, 8] } },
      { id: 'o', label: 'other hunk', shape: 'step', ref: { file: 'src/a.js', lines: [11, 11] } },
      { id: 'n', label: 'nothing', shape: 'step' },
      { id: 'e', label: 'end', shape: 'end' },
    ], edges: [] } }] }, files);
  const text = r.warnings.join('\n');
  assert.match(text, /"unchanged": src\/a\.js:7-8 is not in the diff/);
  assert.match(text, /"other hunk": src\/a\.js:11-11 is outside this card's hunks/);
  assert.match(text, /"nothing" has no ref/);
  assert.doesNotMatch(text, /"start"|"end"/);
});

test('questions are listed separately with their replies', () => {
  const fb = sanitize({ lines: [
    { id: 'q1', cardId: 'retry', file: 'src/a.js', side: 'new', line: 2, comment: 'why is this needed?', kind: 'question' },
    { id: 'c1', cardId: 'retry', file: 'src/a.js', side: 'new', line: 3, comment: 'rename it' },
  ] });
  const cards = [{ id: 'retry', title: 'Retry', hunks: [{ file: 'src/a.js', hunk: 0 }], decisions: [] }];
  const { sanitizeReplies } = require('../lib/feedback');
  const replies = sanitizeReplies({ q1: 'Because the API retries.', c1: ['Renamed to maxRetries.'], bad: 5 });
  assert.deepStrictEqual(Object.keys(replies), ['q1', 'c1']);
  const { markdown, actionable, questions } = render({ label: 'x' }, cards, fb, replies);
  assert.strictEqual(actionable, 1);
  assert.strictEqual(questions, 1);
  const [changes, qs] = markdown.split('## Questions');
  assert.match(changes, /rename it/);
  assert.doesNotMatch(changes, /why is this needed/);
  assert.match(qs, /why is this needed\?[\s\S]*comment id `q1`|comment id `q1`[\s\S]*why is this needed/);
  assert.match(qs, /Agent replied: Because the API retries\./);
  assert.match(markdown, /replies\.json/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
