#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { repoRoot, workDir, prepare, defaultBase } = require('../lib/source');
const { load } = require('../lib/breakdown');
const { serve } = require('../lib/server');
const { installCommands, AGENTS_MD_SNIPPET, AGENT_TARGETS } = require('../lib/agent');
const { version } = require('../package.json');

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, blue: (s) => `\x1b[34m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` }
  : { b: (s) => s, dim: (s) => s, blue: (s) => s, green: (s) => s, yellow: (s) => s };

const HELP = `${c.b('diffdeck')} ${c.dim(`v${version}`)} — review a diff or PR as an interactive flow diagram

${c.b('Usage')}
  diffdeck                      Review this branch (auto-detects main/master) and open the browser
  diffdeck review <base>        Review against a branch, e.g. ${c.blue('diffdeck review develop')}
  diffdeck review <PR link>     Review a GitHub pull request, e.g. https://github.com/org/repo/pull/42
  diffdeck review --pr <n|link> Same, by number or link (needs the gh CLI)
  diffdeck review --staged      Review staged changes
  diffdeck review --worktree    Review uncommitted changes against HEAD
  diffdeck demo                 Open a sample review, no setup needed

  diffdeck init [agent]         Add /diffdeck-breakdown and /diffdeck-apply commands to this repo
                                agent: ${AGENT_TARGETS.join(' | ')} | all (default)
  diffdeck prepare [same args]  Only collect the diff (what agents run)
  diffdeck serve [--background] Open the UI for the prepared diff (--background: keep it running and return)
  diffdeck stop                 Stop a background server
  diffdeck post [--event comment|request-changes|approve] [--yes]
                                Preview your review for the PR; with --yes, post it to GitHub
  diffdeck login                Log in to GitHub (via the gh CLI)
  diffdeck upgrade [--force]    Update diffdeck to the latest version from GitHub
  diffdeck validate             Check .diffdeck/breakdown.json
  diffdeck feedback             Print .diffdeck/feedback.md

${c.b('Options')}
  --port <n>     Port for the UI (default 4777)
  --no-open      Do not open the browser
  -v, --version  Print the version

${c.b('Workflow')}
  1. In your agent:  /diffdeck-breakdown <PR link>   ${c.dim('(the agent asks for the link if you leave it out)')}
  2. In a terminal:  diffdeck                 ${c.dim('(explore the diagram, comment, pick alternatives)')}
  3. In your agent:  /diffdeck-apply          ${c.dim('(or: "implement .diffdeck/feedback.md")')}
     or on GitHub:   Finish review → Post on GitHub  ${c.dim('(or: diffdeck post)')}
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr' || a === '--port' || a === '--event') args[a.slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, argv, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* ignore */ }
}

const PR_URL = /^(https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+)(?:\/[\w-]+)*\/?(?:[#?].*)?$/;
const prLink = (v) => { const m = PR_URL.exec(v); return m ? m[1] : v; }; // strip /files, /commits, #fragment

function sourceOpts(root, args) {
  const first = args._[0];
  if (first && PR_URL.test(first)) return { pr: prLink(first) };
  if (first && /^https?:\/\//.test(first)) throw new Error(`"${first}" is not a pull request link. It should look like https://github.com/org/repo/pull/42`);
  if (args.pr !== undefined) {
    if (args.pr === true || !(/^\d+$/.test(args.pr) || PR_URL.test(args.pr))) throw new Error('--pr expects a PR number or link, e.g. --pr 42 or --pr https://github.com/org/repo/pull/42');
    return { pr: prLink(args.pr) };
  }
  if (args.staged) return { staged: true };
  if (args.worktree) return {};
  if (first) return { base: first };
  // With no arguments, keep reviewing the PR an agent already prepared.
  try {
    const { meta } = JSON.parse(fs.readFileSync(path.join(workDir(root), 'diff.json'), 'utf8'));
    if (meta.source === 'pr' && (meta.prUrl || meta.prNumber)) return { pr: String(meta.prUrl || meta.prNumber) };
  } catch { /* nothing prepared yet */ }
  const base = defaultBase(root);
  return base ? { base } : {};
}

