'use strict';

// Agent-facing instructions. Plain Markdown so any agent (Claude Code, Cursor,
// OpenCode, Codex, Aider, ...) can follow them without special integration.

const fs = require('fs');
const path = require('path');

function agentTask(meta, files) {
  const hunkCount = files.reduce((n, f) => n + f.hunks.length, 0);
  const suggested = Math.max(1, Math.min(12, Math.round(hunkCount / 3) || 1));
  return `# diffdeck: write the breakdown

You are explaining a code change so a human can review it as a deck of cards.
Source: ${meta.label}${meta.title ? ` — "${meta.title}"` : ''}
${meta.source === 'commit' ? `This is one commit (${meta.head}) compared with the commit before it (${meta.base}); explain what this commit changed and why.\n` : ''}${meta.source === 'branch' ? `This is branch \`${meta.branch}\` compared with \`${meta.base}\` from where it forked, like a pull request.\n` : ''}${meta.readRef ? `That code is not checked out here. Read files as they are in this change with \`git show ${meta.readRef.slice(0, 12)}:<path>\` instead of opening them from disk.\n` : ''}
Size: ${files.length} files, ${hunkCount} hunks.
${meta.previousRound ? `
**This is review round ${meta.round}.** The breakdown from round ${meta.previousRound} was carried
over: cards whose code did not change are kept as they are. Read
\`.diffdeck/refresh.md\` and only update what it lists (stale cards and
uncovered hunks) instead of writing the breakdown from scratch.
` : ''}
## Inputs (all in \`.diffdeck/\`)
- \`diff.patch\` — the raw unified diff. Read this to understand the change.
- \`hunks.md\` — every file with its hunk indexes and line ranges.
- \`breakdown.schema.json\` — the exact output format.
- You may also read the repository's source files for context.

## Output
Write \`.diffdeck/breakdown.json\` that conforms to the schema. Then run:

    diffdeck validate

Fix every error it reports. Warnings about uncovered hunks mean some hunks
are not in any card; add them to a fitting card.

## How to break it down
1. Group by **intent**, not by file. One card = one idea a reviewer can judge
   on its own (e.g. "Retry failed uploads", "Rename config keys", "Tests for
   retry"). A card may span several files; a file may be split across cards.
   Aim for roughly ${suggested} cards; never more than 15.
2. Every hunk belongs to exactly one card. Use \`{ "file": "...", "hunks": [0, 2] }\`
   with the indexes from \`hunks.md\`. Omit \`hunks\` to take the whole file.
3. Order cards in the order a reviewer should read them: core logic first,
   then call sites, then tests, config and docs. Use \`group\` for sections.
4. \`summary\` says what changed; \`why\` says what problem it solves. Be concrete:
   name functions, types and behaviours. No filler.
5. \`risk\`: high = could break production behaviour, data, security or public
   API; medium = logic change with limited blast radius; low = tests, docs,
   renames, formatting. Explain in \`riskNote\`.

## Design decisions (the most valuable part)
For each card with a real design choice, add 1-3 \`decisions\`:
- \`question\`: the choice that was made, phrased as a question
  ("How should the cache be invalidated?").
- \`chosen\`: what this diff actually does.
- \`alternatives\`: 1-3 realistic options a senior engineer would consider.
- \`pros\` / \`cons\`: specific to this codebase and change (performance,
  correctness, complexity, testability, compatibility). 2-4 each. No generic
  statements like "more flexible" without saying how.
- \`effort\` on alternatives: how much work switching would take.
Skip decisions for trivial cards (renames, formatting, test-only changes).
Do not invent behaviour that is not in the diff.

## Diagrams (the reviewer explores the change visually — always include them)
The review UI opens on a diagram, not on text. Both diagrams are clickable.

**System flow — top-level \`flow\`.** An architecture / data-flow diagram of
the parts of the system this change touches: callers (\`actor\`), modules and
functions in this repo (\`component\`), remote APIs (\`service\`), stores,
caches and config (\`data\`), and unchanged libraries (\`external\`).
- 5-14 nodes. Edges say how things interact: "calls", "reads", "HTTP GET",
  "writes", "emits".
- Mark \`change\` on nodes and edges: \`added\` (new in this diff), \`modified\`,
  \`removed\` (existed before, gone now — keep it in the diagram so the reviewer
  sees what disappeared), or \`unchanged\` (context).
- Set \`card\` on each changed node to the card that explains it; clicking the
  node opens that card.

**Logic flow — \`card.flow\`.** For every card with real control flow
(features, fixes, refactors of logic), a flowchart of what the code does
**after** the change:
- \`start\` / \`end\` pills, \`step\` boxes, \`decision\` diamonds (label as a
  question; label outgoing edges "yes" / "no" or the condition), \`io\` for
  network, disk or cache access. 4-12 nodes; loops are fine.
- \`ref: { "file", "lines": [start, end] }\` on each step points to the
  new-file lines that implement it (use \`"side": "old"\` and old line numbers
  for removed steps). Clicking the step highlights those lines.
- \`decision: <index>\` links a node to one of the card's design decisions;
  clicking it shows the alternatives with pros and cons.
- Mark \`change\` so new branches stand out from untouched logic.
Skip \`flow\` for docs, config-only and test-only cards.

## When done
Then open the review for the user by running:

    diffdeck serve

It returns immediately, opens the browser and prints this repository's own
review address, for example \`http://127.0.0.1:4777/<repository-name>/\`. One
background server hosts every repository the user reviews, each at its own
address, so nothing else needs to be stopped or started. Your final message must
start with that address, copied exactly as printed, for example: "The review is
open at http://127.0.0.1:4777/${meta.repo || 'my-repo'}/ (all reviews:
http://127.0.0.1:4777/)." Then, briefly, the most important findings. In the
page, the reviewer can either hand the feedback back to you (**Hand off to
agent**) or publish it on the PR (**Post on GitHub**).
`;
}

