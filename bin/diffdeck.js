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
  diffdeck review --pr <n>      Review a GitHub pull request (needs the gh CLI)
  diffdeck review --staged      Review staged changes
  diffdeck review --worktree    Review uncommitted changes against HEAD
  diffdeck demo                 Open a sample review, no setup needed

  diffdeck init [agent]         Add /diffdeck-breakdown and /diffdeck-apply commands to this repo
                                agent: ${AGENT_TARGETS.join(' | ')} | all (default)
  diffdeck prepare [same args]  Only collect the diff (what agents run)
  diffdeck serve                Only open the UI for the prepared diff
  diffdeck post [--event comment|request-changes|approve] [--yes]
                                Preview your review for the PR; with --yes, post it to GitHub
  diffdeck login                Log in to GitHub (via the gh CLI)
  diffdeck validate             Check .diffdeck/breakdown.json
  diffdeck feedback             Print .diffdeck/feedback.md

${c.b('Options')}
  --port <n>     Port for the UI (default 4777)
  --no-open      Do not open the browser
  -v, --version  Print the version

${c.b('Workflow')}
  1. In your agent:  /diffdeck-breakdown      ${c.dim('(or: "follow .diffdeck/AGENT_TASK.md")')}
  2. In a terminal:  diffdeck                 ${c.dim('(explore the diagram, comment, pick alternatives)')}
  3. In your agent:  /diffdeck-apply          ${c.dim('(or: "implement .diffdeck/feedback.md")')}
     or on GitHub:   Finish review → Post on GitHub  ${c.dim('(or: diffdeck post)')}
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr' || a === '--port' || a === '--event') args[a.slice(2)] = argv[++i];
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

function sourceOpts(root, args) {
  if (args.pr && !/^\d+$/.test(args.pr)) throw new Error('--pr expects a number, e.g. --pr 42');
  if (args.pr) return { pr: args.pr };
  if (args.staged) return { staged: true };
  if (args.worktree) return {};
  if (args._[0]) return { base: args._[0] };
  const base = defaultBase(root);
  return base ? { base } : {};
}

function doPrepare(root, args) {
  const r = prepare(root, sourceOpts(root, args));
  const hunks = r.files.reduce((n, f) => n + f.hunks.length, 0);
  console.log(`${c.green('✓')} ${c.b(r.meta.label)}: ${r.files.length} files, ${hunks} hunks${r.unchanged ? c.dim(' (unchanged; breakdown and feedback kept)') : ''}`);
  if (!r.files.length) console.log(c.yellow('  The diff is empty. Try `diffdeck review <base>` or `--pr <n>`.'));
  if (r.meta.untracked && r.meta.untracked.length) console.log(c.yellow(`  ${r.meta.untracked.length} untracked file(s) are not included; \`git add -N <file>\` to include them.`));
  return r;
}

async function doServe(dir, args) {
  load(dir); // fail early with a helpful message if nothing is prepared
  let port = Number(args.port || process.env.DIFFDECK_PORT || 4777);
  let server;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { server = await serve(dir, port); break; } catch (e) {
      if (e.code !== 'EADDRINUSE' || args.port) throw e;
      port++;
    }
  }
  const url = `http://127.0.0.1:${port}/`;
  const hasBreakdown = fs.existsSync(path.join(dir, 'breakdown.json'));
  console.log(`${c.green('✓')} diffdeck is running at ${c.b(c.blue(url))}`);
  if (!hasBreakdown) console.log(`  ${c.yellow('No breakdown yet.')} In your agent run ${c.b('/diffdeck-breakdown')} (or say "follow .diffdeck/AGENT_TASK.md"); the page updates by itself.`);
  console.log(`  Feedback is saved to ${c.dim(path.join(dir, 'feedback.md'))}`);
  console.log(c.dim('  Press Ctrl+C to stop.'));
  if (!args['no-open']) openBrowser(url);
  process.on('SIGINT', () => { server.close(); process.exit(0); });
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  const known = ['review', 'demo', 'init', 'agent-setup', 'prepare', 'serve', 'validate', 'feedback', 'post', 'login', 'help'];
  const cmd = !first || first.startsWith('-') ? 'review' : first;
  const args = parseArgs(cmd === first ? argv.slice(1) : argv);

  if (args.help || args.h || cmd === 'help') { process.stdout.write(HELP); return; }
  if (args.version || argv.includes('-v')) { console.log(version); return; }
  if (args.y) args.yes = true;
  if (!known.includes(cmd)) { process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`); process.exitCode = 2; return; }

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
      console.log(`${c.green('✓')} Added agent commands:`);
      for (const w of written) console.log(`  ${w}`);
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