function doPrepare(root, args) {
  const r = prepare(root, sourceOpts(root, args));
  const hunks = r.files.reduce((n, f) => n + f.hunks.length, 0);
  console.log(`${c.green('✓')} ${c.b(r.meta.label)}: ${r.files.length} files, ${hunks} hunks${r.unchanged ? c.dim(' (unchanged; breakdown and feedback kept)') : ''}`);
  if (!r.files.length) console.log(c.yellow('  The diff is empty. Try `diffdeck review <base>` or `--pr <n>`.'));
  if (r.meta.repoMismatch) console.log(c.yellow(`  ${r.meta.repoMismatch}`));
  if (r.meta.untracked && r.meta.untracked.length) console.log(c.yellow(`  ${r.meta.untracked.length} untracked file(s) are not included; \`git add -N <file>\` to include them.`));
  return r;
}

// A server started by `diffdeck serve` records itself in .diffdeck/server.json
// so later commands (and agents) reuse it instead of starting another one.
function serverFile(dir) { return path.join(dir, 'server.json'); }

async function runningServer(dir) {
  let info;
  try { info = JSON.parse(fs.readFileSync(serverFile(dir), 'utf8')); } catch { return null; }
  try { process.kill(info.pid, 0); } catch { return null; }
  try {
    const res = await fetch(`${info.url}api/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? info : null;
  } catch { return null; }
}

function printRunning(dir, url, background) {
  const hasBreakdown = fs.existsSync(path.join(dir, 'breakdown.json'));
  console.log(`${c.green('✓')} The review is open at ${c.b(c.blue(url))}`);
  if (!hasBreakdown) console.log(`  ${c.yellow('No breakdown yet.')} In your agent run ${c.b('/diffdeck-breakdown <PR link>')}; the page updates by itself.`);
  console.log(`  Feedback is saved to ${c.dim(path.join(dir, 'feedback.md'))}`);
  console.log(c.dim(background ? '  The server runs in the background. Stop it with: diffdeck stop' : '  Press Ctrl+C to stop.'));
}

async function doServe(dir, args) {
  load(dir); // fail early with a helpful message if nothing is prepared
  const existing = await runningServer(dir);
  if (existing) {
    console.log(c.dim('  (already running; the open page refreshes by itself)'));
    printRunning(dir, existing.url, true);
    if (!args['no-open']) openBrowser(existing.url);
    return;
  }

  if (args.background) {
    const child = spawn(process.execPath, [__filename, 'serve', '--no-open', ...(args.port ? ['--port', String(args.port)] : [])], {
      cwd: path.dirname(dir), detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const info = await runningServer(dir);
      if (info && info.pid === child.pid) {
        printRunning(dir, info.url, true);
        if (!args['no-open']) openBrowser(info.url);
        return;
      }
    }
    throw new Error('The background server did not start. Run `diffdeck serve` to see the error.');
  }

  let port = Number(args.port || process.env.DIFFDECK_PORT || 4777);
  let server;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { server = await serve(dir, port); break; } catch (e) {
      if (e.code !== 'EADDRINUSE' || args.port) throw e;
      port++;
    }
  }
  const url = `http://127.0.0.1:${port}/`;
  fs.writeFileSync(serverFile(dir), JSON.stringify({ pid: process.pid, port, url, startedAt: new Date().toISOString() }, null, 2));
  const cleanup = () => {
    try { if (JSON.parse(fs.readFileSync(serverFile(dir), 'utf8')).pid === process.pid) fs.unlinkSync(serverFile(dir)); } catch { /* already gone */ }
  };
  printRunning(dir, url, false);
  if (!args['no-open']) openBrowser(url);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); server.close(); process.exit(0); });
  process.on('exit', cleanup);
}

async function doStop(dir) {
  const info = await runningServer(dir);
  if (!info) { try { fs.unlinkSync(serverFile(dir)); } catch { /* none */ } console.log('No diffdeck server is running for this repository.'); return; }
  process.kill(info.pid, 'SIGTERM');
  console.log(`${c.green('✓')} Stopped the diffdeck server at ${info.url}`);
}

/* ---------------- upgrade ---------------- */

const REPO = 'AmeyaKasture/diffdeck';
const PKG_ROOT = path.join(__dirname, '..');