const APPLY_TASK = `# diffdeck: apply review feedback

1. Read \`.diffdeck/feedback.md\`. It lists, per change card, the design
   decisions the reviewer wants switched, line comments with file:line
   references, card-level comments, and questions.
2. Implement every item under "Requested changes". Do not modify cards
   listed under "Approved".
3. For a switched decision, implement the preferred option as described,
   including its consequences in tests and call sites.
4. Answer every item under "Questions" in \`.diffdeck/replies.json\`, keyed by
   the comment id shown next to it: \`{ "c1a2b3": "It is needed because ..." }\`.
   Keep answers that are already in the file. A question is not a request to
   change code; change code only if it also asks for a change. You may also
   reply to a requested change there, for example to explain how you did it.
5. If an item is ambiguous or conflicts with another, stop and ask instead of
   guessing.
6. Run the project's tests/linters.
7. Update the review so the reviewer sees the new code: run \`diffdeck refresh\`.
   It re-collects the same PR, branch or commit, keeps the cards whose code did
   not change (with their approvals) and writes \`.diffdeck/refresh.md\`
   listing the stale cards. Update only those cards and any uncovered hunks in
   \`.diffdeck/breakdown.json\`, run \`diffdeck validate\` until it passes, then
   \`diffdeck serve\`. A pull request only shows changes once they are pushed,
   and a commit never changes: in those cases tell the user instead (for a PR,
   push only if the user asks you to, then refresh).
8. Summarise what you changed per item, and start your final message with the
   review address printed by \`diffdeck serve\`.
`;

// Slash-command style prompts for agents that support custom commands.
const COMMANDS = {
  'diffdeck-breakdown': {
    description: 'Break a pull request, branch or commit into an interactive diffdeck review',
    args: '<PR link | branch | commit>',
    body: `What to review: $ARGUMENTS

1. If nothing was given above, ask the user: "What should I break down? Paste a pull request link, a branch name (compared against main), or a commit id (compared with the commit before it)." Wait for the answer and do nothing else until you have it.
2. Run \`diffdeck prepare <what the user gave>\` in the root of the repository it belongs to. diffdeck detects whether it is a PR, a branch or a commit; it prints which one it used, so check that this matches what the user meant. To be explicit, use \`--pr <link>\`, \`--branch <name>\` (add \`--base <branch>\` to compare against something other than main) or \`--commit <id>\`. If a PR belongs to a different repository than the current folder, use the user's local clone of that repository (look for it, or ask where it is). If \`gh\` is missing or not logged in for a PR, tell the user to run \`diffdeck login\` and stop.
3. Read \`.diffdeck/AGENT_TASK.md\` and follow it exactly.
4. When \`diffdeck validate\` passes, run \`diffdeck serve\` from the same folder. It adds this repository to the shared review server (starting it if needed), opens the browser and prints the repository's address, like \`http://127.0.0.1:4777/<repository-name>/\`. Begin your final message with "The review is open at <that address>", copied exactly, then summarise the key findings.`,
  },
  'diffdeck-apply': {
    description: 'Implement the feedback left in diffdeck',
    body: 'Read `.diffdeck/feedback.md` and implement it, following these rules:\n\n' + APPLY_TASK.split('\n').slice(2).join('\n'),
  },
};

