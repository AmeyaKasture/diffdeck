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
    headFull: tryRun('git', ['rev-parse', 'HEAD'], root),
    generatedAt: new Date().toISOString(),
  };
  let patch;

  if (opts.pr) {
    const fields = 'number,title,body,url,baseRefName,headRefName,headRefOid,author';
    let info = {};
    try { info = JSON.parse(run('gh', ['pr', 'view', String(opts.pr), '--json', fields], root)); } catch (e) {
      throw new Error(`Could not read PR ${opts.pr} with gh: ${(e.stderr || e.message).toString().trim()}`);
    }
    patch = run('gh', ['pr', 'diff', String(opts.pr), '--color', 'never'], root);
    const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(info.url || '');
    const local = tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], root);
    if (m && local && m[1].toLowerCase() !== local.toLowerCase()) {
      meta.repoMismatch = `This PR belongs to ${m[1]}, but this folder is ${local}. The agent can only read source files of the repository you are in.`;
    }
    Object.assign(meta, {
      source: 'pr',
      prNumber: info.number,
      prUrl: info.url,
      headSha: info.headRefOid,
      label: `PR #${info.number}`,
      title: info.title,
      description: info.body || '',
      url: info.url,
      base: info.baseRefName,
      branch: info.headRefName,
      author: info.author && info.author.login,
    });
  } else if (opts.branch) {
    // A branch compared with the base it forked from, like a PR would be.
    const base = opts.base || defaultBranch(root);
    if (!base) throw new Error('Could not find a main or master branch to compare against. Pass one with --base <branch>.');
    const tipRef = branchRef(root, opts.branch);
    if (!tipRef) throw new Error(`Branch "${opts.branch}" was not found locally or on origin.`);
    const baseSha = tryRun('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], root);
    if (!baseSha) throw new Error(`Base branch "${base}" was not found.`);
    const tipSha = run('git', ['rev-parse', `${tipRef}^{commit}`], root).trim();
    if (tipSha === baseSha || stripRemote(opts.branch) === stripRemote(base)) {
      throw new Error(`"${opts.branch}" is the base branch, so there is nothing to compare. Name a feature branch, or use --base <branch> to compare against something else.`);
    }
    const mergeBase = tryRun('git', ['merge-base', base, tipSha], root);
    if (!mergeBase) throw new Error(`"${opts.branch}" and "${base}" have no common history.`);
    if (mergeBase === tipSha && !(meta.branch === stripRemote(tipRef) && tryRun('git', ['status', '--porcelain', '--untracked-files=no'], root))) {
      throw new Error(`"${stripRemote(opts.branch)}" is already merged into "${stripRemote(base)}", so it has no changes left to compare. Review its merge commit or its PR instead.`);
    }
    const isCurrent = meta.branch === stripRemote(tipRef) || meta.branch === opts.branch;
    // The checked-out branch includes uncommitted edits, as a local review would.
    patch = run('git', isCurrent ? [...GIT_DIFF_ARGS, mergeBase] : [...GIT_DIFF_ARGS, mergeBase, tipSha], root);
    const dirty = isCurrent && tryRun('git', ['status', '--porcelain', '--untracked-files=no'], root) !== '';
    const log = tryRun('git', ['log', '--format=%s', `${mergeBase}..${tipSha}`], root);
    Object.assign(meta, {
      source: 'branch',
      target: { branch: opts.branch, base: opts.base || null },
      label: `${stripRemote(opts.branch)} vs ${stripRemote(base)}${dirty ? ' + uncommitted' : ''}`,
      title: log ? log.split('\n').length === 1 ? log : `${stripRemote(opts.branch)}: ${log.split('\n').length} commits` : stripRemote(opts.branch),
      branch: stripRemote(opts.branch),
      base: stripRemote(base),
      head: tipSha.slice(0, 7),
      headFull: tipSha,
      readRef: isCurrent ? null : tipSha,
      commits: log ? log.split('\n') : [],
    });
  } else if (opts.commit) {
    // One commit compared with its parent (the first parent for merges).
    const sha = tryRun('git', ['rev-parse', '--verify', '--quiet', `${opts.commit}^{commit}`], root);
    if (!sha) throw new Error(`Commit "${opts.commit}" was not found. Fetch it first (git fetch) or check the id.`);
    const parents = run('git', ['rev-list', '--parents', '-n', '1', sha], root).trim().split(' ').slice(1);
    const parent = parents[0] || EMPTY_TREE;
    patch = run('git', [...GIT_DIFF_ARGS, parent, sha], root);
    const fmt = (f) => tryRun('git', ['show', '-s', `--format=${f}`, sha], root);
    Object.assign(meta, {
      source: 'commit',
      target: { commit: opts.commit },
      label: `Commit ${sha.slice(0, 7)}`,
      title: fmt('%s'),
      description: [fmt('%b'), parents.length > 1 ? `Merge commit: compared with its first parent ${parents[0].slice(0, 7)}.` : '', !parents.length ? 'Root commit: compared with an empty tree.' : ''].filter(Boolean).join('\n\n'),
      author: fmt('%an'),
      date: fmt('%aI'),
      branch: meta.branch,
      base: parents[0] ? parents[0].slice(0, 7) : 'empty tree',
      head: sha.slice(0, 7),
      headFull: sha,
      commitSha: sha,
      readRef: sha === meta.headFull ? null : sha,
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

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const stripRemote = (ref) => String(ref).replace(/^(refs\/heads\/|refs\/remotes\/)?origin\//, '').replace(/^refs\/heads\//, '');

// The repository's default branch (origin/HEAD, main or master), or null.
function defaultBranch(root) {
  const originHead = tryRun('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root);
  const candidates = [originHead && originHead.replace(/^origin\//, ''), originHead, 'main', 'master', 'origin/main', 'origin/master'].filter(Boolean);
  for (const c of candidates) if (tryRun('git', ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], root)) return c;
  return null;
}

// A ref for a branch name: local, then origin/<name>, fetching it once if needed.
function branchRef(root, name) {
  const plain = stripRemote(name);
  const tries = name.startsWith('origin/') ? [name] : [`refs/heads/${plain}`, `refs/remotes/origin/${plain}`];
  for (const t of tries) if (tryRun('git', ['rev-parse', '--verify', '--quiet', t], root)) return t;
  const validName = tryRun('git', ['check-ref-format', '--branch', plain], root) !== '' && !/^[0-9a-f]{7,40}$/i.test(plain);
  if (validName && tryRun('git', ['remote'], root).split('\n').includes('origin')) {
    tryRun('git', ['fetch', '--quiet', 'origin', `refs/heads/${plain}:refs/remotes/origin/${plain}`], root);
    if (tryRun('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${plain}`], root)) return `refs/remotes/origin/${plain}`;
  }
  return null;
}

const PR_LINK = /^(https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+)(?:\/[\w-]+)*\/?(?:[#?].*)?$/;

// Works out whether `raw` is a pull request, a branch or a commit.
function resolveTarget(root, raw) {
  const value = String(raw).trim();
  const pr = PR_LINK.exec(value);
  if (pr) return { pr: pr[1] };
  if (/^https?:\/\//.test(value)) throw new Error(`"${value}" is not a pull request link. It should look like https://github.com/org/repo/pull/42`);
  if (/^#?\d{1,6}$/.test(value) && !branchRef(root, value)) return { pr: value.replace('#', '') };
  // A branch name wins over a commit id that happens to look the same.
  if (!/^[0-9a-f]{7,40}$/i.test(value) || tryRun('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${value}`], root)) {
    if (branchRef(root, value)) return { branch: value };
  }
  if (tryRun('git', ['rev-parse', '--verify', '--quiet', `${value}^{commit}`], root)) return { commit: value };
  throw new Error(`Could not find a pull request, branch or commit called "${value}". Give a PR link (https://github.com/org/repo/pull/42), a branch name, or a commit id.`);
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

module.exports = { repoRoot, workDir, prepare, defaultBase, defaultBranch, resolveTarget };
