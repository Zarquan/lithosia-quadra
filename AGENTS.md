<!--
  <meta:header>
    <meta:licence>
      Copyright (C) 2026 by Wizzard Solutions Ltd, wizzard@metagrid.co.uk

      This information is free software: you can redistribute it and/or modify
      it under the terms of the GNU General Public License as published by
      the Free Software Foundation, either version 3 of the License, or
      (at your option) any later version.

      This information is distributed in the hope that it will be useful,
      but WITHOUT ANY WARRANTY; without even the implied warranty of
      MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
      GNU General Public License for more details.

      You should have received a copy of the GNU General Public License
      along with this program.  If not, see <http://www.gnu.org/licenses/>.
    </meta:licence>
  </meta:header>

  AIMetrics: [
      {
      "timestamp": "2026-10-07T03:37:40",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 100,
        "units": "%"
        }
      },
      {
      "timestamp": "2026-10-07T03:43:36",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 5,
        "units": "%"
        }
      }
    ]
-->

# AGENTS.md

Guidance for AI agents working in this repository. Humans should start with
[README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## What this is

Notes and tooling for running the **DeepSeek Harness (DSH)** inside the
Calycopis developer container. There is no application code: the tracked
content is one migration tool plus dated operational notes. The project is named
after the moth *Lithosia quadra*.

## Layout

| Path | In git | What it is |
|---|---|---|
| `dsh/` | **no** (`.gitignore`) | the **live** DSH home: sessions, storages, profiles, backups, credentials |
| `tools/migration/` | yes | session rebase tool and its runbook (`MIGRATION-README.md`) |
| `notes/` | yes | dated operational notes |
| `docker/Dockerfile` | untracked | container image that installs DSH and the web proxy plugin |
| `attic/sessions/` | **no** (`.gitignore`) | pre-transfer session directories, **not referenced by any tool** |

## Non-negotiable safety rules

1. **Never commit anything under `dsh/`.** It is gitignored deliberately. It
   holds `.credentials.yaml` (secrets), real session logs and the live workspace
   registry. Do not read or print `.credentials.yaml`, and never `git add -f
   dsh/`.
2. **Stop `dsh web` before editing durable state offline.** The host caches the
   workspace registry in memory and rewrites `storages/workspace.json` on its
   next mutation, which clobbers offline edits made underneath it. The migration
   tool enforces this; `--force-running` bypasses the guard and is only ever
   acceptable against a throwaway copy.
3. **Preview before applying.** `--dry-run` writes nothing and is safe while the
   host is running.
4. **Never experiment against the live `dsh/` tree.** Copy it and work on the
   copy (recipe below).

## Environment

- `DSH_HOME=/Zarquan/lithosia-quadra/dsh`; projects are mounted at `/Calycopis/…`
  and `/Zarquan/lithosia-quadra`.
- DSH is installed globally: `@deepseek-ai/dsh` **0.2.0-rc.2** under
  `/usr/local/lib/node_modules/@deepseek-ai/dsh`. Reading its `lib/` is the
  fastest way to confirm how DSH behaves — the specs the migration tool pins are
  `dsh-workspace` and `dsh-session-persistence-jsonl`.
- Node.js **>= 22.15** is required (`node:zlib` zstd support); the host runs
  v22.23.
- The host is started with `dsh web --no-open`; the GUI is on `127.0.0.1:3080`
  and the proxy plugin publishes `3081`.
- The workspace registry stores **canonical** paths (DSH realpaths them), and a
  session's project is derived from the `cwd` field in its log header.
- There is no `package.json`, no dependencies and no test framework. The
  migration tool deliberately uses only the Node standard library.

## Working on the migration tool

`tools/migration/migrate-sessions-to-top-level.mjs` rebases sessions onto a
top-level workspace by rewriting durable DSH state offline. Read
`tools/migration/MIGRATION-README.md` before changing it; it documents the
rationale, the runbook, rollback and the format pins.

Operating notes:

- Locations default to `$DSH_HOME` (falling back to `~/.dsh`), so no path flags
  are needed on a normal host.
- `--only <session-id>` migrates one session; it accepts `session-<uuid>` or the
  bare uuid and is repeatable.
- Unreadable sessions are fatal by default (`--allow-skipped` overrides), and
  `--dry-run` reports the same refusal so a preview predicts the apply.
- The script pins the DSH formats it understands. **After a DSH upgrade,
  re-verify those pins** (see "Format compatibility" in the runbook) before
  migrating; an unexpected workspace-registry version aborts by design.

### Verification recipe

This is the project's de-facto test suite. It needs no fixtures beyond a copy of
the live home:

```bash
# 1. Throwaway copy of the sessions and the three storage artifacts, plus
#    reference copies of the artifacts to compare against after a rollback.
rm -rf .scratch && mkdir -p .scratch/dsh/storages
cp -a dsh/sessions .scratch/dsh/sessions
cp -a dsh/storages/workspace.json dsh/storages/session_projcache.json .scratch/dsh/storages/
cp -a dsh/storages/session_projcache .scratch/dsh/storages/session_projcache
cp .scratch/dsh/storages/workspace.json .scratch/ws.orig.json
cp .scratch/dsh/storages/session_projcache.json .scratch/cache.orig.json

R="--dsh-home .scratch/dsh --sessions-root .scratch/dsh/sessions --backup-root .scratch/dsh/backups"

# 2. Dry run, then apply to the copy (the host guard needs --force-running here).
node tools/migration/migrate-sessions-to-top-level.mjs --dry-run $R
node tools/migration/migrate-sessions-to-top-level.mjs --apply --yes --force-running $R

# 3. Check the result against the backup the run just took: for every migrated
#    session, the decoded body after the header line must be byte-identical to
#    the backed-up original, and any session not selected must be untouched
#    (`cmp` the whole file, since nothing should have rewritten it). The header
#    `cwd` is the only field expected to change.

# 4. Roll back and confirm the storage artifacts are reproduced exactly.
bk=$(ls -d .scratch/dsh/backups/session-rebase-* | head -1)
node tools/migration/migrate-sessions-to-top-level.mjs --restore "$bk" --yes --force-running \
    --dsh-home .scratch/dsh --sessions-root .scratch/dsh/sessions
cmp .scratch/dsh/storages/workspace.json .scratch/ws.orig.json
cmp .scratch/dsh/storages/session_projcache.json .scratch/cache.orig.json

rm -rf .scratch
```

Ad-hoc checks are done with `node -e` against the zstd logs (decode the first
frame for the header, scan frames to compare bodies). Delete every scratch
directory when finished — nothing here is gitignored.

## Coding rules

The rules in [`agents/rules/`](agents/rules/) are imported from the
Calycopis-broker project and adapted for this one — each file records what was
changed. They apply to every file an agent creates or modifies, and to every
agent commit message.

| Rule | Requirement |
|---|---|
| [`licence-header.mdc`](agents/rules/licence-header.mdc) | Every new source file starts with the GPL `<meta:header>` block, using the comment syntax for its language and the Wizzard Solutions Ltd copyright line. |
| [`copyright-year.mdc`](agents/rules/copyright-year.mdc) | When a file carrying a `<meta:licence>` block is modified, bump its `Copyright (C) YYYY` to the current year. |
| [`ai-metrics.mdc`](agents/rules/ai-metrics.mdc) | Every created or modified file header carries an `AIMetrics` block, appended to rather than replacing existing entries, and every agent commit message ends with an `AIMetrics` block using `interval` in place of `timestamp`. |
| [`unexpected-behaviour.mdc`](agents/rules/unexpected-behaviour.mdc) | Stop and ask before coding around unexpected behaviour from an API, service or component — including DSH's own on-disk behaviour. |

The `name`, `version` and `model` values must describe the agent that actually
did the work in the current session. For DSH that is `@deepseek-ai/dsh`, the
installed version (`dsh --version`), and the `model` from the
`agent-default-model` entry of the active profile
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`).

`agents/rules/*.mdc` are exempt from the header rules, matching the form they
have upstream.

## Conventions

- **Commits**: past-tense subject; body separated by a blank line explaining
  what changed and why. Keep each change focused, and split unrelated work into
  separate commits. Every agent commit also ends with an `AIMetrics` block — see
  [Coding rules](#coding-rules).
- **DCO sign-off**: `CONTRIBUTING.md` asks every commit to carry
  `Signed-off-by:` (`git commit -s`). Note that the history so far, including
  recent commits, does **not** carry the trailer.
- **Licence**: GPL-3.0-or-later (see `LICENSE`), applied through the
  `<meta:header>` block required by [Coding rules](#coding-rules). New
  `notes/*.txt` files keep the leading `<meta:header>` block and the
  `#zrq-notes-*` tags.
- **Notes**: named `YYYYMMDD-NN-topic.txt`, one topic per file.
- **Style**: no new dependencies unless there is no alternative; comment the
  *why* (particularly where behaviour mirrors a DSH internal), and prefer a
  loud, early failure over a silent partial result.