// `dir` is inside a repository (init --repo); `home` is the per-user folder
// each agent also reads, so the default install leaves repositories untouched.
const TARGETS = {
  claude: { dir: '.claude/commands', home: '.claude/commands', fmt: (c) => `---\ndescription: ${c.description}\n${c.args ? `argument-hint: ${c.args}\n` : ''}---\n\n${c.body}\n` },
  cursor: { dir: '.cursor/commands', home: '.cursor/commands', fmt: (c) => `${c.body.replace('$ARGUMENTS', 'the link or number the user typed after this command (it may be empty)')}\n` },
  opencode: { dir: '.opencode/command', home: '.config/opencode/command', fmt: (c) => `---\ndescription: ${c.description}\n---\n\n${c.body}\n` },
};

// `where` is { root } for a repository or { home } for the user's folder.
function commandDir(where, spec) {
  return where.home ? path.join(where.home, spec.home) : path.join(where.root, spec.dir);
}

function shown(where, file) {
  return where.home ? path.join('~', path.relative(where.home, file)) : path.relative(where.root, file);
}

// `fallback` is how to run this installation of diffdeck directly, for agent
// shells where nvm (and so the diffdeck command) is not loaded.
function installCommands(where, targets, fallback) {
  const written = [];
  const note = fallback ? `\n\nIf the shell says \`diffdeck: command not found\`, run it as \`${fallback}\` instead (for example \`${fallback} prepare <target>\`).` : '';
  for (const t of targets) {
    const spec = TARGETS[t];
    if (!spec) throw new Error(`Unknown agent "${t}". Use: ${Object.keys(TARGETS).join(', ')}`);
    const dir = commandDir(where, spec);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, cmd] of Object.entries(COMMANDS)) {
      const file = path.join(dir, `${name}.md`);
      fs.writeFileSync(file, spec.fmt({ ...cmd, body: cmd.body + note }));
      written.push({ file, shown: shown(where, file) });
    }
  }
  return written;
}

// The command files `init` wrote (in `where`), for removal.
function commandFiles(where) {
  const found = [];
  for (const spec of Object.values(TARGETS)) {
    const dir = commandDir(where, spec);
    for (const name of Object.keys(COMMANDS)) {
      const file = path.join(dir, `${name}.md`);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (text.includes('diffdeck')) found.push({ file, shown: shown(where, file) });
    }
  }
  return found;
}

// Removes the given command files, and their folders if left empty.
function removeCommands(where, files) {
  const top = where.home || where.root;
  for (const f of files) {
    fs.unlinkSync(f.file);
    for (let d = path.dirname(f.file); d !== top && d.startsWith(top); d = path.dirname(d)) {
      try { fs.rmdirSync(d); } catch { break; }
    }
  }
  return files;
}

function uninstallCommands(where) {
  return removeCommands(where, commandFiles(where));
}

// Which agents an existing install covers.
function installedCommands(where) {
  return Object.entries(TARGETS).filter(([, spec]) => fs.existsSync(path.join(commandDir(where, spec), 'diffdeck-breakdown.md'))).map(([t]) => t);
}

// Paths, relative to the repository, that `init --repo` writes.
function repoCommandPaths(targets) {
  return targets.map((t) => TARGETS[t].dir + '/diffdeck-*.md');
}

const AGENTS_MD_SNIPPET = `## diffdeck (interactive diff review)
- To break down a change: the user gives a pull request link, a branch name (compared against main) or a commit id (compared with its parent). If they gave none, ask before doing anything. Then run \`diffdeck prepare <what they gave>\`, follow \`.diffdeck/AGENT_TASK.md\`, and finish with \`diffdeck serve\`, starting your reply with the address it prints.
- To apply review feedback: read \`.diffdeck/feedback.md\` and implement every item under "Requested changes"; leave "Approved" cards alone; answer "Questions" in \`.diffdeck/replies.json\`; then run \`diffdeck refresh\` and update the cards listed in \`.diffdeck/refresh.md\`.
`;

module.exports = { agentTask, APPLY_TASK, installCommands, uninstallCommands, installedCommands, commandFiles, removeCommands, repoCommandPaths, AGENTS_MD_SNIPPET, AGENT_TARGETS: Object.keys(TARGETS) };
