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
      },
      {
      "timestamp": "2026-10-07T03:46:36",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 10,
        "units": "%"
        }
      },
      {
      "timestamp": "2026-10-07T04:19:49",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 25,
        "units": "%"
        }
      },
      {
      "timestamp": "2026-10-07T06:04:28",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 5,
        "units": "%"
        }
      },
      {
      "timestamp": "2026-10-07T06:42:37",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 10,
        "units": "%"
        }
      },
      {
      "timestamp": "2026-10-07T07:02:01",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 10,
        "units": "%"
        }
      },
      {
      "timestamp": "2026-10-07T08:13:29",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 2,
        "units": "%"
        }
      },
      {
      "interval": "2026-10-07T08:56:04/2026-10-07T08:56:46",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 3,
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
| `agents/rules/` | yes | coding rules imported from Calycopis-broker |
| `agents/git-identity.env` | yes | the identity used as the author of agent commits |
| `agents/hooks/` | yes | versioned git hooks, currently the DCO guard |
| `bin/` | yes | agent tooling: `agent-commit`, `setup-agent-git`, `gh` |
| `notes/` | yes | dated operational notes |
| `docker/Dockerfile` | yes | container image: DSH, the web proxy plugin, `gh` |
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

### Credential scrubbing

DSH removes credential-shaped variables from the environment of every process it
spawns, so a secret present in the container does **not** reach agent shell
commands. `@deepseek-ai/dsh-subprocess` applies:

```js
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
```

together with every `DSH_*` name; `PATH`, `HOME`, locale and proxy variables
survive. So `GITHUB_TOKEN`, `DEEPSEEK_API_KEY` and `DB_PASSWORD` are stripped —
and so are `MONKEY` and `KEYBOARD`, because the pattern is an unanchored match —
while `CALYCOPIS_CODE` and `PATH` pass through untouched.

Practical consequences here:

- A token exported into the container will not be visible to `bash` tool calls
  under its usual name. Test with `bash -c 'echo ${VAR:+SET}'` inside a tool
  call, **not** with `podman exec`, which takes a different path and will
  mislead you.
- **A secret that has to reach a shell is mounted, not injected.** A podman
  secret defaults to `type=mount`, which writes a file at `/run/secrets/<name>`;
  the scrub removes environment variables, so a file is untouched:

  ```
  --secret dsh-github-token        # -> /run/secrets/dsh-github-token
  ```

  [`bin/gh`](bin/gh) reads that file, so `bin/gh issue list …` works with no
  environment variable at all. Anything else can do the same with
  `$(cat /run/secrets/dsh-github-token)`: assigning it inline works because the
  scrub has already run by the time the command line is evaluated.
- Renaming a variable to dodge the pattern — `GITHUB_AUTH` and `GH_PAT` both
  survive, verified — also works, but it deliberately exempts one secret from
  the control, the name looks arbitrary wherever it is configured, and a future
  tightening of the pattern would break it again. Prefer the mount.
- The mounted podman socket bypasses the scrub entirely
  (`podman exec <container> bash -c 'printf %s "$VAR"'`). That is why the scrub
  must **not** be treated as isolation: while the socket is mounted, anything in
  the container environment is reachable by an agent that goes looking. A
  mounted secret file is equivalent in exposure, but does not need the socket.
- The behaviour is deliberate, not a defect. The reasoning, evidence and the
  options for working with it are recorded in GitHub issue **#5**.

### Writing outside the workspace

The file sandbox runs at `workspace-write`: the session workspace is writable, as
are some platform temporary areas, but `/usr`, `/var`, `/etc` and the like are
not. A package install therefore fails, and it fails misleadingly — `dnf` reports
*"The requested operation requires superuser privileges"* even when running as
root, because it is seeing `EACCES` from the sandbox and not a privilege problem.

Installing software needs the command run with a wider sandbox mode, which asks
for approval. Do not route around a denial by another path — policy refuses that
— ask for the wider mode instead, and for one command only.

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
| [`ai-metrics.mdc`](agents/rules/ai-metrics.mdc) | One `AIMetrics` entry per **change**, not per edit, appended to a file header rather than replacing existing entries: `timestamp` for a change made in one pass, or `interval` covering it when several edits were made in sequence. Every agent commit message ends with one using `interval`, and so does every GitHub issue an agent creates, in a fenced code block. |
| [`unexpected-behaviour.mdc`](agents/rules/unexpected-behaviour.mdc) | Stop and ask before coding around unexpected behaviour from an API, service or component — including DSH's own on-disk behaviour. |

The `name`, `version` and `model` values must describe the agent that actually
did the work in the current session. For DSH that is `@deepseek-ai/dsh`, the
installed version (`dsh --version`), and the `model` from the
`agent-default-model` entry of the active profile
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`).

Headers are not required on files that are not authored work:

- **dotfiles** — a file whose name begins with `.`, anywhere in the tree
  (`.gitignore`, `.gitattributes`, `.editorconfig`, `.env`);
- **lockfiles and machine-generated files** — regenerated by their tool rather
  than written (`pnpm-lock.yaml`, `package-lock.json`);
- **`agents/rules/*.mdc`** — imported configuration, kept in upstream form.

Hand-authored configuration is not exempt: YAML, JSON, XML, Dockerfiles and
shell scripts are source and get a header. See
[`agents/rules/licence-header.mdc`](agents/rules/licence-header.mdc) for the
per-language templates.

## Conventions

- **Commits**: past-tense subject; body separated by a blank line explaining
  what changed and why. Keep each change focused, and split unrelated work into
  separate commits. Every agent commit also ends with an `AIMetrics` block — see
  [Coding rules](#coding-rules).
- **Commit identity and DCO sign-off**: agent commits are authored by the agent
  and signed off by the human, through `bin/agent-commit`. See
  [Commit identity and sign-off](#commit-identity-and-sign-off).
- **Licence**: GPL-3.0-or-later (see `LICENSE`), applied through the
  `<meta:header>` block required by [Coding rules](#coding-rules). New
  `notes/*.txt` files keep the leading `<meta:header>` block and the
  `#zrq-notes-*` tags.
- **Notes**: named `YYYYMMDD-NN-topic.txt`, one topic per file.
- **Style**: no new dependencies unless there is no alternative; comment the
  *why* (particularly where behaviour mirrors a DSH internal), and prefer a
  loud, early failure over a silent partial result.

### Commit identity and sign-off

`CONTRIBUTING.md` requires a `Signed-off-by:` trailer on every commit. Agent
commits satisfy that without a human running git: the agent is recorded as the
**author**, while the repository's configured user — the person who approved the
change — remains the **committer**, so `git commit --signoff` names them.

| Field | Value |
|---|---|
| Author | `DeepSeek Harness <zrq-github+dsh@metagrid.co.uk>`, from [`agents/git-identity.env`](agents/git-identity.env) |
| Committer and `Signed-off-by` | your `.git/config` identity, e.g. `Zarquan <zrq-github@metagrid.co.uk>` |

Commit with the wrapper, never with plain `git commit`:

```bash
bin/agent-commit -m "Message"
bin/agent-commit -F -          # message on stdin
```

Rules for agents:

- Commit **only after the human has explicitly approved the exact change set and
  the commit message**. That approval *is* the DCO certification; nothing
  enforces it technically, so do not read a general "looks good" as approval to
  commit, and do not commit unprompted.
- Pass whatever `git commit` arguments you need (`-m`, `-F -`, `--amend`,
  `--allow-empty`). `--author` is rejected because the wrapper fixes it.
- `AGENT_GIT_NAME`/`AGENT_GIT_EMAIL` override the committed identity for a
  one-off; the guard resolves the identity the same way, so an override stays
  self-consistent.
- The `Signed-off-by` trailer is appended **after** the `AIMetrics` block.
  `git interpret-trailers` reads both correctly.

[`bin/setup-agent-git`](bin/setup-agent-git) additionally switches on the guard
in [`agents/hooks/commit-msg`](agents/hooks/commit-msg), which refuses any
commit made from a DSH session that did not come through the wrapper. It works
by comparing the resolved author against the agent identity, and by requiring
the sign-off; a human's own shell (`DSH_SESSION_ID` unset) is never policed.
It is per clone, since it sets `core.hooksPath`, and `--no-verify` bypasses it.

Caveats: `--amend` keeps the original author, so use `--reset-author` to
re-attribute; `git merge` never calls the wrapper, so agent merges need the same
`GIT_AUTHOR_*` variables or should be left to a human; `git rebase --signoff`
signs off as the committer, which is correct, and deduplicates, so a commit that
already carries the same trailer does not gain a second one.

Note that neither `git merge` nor `git rebase` runs the `commit-msg` guard, even
though both create commits. A rebase of the commits made before this arrangement
ran with the guard enabled, from a DSH session, and was not refused — the guard
sees `git commit` only. That makes a rebase a way past it, which is worth knowing
before assuming the guard covers every commit in the history.

The commits made before this arrangement were unsigned until 2026-10-07, when a
`git rebase --signoff` signed them. That rewrote every commit after
`origin/main` — not only the unsigned ones, because a change to an ancestor
changes every descendant — so **every hash changed**. Notes and issues that cite
those commits carry the hashes as they were after that rewrite; a hash quoted
from an older copy names a commit that is no longer on the branch.
