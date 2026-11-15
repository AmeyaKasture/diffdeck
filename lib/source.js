'use strict';

// Collects a diff from git or GitHub and writes the .diffdeck workspace.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseDiff } = require('./diff');
const { agentTask } = require('./agent');

const MAX_BUFFER = 256 * 1024 * 1024;

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryRun(cmd, args, cwd) {
  try { return run(cmd, args, cwd).trim(); } catch { return ''; }
}

function repoRoot(cwd) {
  try {
    return run('git', ['rev-parse', '--show-toplevel'], cwd).trim();
  } catch {
    throw new Error('Not inside a git repository.');
  }
}

function workDir(root) {
  return path.join(root, '.diffdeck');
}

// Keep .diffdeck out of `git status` without touching tracked files.
function excludeWorkDir(root) {
  const gitDir = tryRun('git', ['rev-parse', '--git-common-dir'], root);
  if (!gitDir) return;
  const infoDir = path.resolve(root, gitDir, 'info');
  const excludeFile = path.join(infoDir, 'exclude');
  try {
    fs.mkdirSync(infoDir, { recursive: true });
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    if (!current.split('\n').includes('.diffdeck/')) {
      fs.appendFileSync(excludeFile, (current.endsWith('\n') || current === '' ? '' : '\n') + '.diffdeck/\n');
    }
  } catch { /* non-fatal */ }
}

const GIT_DIFF_ARGS = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-U3', '--find-renames'];

function collect(root, opts) {
  const meta = {
    repo: path.basename(root),
    branch: tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root),
    head: tryRun('git', ['rev-parse', '--short', 'HEAD'], root),
    generatedAt: new Date().toISOString(),
  };
  let patch;

  if (opts.pr) {
    const fields = 'number,title,body,url,baseRefName,headRefName,author';
    let info = {};
    try { info = JSON.parse(run('gh', ['pr', 'view', String(opts.pr), '--json', fields], root)); } catch (e) {
      throw new Error(`Could not read PR ${opts.pr} with gh: ${(e.stderr || e.message).toString().trim()}`);
    }
    patch = run('gh', ['pr', 'diff', String(opts.pr), '--color', 'never'], root);
    Object.assign(meta, {
      source: 'pr',
      label: `PR #${info.number}`,
      title: info.title,
      description: info.body || '',
      url: info.url,
      base: info.baseRefName,
      branch: info.headRefName,
      author: info.author && info.author.login,
    });
  } else if (opts.staged) {
    patch = run('git', [...GIT_DIFF_ARGS, '--cached'], root);
    Object.assign(meta, { source: 'staged', label: 'Staged changes', base: 'HEAD' });
  } else if (opts.base && opts.base.includes('..')) {
    patch = run('git', [...GIT_DIFF_ARGS, opts.base], root);
    Object.assign(meta, { source: 'range', label: opts.base, base: opts.base.split('..')[0] });
  } else if (opts.base) {
    // Everything on this branch since it forked from base, including uncommitted edits.
    const mergeBase = tryRun('git', ['merge-base', opts.base, 'HEAD'], root);
    if (!mergeBase) throw new Error(`Unknown base "${opts.base}". Try a branch name such as main, or origin/main.`);
    patch = run('git', [...GIT_DIFF_ARGS, mergeBase], root);
    const dirty = tryRun('git', ['status', '--porcelain', '--untracked-files=no'], root) !== '';
    const log = tryRun('git', ['log', '--format=%s', `${mergeBase}..HEAD`], root);
    Object.assign(meta, {
      source: 'range',
      label: `${opts.base}...HEAD${dirty ? ' + uncommitted' : ''}`,
      base: opts.base,
      commits: log ? log.split('\n') : [],
    });
  } else {
    patch = run('git', [...GIT_DIFF_ARGS, 'HEAD'], root);
    Object.assign(meta, { source: 'worktree', label: 'Working tree vs HEAD', base: 'HEAD' });
    const untracked = tryRun('git', ['ls-files', '--others', '--exclude-standard'], root);
    if (untracked) meta.untracked = untracked.split('\n').filter((f) => !f.startsWith('.diffdeck/'));
  }

  const files = parseDiff(patch);
  return { meta, files, patch };
}

// The branch a feature branch should be compared with, or null to review
// uncommitted work (on the default branch itself, or when none is found).
function defaultBase(root) {
  const current = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const candidates = [];
  const originHead = tryRun('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root);
  if (originHead) candidates.push(originHead, originHead.replace(/^origin\//, ''));
  candidates.push('main', 'master', 'origin/main', 'origin/master', 'develop');
  for (const c of candidates) {
    if (!tryRun('git', ['rev-parse', '--verify', '--quiet', c], root)) continue;
    const name = c.replace(/^origin\//, '');
    if (current === name || current === 'HEAD') return null;
    return c;
  }
  return null;
}

function prepare(root, opts) {
  const { meta, files, patch } = collect(root, opts);
  const dir = workDir(root);
  const prevPatch = path.join(dir, 'diff.patch');
  const unchanged = fs.existsSync(prevPatch) && fs.readFileSync(prevPatch, 'utf8') === patch;
  fs.mkdirSync(dir, { recursive: true });
  excludeWorkDir(root);

  fs.writeFileSync(path.join(dir, 'diff.patch'), patch);
  fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify({ meta, files }, null, 2));
  fs.writeFileSync(path.join(dir, 'hunks.md'), hunkIndex(files));
  fs.copyFileSync(path.join(__dirname, '..', 'schema', 'breakdown.schema.json'), path.join(dir, 'breakdown.schema.json'));
  fs.writeFileSync(path.join(dir, 'AGENT_TASK.md'), agentTask(meta, files));

  // A breakdown or feedback from a different diff would point at wrong hunks;
  // when the diff is identical they stay valid and are kept.
  if (!unchanged && !opts.keep) {
    for (const stale of ['breakdown.json', 'feedback.json', 'feedback.md']) {
      const p = path.join(dir, stale);
      if (fs.existsSync(p)) fs.renameSync(p, p + '.prev');
    }
  }
  return { dir, meta, files, unchanged };
}

// A compact table of contents the agent can use to reference hunks.
function hunkIndex(files) {
  const out = ['# Hunk index', '', 'Reference hunks in breakdown.json as `{ "file": "<path>", "hunks": [<index>, ...] }`.', ''];
  for (const f of files) {
    out.push(`## ${f.path}  (${f.status}, +${f.additions} -${f.deletions})`);
    if (f.binary) out.push('- binary file, no hunks');
    for (const h of f.hunks) {
      const firstChange = h.lines.find((l) => l.t !== 'ctx');
      const preview = firstChange ? firstChange.s.trim().slice(0, 80) : '';
      out.push(`- hunk ${h.index}: new lines ${h.newStart}-${h.newStart + Math.max(h.newLines - 1, 0)}, +${h.additions} -${h.deletions}${h.context ? `, in \`${h.context.slice(0, 60)}\`` : ''}${preview ? ` — \`${preview.replace(/`/g, "'")}\`` : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}

module.exports = { repoRoot, workDir, prepare, defaultBase };
