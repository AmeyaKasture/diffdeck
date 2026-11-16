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
Size: ${files.length} files, ${hunkCount} hunks.

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
open at http://127.0.0.1:4777/agentic-cloud/ (all reviews:
http://127.0.0.1:4777/)." Then, briefly, the most important findings. In the
page, the reviewer can either hand the feedback back to you (**Hand off to
agent**) or publish it on the PR (**Post on GitHub**).
`;
}

const APPLY_TASK = `# diffdeck: apply review feedback

1. Read \`.diffdeck/feedback.md\`. It lists, per change card, the design
   decisions the reviewer wants switched, line comments with file:line
   references, and card-level comments.
2. Implement every item under "Requested changes". Do not modify cards
   listed under "Approved".
3. For a switched decision, implement the preferred option as described,
   including its consequences in tests and call sites.
4. If an item is ambiguous or conflicts with another, stop and ask instead of
   guessing.
5. Run the project's tests/linters, then summarise what you changed per item.
`;

// Slash-command style prompts for agents that support custom commands.
const COMMANDS = {
  'diffdeck-breakdown': {
    description: 'Break a pull request into an interactive diffdeck review (argument: PR link)',
    args: '<PR link>',
    body: `Pull request to review: $ARGUMENTS

1. If no pull request link or number was given above, ask the user: "Which pull request should I break down? Paste its link (for example https://github.com/org/repo/pull/42)." Wait for the answer and do nothing else until you have it. If the user says there is no PR, ask which base branch to compare against and use that instead of \`--pr\` below.
2. Run \`diffdeck prepare --pr <link>\` in the root of the PR's repository. If the PR belongs to a different repository than the current folder, use the user's local clone of that repository (look for it, or ask where it is); diffdeck warns when they differ. If it fails because \`gh\` is missing or not logged in, tell the user to run \`diffdeck login\` and stop.
3. Read \`.diffdeck/AGENT_TASK.md\` and follow it exactly.
4. When \`diffdeck validate\` passes, run \`diffdeck serve\` from the folder where you ran \`prepare\`. It adds this repository to the shared review server (starting it if needed), opens the browser and prints the repository's address, like \`http://127.0.0.1:4777/<repository-name>/\`. Begin your final message with "The review is open at <that address>", copied exactly, then summarise the key findings.`,
  },
  'diffdeck-apply': {
    description: 'Implement the feedback left in diffdeck',
    body: 'Read `.diffdeck/feedback.md` and implement it, following these rules:\n\n' + APPLY_TASK.split('\n').slice(2).join('\n'),
  },
};

const TARGETS = {
  claude: { dir: '.claude/commands', fmt: (c) => `---\ndescription: ${c.description}\n${c.args ? `argument-hint: ${c.args}\n` : ''}---\n\n${c.body}\n` },
  cursor: { dir: '.cursor/commands', fmt: (c) => `${c.body.replace('$ARGUMENTS', 'the link or number the user typed after this command (it may be empty)')}\n` },
  opencode: { dir: '.opencode/command', fmt: (c) => `---\ndescription: ${c.description}\n---\n\n${c.body}\n` },
};

function installCommands(root, targets) {
  const written = [];
  for (const t of targets) {
    const spec = TARGETS[t];
    if (!spec) throw new Error(`Unknown agent "${t}". Use: ${Object.keys(TARGETS).join(', ')}`);
    const dir = path.join(root, spec.dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, cmd] of Object.entries(COMMANDS)) {
      const file = path.join(dir, `${name}.md`);
      fs.writeFileSync(file, spec.fmt(cmd));
      written.push(path.relative(root, file));
    }
  }
  return written;
}

const AGENTS_MD_SNIPPET = `## diffdeck (interactive diff review)
- To break down a pull request: the user must give its link. If they did not, ask for it before doing anything. Then run \`diffdeck prepare --pr <link>\` and follow \`.diffdeck/AGENT_TASK.md\`.
- To apply review feedback: read \`.diffdeck/feedback.md\` and implement every item under "Requested changes"; leave "Approved" cards alone.
`;

module.exports = { agentTask, APPLY_TASK, installCommands, AGENTS_MD_SNIPPET, AGENT_TARGETS: Object.keys(TARGETS) };
