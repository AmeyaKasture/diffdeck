'use strict';

// Posting a diffdeck review to a GitHub pull request through the gh CLI.
// Guardrails: gh must be installed and logged in, the PR must be resolvable
// and open, every inline comment is re-checked against the PR's *current*
// diff (comments that no longer map go into the review body instead),
// self-reviews may only COMMENT, and identical reviews are not posted twice
// without an explicit force.

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseDiff } = require('./diff');

const MAX_BUFFER = 256 * 1024 * 1024;

function gh(args, cwd, input) {
  return new Promise((resolve) => {
    const child = execFile('gh', args, { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

/* ---------------- status ---------------- */

async function authStatus(cwd, host = 'github.com') {
  const version = await gh(['--version'], cwd);
  if (!version.ok && version.code === 'ENOENT') return { installed: false, loggedIn: false };
  const st = await gh(['auth', 'status', '--hostname', host], cwd);
  const text = st.stdout + st.stderr;
  const user = (/account ([^\s(]+)/.exec(text) || /as ([^\s(]+)/.exec(text) || [])[1] || null;
  const scopes = (/Token scopes: (.*)/.exec(text) || [])[1] || '';
  return { installed: true, loggedIn: st.ok && !!user, user, host, scopes: scopes.replace(/'/g, '').split(/,\s*/).filter(Boolean) };
}

// The PR this review belongs to: the one it was prepared from, or the open PR
// for the current branch.
async function resolvePr(root, meta) {
  const fields = 'number,title,url,state,isDraft,headRefOid,headRefName,baseRefName,author';
  let ref = meta.source === 'pr' ? meta.prUrl || meta.prNumber : meta.source === 'branch' ? meta.branch : null;
  if (meta.source === 'commit') {
    // The open pull request that contains this commit, if any.
    const found = await gh(['pr', 'list', '--state', 'open', '--search', meta.commitSha, '--json', 'number', '--limit', '1'], root);
    const list = found.ok ? JSON.parse(found.stdout || '[]') : [];
    if (!list.length) return { error: 'no-pr', message: `No open pull request contains commit ${meta.head}, so there is nowhere to post comments.` };
    ref = list[0].number;
  }
  const args = ref ? ['pr', 'view', String(ref), '--json', fields] : ['pr', 'view', '--json', fields];
  const r = await gh(args, root);
  if (!r.ok) {
    const msg = (r.stderr || r.stdout).trim();
    if (/no pull requests found|no open pull requests/i.test(msg)) return { error: 'no-pr', message: `No pull request found for branch "${meta.branch}".` };
    if (/no git remotes|none of the git remotes/i.test(msg)) return { error: 'no-remote', message: 'This repository has no GitHub remote, so there is no pull request to comment on.' };
    return { error: 'pr-lookup', message: msg || 'Could not look up the pull request.' };
  }
  const pr = JSON.parse(r.stdout);
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(pr.url);
  if (!m) return { error: 'pr-lookup', message: `Unexpected PR URL ${pr.url}` };
  return { pr: { ...pr, host: m[1], owner: m[2], repo: m[3], author: pr.author && pr.author.login } };
}

async function status(root, meta) {
  const auth = await authStatus(root);
  if (!auth.installed || !auth.loggedIn) return { auth };
  const res = await resolvePr(root, meta);
  if (res.error) return { auth, prError: res };
  const { pr } = res;
  const out = { auth, pr };
  if (pr.host !== auth.host) {
    const hostAuth = await authStatus(root, pr.host);
    out.auth = hostAuth;
    if (!hostAuth.loggedIn) return out;
  }
  const warnings = [];
  if (pr.state !== 'OPEN') warnings.push(`PR #${pr.number} is ${pr.state.toLowerCase()}.`);
  const reviewedSha = meta.source === 'pr' ? meta.headSha : meta.headFull;
  if (meta.source === 'commit') warnings.push(`You reviewed commit ${meta.head} on its own. Comments go on PR #${pr.number}; notes on lines the PR no longer has move into the summary.`);
  if (reviewedSha && pr.headRefOid && !pr.headRefOid.startsWith(reviewedSha) && !reviewedSha.startsWith(pr.headRefOid)) {
    warnings.push(meta.source === 'pr'
      ? `PR #${pr.number} has new commits since you prepared this review. Line comments are re-checked against the current PR diff.`
      : `Your local HEAD differs from the PR head (unpushed commits?). Line comments are re-checked against the PR diff.`);
  }
  if (/uncommitted/.test(meta.label || '')) warnings.push('This review includes uncommitted changes, which are not in the PR; comments on them go into the review summary.');
  out.warnings = warnings;
  out.selfReview = !!(auth.user && pr.author && auth.user.toLowerCase() === pr.author.toLowerCase());
  return out;
}

/* ---------------- login (device flow) ---------------- */

let loginProc = null;
let loginInfo = null;

function startLogin(host = 'github.com') {
  if (loginProc && loginInfo) return Promise.resolve(loginInfo);
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    loginProc = spawn('gh', ['auth', 'login', '--web', '--hostname', host, '--git-protocol', 'https', '--scopes', 'repo'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
    });
    const onData = (d) => {
      out += d;
      const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out);
      const url = /(https:\/\/\S+\/login\/device)/.exec(out);
      if (code && url) { loginInfo = { code: code[1], url: url[1] }; finish(loginInfo); }
    };
    loginProc.stdout.on('data', onData);
    loginProc.stderr.on('data', onData);
    loginProc.on('error', (e) => finish({ error: e.code === 'ENOENT' ? 'gh is not installed' : e.message }));
    loginProc.on('exit', (code) => {
      loginProc = null;
      loginInfo = null;
      finish(code === 0 ? { done: true } : { error: out.trim().split('\n').pop() || `gh exited with ${code}` });
    });
    setTimeout(() => finish({ error: 'gh did not print a login code. Run `gh auth login` in a terminal instead.' }), 15000);
  });
}

function cancelLogin() {
  if (loginProc) loginProc.kill();
  loginProc = null;
  loginInfo = null;
}

/* ---------------- building the review ---------------- */

function lineIndex(files) {
  const idx = new Set();
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.t !== 'del') idx.add(`${f.path}|new|${l.n}`);
        if (l.t !== 'add') idx.add(`${f.path}|old|${l.o}`);
      }
    }
  }
  return idx;
}

function buildReview(cards, fb, prFiles) {
  const idx = lineIndex(prFiles);
  const inline = [];
  const unplaced = [];
  for (const l of fb.lines) {
    if (idx.has(`${l.file}|${l.side}|${l.line}`)) {
      inline.push({ path: l.file, line: l.line, side: l.side === 'old' ? 'LEFT' : 'RIGHT', body: l.comment.trim() });
    } else {
      unplaced.push(l);
    }
  }

  const parts = [];
  if (fb.general.trim()) parts.push(fb.general.trim());
  const changeSections = [];
  const approved = [];
  for (const card of cards) {
    const c = fb.cards[card.id] || {};
    const items = [];
    (card.decisions || []).forEach((d, i) => {
      const df = fb.decisions[`${card.id}::${i}`];
      if (!df) return;
      const alt = df.preferred >= 0 ? d.alternatives[df.preferred] : null;
      if (alt) {
        items.push(`- **${d.question}** Please switch from *${d.chosen.label}* to **${alt.label}**: ${alt.description}${alt.pros.length ? `\n  - Why: ${alt.pros.join('; ')}` : ''}${df.comment.trim() ? `\n  - Note: ${df.comment.trim().replace(/\n/g, ' ')}` : ''}`);
      } else if (df.comment.trim()) {
        items.push(`- **${d.question}** ${df.comment.trim().replace(/\n/g, ' ')}`);
      }
    });
    if (c.comment && c.comment.trim()) items.push(`- ${c.comment.trim().replace(/\n/g, '\n  ')}`);
    for (const l of unplaced.filter((x) => x.cardId === card.id)) items.push(`- \`${l.file}:${l.line}\`: ${l.comment.trim().replace(/\n/g, ' ')}`);
    if (items.length || c.status === 'changes') changeSections.push(`#### ${card.title}\n${items.length ? items.join('\n') : '- Needs changes.'}`);
    else if (c.status === 'approved') approved.push(card.title);
  }
  const known = new Set(cards.map((c) => c.id));
  const orphanLines = unplaced.filter((l) => !known.has(l.cardId));
  if (orphanLines.length) changeSections.push(`#### Other notes\n${orphanLines.map((l) => `- \`${l.file}:${l.line}\`: ${l.comment.trim().replace(/\n/g, ' ')}`).join('\n')}`);
  if (changeSections.length) parts.push(`### Requested changes\n\n${changeSections.join('\n\n')}`);
  if (approved.length) parts.push(`### Looks good\n${approved.map((t) => `- ${t}`).join('\n')}`);

  const anyChanges = changeSections.length > 0;
  const allApproved = cards.length > 0 && cards.every((card) => (fb.cards[card.id] || {}).status === 'approved');
  const suggestedEvent = anyChanges ? 'REQUEST_CHANGES' : allApproved ? 'APPROVE' : 'COMMENT';
  return { body: parts.join('\n\n'), inline, unplaced: unplaced.map((l) => ({ file: l.file, line: l.line, comment: l.comment })), suggestedEvent };
}

async function preview(root, meta, cards, fb) {
  const st = await status(root, meta);
  if (!st.pr) return { status: st };
  const d = await gh(['pr', 'diff', String(st.pr.number), '--color', 'never'], root);
  if (!d.ok) return { status: st, error: (d.stderr || 'Could not read the PR diff.').trim() };
  const review = buildReview(cards, fb, parseDiff(d.stdout));
  const allowed = st.selfReview ? ['COMMENT'] : ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];
  if (!allowed.includes(review.suggestedEvent)) review.suggestedEvent = 'COMMENT';
  return { status: st, review, allowedEvents: allowed, alreadyPosted: alreadyPosted(root, st.pr, review) };
}

