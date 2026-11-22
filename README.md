# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Sakti69/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Sakti69/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all
four formats models use: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. It finds the lines an edit names even when the model drifted their
whitespace or indentation, and changes every file or none. Built for the
make.fun bounty **"Build mend, one patch tool for every AI edit format"**
($100 USDC, 10 winners).

## Run it

```sh
node main.ts patch.diff
node main.ts --format=search-replace change.diff
cat patch.diff | node main.ts
node main.ts --check patch.diff
```

Node 22 and its standard library alone — nothing is installed before the
program runs. `SPEC.md` is the whole specification.

## The files

- `main.ts` — the CLI, run as `node main.ts [options] [PATCH]`.
- `runner.ts` — the kit's trial runner (kept as it is).
- `check.ts` — the 100 public practice checks on your own machine:

      node check.ts /path/to/practice.json

- `SPEC.md` — the specification the CLI implements.
- `LICENSE` — MIT.

## How it works

- Format detection: `*** Begin Patch` means V4A, a leading `[` or `{`
  means JSON, a `<<<<<<< SEARCH` line means SEARCH/REPLACE, a
  `diff --git` or `---`/`+++` pair means unified diff.
- Line matching runs at three tiers: exact, then ignoring trailing
  whitespace, then ignoring leading and trailing whitespace. `--strict`
  matches exactly only. A unified hunk takes the occurrence nearest its
  (possibly wrong) line number; a SEARCH/REPLACE block fails as ambiguous
  when its old lines occur more than once; a V4A chunk walks a cursor past
  its anchor.
- At tier 2, replacement lines are re-indented from the patch's indentation
  to the file's own indentation, and context lines are always written as
  the file's own matched lines.
- All-or-nothing: edits apply in order to the tree as earlier edits left
  it, a failed edit changes nothing, later edits still run, and when any
  edit failed no file is written. `--check` reports the same result without
  writing anything.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