function newer(a, b) { // true when version a is newer than b
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function runInherit(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
}

async function doUpgrade(args) {
  const via = PKG_ROOT.includes(`${path.sep}_npx${path.sep}`) ? 'npx' : fs.existsSync(path.join(PKG_ROOT, '.git')) ? 'clone' : 'npm';
  if (via === 'npx') {
    console.log(`You are running diffdeck through npx, which keeps a cached copy. Install it once with\n  ${c.b(`npm install -g github:${REPO}`)}\nand from then on use ${c.b('diffdeck upgrade')}.`);
    return;
  }

  let latest;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = (await res.json()).version;
  } catch (e) {
    throw new Error(`Could not check GitHub for a new version (${e.message}). To upgrade manually: npm install -g github:${REPO}`);
  }
  if (!args.force && !newer(latest, version)) {
    console.log(`${c.green('✓')} diffdeck ${version} is the latest version.${latest !== version ? c.dim(` (GitHub has ${latest})`) : ''}`);
    return;
  }
  console.log(`Upgrading diffdeck ${version} → ${latest}…`);

  let code;
  if (via === 'clone') {
    console.log(c.dim(`  installed from a clone at ${PKG_ROOT}; running git pull`));
    code = await runInherit('git', ['-C', PKG_ROOT, 'pull', '--ff-only']);
    if (code !== 0) throw new Error(`git pull failed in ${PKG_ROOT}. Commit or stash local changes there, then run diffdeck upgrade again.`);
  } else {
    code = await runInherit('npm', ['install', '-g', `github:${REPO}`]);
    if (code !== 0) throw new Error(`npm could not install the new version. If it reported a permission error (EACCES), run: sudo npm install -g github:${REPO}`);
  }
  const installed = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
  console.log(`${c.green('✓')} diffdeck is now ${installed}.`);

  // Refresh this repository's agent commands and restart its server so both use the new version.
  let root;
  try { root = repoRoot(process.cwd()); } catch { return; }
  const bin = path.join(PKG_ROOT, 'bin', 'diffdeck.js');
  const targets = [['claude', '.claude/commands'], ['cursor', '.cursor/commands'], ['opencode', '.opencode/command']]
    .filter(([, d]) => fs.existsSync(path.join(root, d, 'diffdeck-breakdown.md'))).map(([t]) => t);
  if (targets.length) {
    await runInherit(process.execPath, [bin, 'init', targets.join(','), '--quiet'], { cwd: root });
  }
  if (await runningServer(workDir(root))) {
    await runInherit(process.execPath, [bin, 'stop'], { cwd: root });
    await runInherit(process.execPath, [bin, 'serve', '--background', '--no-open'], { cwd: root });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  const known = ['review', 'demo', 'init', 'agent-setup', 'prepare', 'serve', 'stop', 'validate', 'feedback', 'post', 'login', 'upgrade', 'help'];
  const cmd = !first || first.startsWith('-') ? 'review' : first;
  const args = parseArgs(cmd === first ? argv.slice(1) : argv);

  if (args.help || args.h || cmd === 'help') { process.stdout.write(HELP); return; }
  if (args.version || argv.includes('-v')) { console.log(version); return; }
  if (args.y) args.yes = true;
  if (!known.includes(cmd)) { process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`); process.exitCode = 2; return; }

  if (cmd === 'upgrade') { await doUpgrade(args); return; }

  if (cmd === 'demo') {
    const { createDemo } = require('../lib/demo');
    const root = createDemo();
    console.log(`${c.green('✓')} Demo repository created at ${c.dim(root)}`);
    await doServe(workDir(root), args);
    return;
  }

  const root = repoRoot(process.cwd());
  const dir = workDir(root);

  switch (cmd) {
    case 'review':
      doPrepare(root, args);
      await doServe(dir, args);
      return;
    case 'prepare':
      doPrepare(root, args);
      console.log(`  Next: have your agent follow ${c.b('.diffdeck/AGENT_TASK.md')}, then run ${c.b('diffdeck serve')}.`);
      return;
    case 'serve':
      await doServe(dir, args);
      return;
    case 'stop':
      await doStop(dir);
      return;
    case 'validate': {
      const r = load(dir);
      if (!r.breakdown && !r.errors.length) { console.log('No .diffdeck/breakdown.json yet.'); process.exitCode = 1; return; }
      for (const e of r.errors) console.log(`error: ${e}`);
      for (const w of r.warnings) console.log(`warning: ${w}`);
      if (r.errors.length) { process.exitCode = 1; return; }
      const decisions = r.cards.reduce((n, card) => n + card.decisions.length, 0);
      const flows = r.cards.filter((card) => card.flow).length;
      console.log(`OK: ${r.cards.length} cards, ${decisions} design decisions, ${flows} logic flows${r.breakdown.flow ? ', system flow' : ', no system flow'}.`);
      return;
    }
    case 'feedback': {
      const f = path.join(dir, 'feedback.md');
      if (!fs.existsSync(f)) { console.log('No feedback yet. Run `diffdeck` and review.'); process.exitCode = 1; return; }
      process.stdout.write(fs.readFileSync(f, 'utf8'));
      return;
    }
    case 'login': {
      const github = require('../lib/github');
      const st = await github.authStatus(root);
      if (!st.installed) { console.log(`The GitHub CLI is required. Install it (${c.b('brew install gh')} / ${c.b('winget install --id GitHub.cli')} / https://github.com/cli/cli#installation), then run ${c.b('diffdeck login')} again.`); process.exitCode = 1; return; }
      if (st.loggedIn) { console.log(`${c.green('✓')} Already logged in to GitHub as ${c.b('@' + st.user)}.`); return; }
      await new Promise((resolve) => spawn('gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'], { stdio: 'inherit' }).on('exit', resolve).on('error', resolve));
      return;
    }
    case 'post': {
      const github = require('../lib/github');
      const { deckCards } = require('../lib/breakdown');
      const { sanitize } = require('../lib/feedback');
      const loaded = load(dir);
      let fb;
      try { fb = sanitize(JSON.parse(fs.readFileSync(path.join(dir, 'feedback.json'), 'utf8'))); } catch { console.log('No feedback yet. Run `diffdeck` and review first.'); process.exitCode = 1; return; }
      const cards = deckCards(loaded);
      const pv = await github.preview(root, loaded.meta, cards, fb);
      const st = pv.status;
      if (!st.auth.installed) { console.log(`The GitHub CLI is required: ${c.b('brew install gh')} (or see https://github.com/cli/cli#installation).`); process.exitCode = 1; return; }
      if (!st.auth.loggedIn) { console.log(`Not logged in to GitHub. Run ${c.b('diffdeck login')} first.`); process.exitCode = 1; return; }
      if (!st.pr) { console.log(st.prError.message + (st.prError.error === 'no-pr' ? `\nPush and open one with ${c.b('gh pr create --fill')}, or use ${c.b('diffdeck review --pr <n>')}.` : '')); process.exitCode = 1; return; }
      if (pv.error) { console.log(pv.error); process.exitCode = 1; return; }
      const map = { comment: 'COMMENT', 'request-changes': 'REQUEST_CHANGES', approve: 'APPROVE' };
      const event = args.event ? map[args.event] : pv.review.suggestedEvent;
      if (!event) { console.log('--event must be comment, request-changes or approve.'); process.exitCode = 2; return; }
      console.log(`${c.b(`PR #${st.pr.number}`)} ${st.pr.title}\n${c.dim(st.pr.url)}\nAs @${st.auth.user} · ${event.toLowerCase().replace('_', ' ')} · ${pv.review.inline.length} inline comment(s)${pv.review.unplaced.length ? `, ${pv.review.unplaced.length} moved to the summary (lines not in the PR diff)` : ''}`);
      for (const w of st.warnings || []) console.log(c.yellow(`! ${w}`));
      console.log(`\n${pv.review.body || c.dim('(no summary)')}\n`);
      if (!args.yes) { console.log(c.dim('Preview only. Run again with --yes to post this review publicly.')); return; }
      const r = await github.post(root, loaded.meta, cards, fb, { event, force: !!args.force });
      if (!r.ok) { console.log(`${r.error}${r.duplicate ? ` (${r.duplicate.url}; add --force to post again)` : ''}`); process.exitCode = 1; return; }
      console.log(`${c.green('✓')} Posted: ${r.url}`);
      return;
    }
    case 'init':
    case 'agent-setup': {
      const which = args._[0] || 'all';
      const written = installCommands(root, which === 'all' ? AGENT_TARGETS : which.split(','));
      console.log(`${c.green('✓')} ${args.quiet ? 'Refreshed' : 'Added'} agent commands:`);
      for (const w of written) console.log(`  ${w}`);
      if (args.quiet) return;
      console.log(`\nFor other agents (Codex, Aider, ...), add this to ${c.b('AGENTS.md')}:\n`);
      console.log(AGENTS_MD_SNIPPET);
      return;
    }
  }
}

main().catch((e) => {
  console.error(`diffdeck: ${e.message}`);
  process.exitCode = 1;
});