/* ---------------- posting ---------------- */

function ledgerPath(root) { return path.join(root, '.diffdeck', 'github-posted.json'); }

function digest(pr, review, event) {
  return crypto.createHash('sha256').update(JSON.stringify([pr.url, event || '', review.body, review.inline])).digest('hex').slice(0, 16);
}

function readLedger(root) {
  try { return JSON.parse(fs.readFileSync(ledgerPath(root), 'utf8')); } catch { return []; }
}

function alreadyPosted(root, pr, review) {
  const content = digest(pr, review, '');
  return readLedger(root).find((e) => e.content === content) || null;
}

async function post(root, meta, cards, fb, { event, force }) {
  const p = await preview(root, meta, cards, fb);
  if (!p.status.auth.installed) return { error: 'gh is not installed.' };
  if (!p.status.auth.loggedIn) return { error: 'You are not logged in to GitHub.' };
  if (!p.status.pr) return { error: p.status.prError ? p.status.prError.message : 'No pull request found.' };
  if (p.error) return { error: p.error };
  const { pr } = p.status;
  if (pr.state !== 'OPEN') return { error: `PR #${pr.number} is ${pr.state.toLowerCase()}; reviews can only be posted on open PRs.` };
  if (!p.allowedEvents.includes(event)) return { error: p.status.selfReview ? 'GitHub does not let you approve or request changes on your own PR. Post as a comment instead.' : `Unknown review type "${event}".` };
  const { review } = p;
  if (!review.body.trim() && !review.inline.length) return { error: 'There is nothing to post yet: add comments, pick alternatives, or approve cards first.' };
  if (event === 'REQUEST_CHANGES' && !review.body.trim()) review.body = 'Please see the inline comments.';
  if (p.alreadyPosted && !force) return { error: 'This exact review was already posted.', duplicate: p.alreadyPosted };

  const payload = { commit_id: pr.headRefOid, event, body: review.body, comments: review.inline };
  const args = ['api', '--method', 'POST', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, '--input', '-'];
  if (pr.host !== 'github.com') args.splice(1, 0, '--hostname', pr.host);
  const r = await gh(args, root, JSON.stringify(payload));
  if (!r.ok) {
    let msg = (r.stdout || r.stderr).trim();
    try { const j = JSON.parse(r.stdout); msg = [j.message, ...(j.errors || []).map((e) => (typeof e === 'string' ? e : e.message))].filter(Boolean).join(': '); } catch { /* raw text */ }
    if (/scope|403|Resource not accessible/i.test(msg)) msg += ' — your gh token may lack access to this repository. Run `gh auth refresh -s repo`.';
    return { error: `GitHub rejected the review: ${msg}` };
  }
  const res = JSON.parse(r.stdout);
  const entry = { content: digest(pr, review, ''), url: res.html_url, event, postedAt: new Date().toISOString(), pr: pr.number, inline: review.inline.length };
  fs.writeFileSync(ledgerPath(root), JSON.stringify([...readLedger(root), entry], null, 2));
  return { ok: true, url: res.html_url, inline: review.inline.length, unplaced: review.unplaced.length, event };
}

module.exports = { authStatus, status, startLogin, cancelLogin, buildReview, preview, post };
