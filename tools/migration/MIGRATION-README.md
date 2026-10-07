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
        "value": 40,
        "units": "%"
        }
      }
    ]
-->

# Rebase existing DSH sessions onto `/Calycopis`

`migrate-sessions-to-top-level.mjs` moves sessions that were created in
sub-directories (`Calycopis-broker/...`, `Calycopis-openapi/...`) into the
top-level `/Calycopis` workspace, so they appear together in the GUI sidebar.

## Why a script is needed

DSH has no supported way to reassign a session's workspace:

- A session's project membership is **derived from the `cwd` field in its
  header**, and `Workspace.attachSession` rejects any session whose canonical
  `cwd` does not equal the workspace path.
- The workspace package documents this as a known limitation: *"a session from
  another directory cannot be moved in."*
- The host API exposes only create / rename / delete / reorder / archive — there
  is no "move session" operation, so the GUI has none either.
- Grouping is bootstrapped from session history **once**; afterwards the
  registry's `sessionIds` is the authoritative list.

The script therefore rewrites the durable state directly, keeping the header
`cwd` and the workspace registry in agreement.

## What it changes

| Artifact | Change |
|---|---|
| `<sessions>/<oldProjectKey>/<id>/` | Moved to `<sessions>/--Calycopis--/<id>/` |
| Session log header (first line, its own zstd frame) | `cwd` → `/Calycopis` |
| `<dsh-home>/storages/workspace.json` | Session ids move into the `/Calycopis` account; emptied sub-directory projects are removed |
| `<dsh-home>/storages/session_projcache.json` and `.../session_projcache/sessions/*.json` | Cached `identity.cwd` repointed so titles/stats stay valid |

Everything after the header frame is copied **byte-for-byte**; a backup of the
whole sessions root plus the storage artifacts is taken first.

Defaults are expressed against the harness home, named by the `DSH_HOME`
environment variable (which the harness falls back to `~/.dsh` when unset):

| Location | Default |
|---|---|
| `<dsh-home>` | `$DSH_HOME` |
| `<sessions>` | `<dsh-home>/sessions` (the shipped profile configures the sessions root as `dshHomePath('sessions')`) |
| `<backup-root>` | `<dsh-home>/backups` |

The script resolves `DSH_HOME` itself, with the same precedence as DSH
(`$DSH_HOME`, else `~/.dsh`), so it needs no path flags on a host DSH already
configures. Naming `--dsh-home` relocates the default sessions and backup roots
beneath it unless those are named too.

## Preconditions

- Node.js >= 22.15 (`node:zlib` zstd support) — this host has v22.23.
- **The DSH host must be stopped.** It caches the workspace registry in memory
  and rewrites `workspace.json` on its next mutation, which would clobber the
  edit. The script refuses to run while `dsh web` is detected; `--dry-run` is
  safe at any time.

## Runbook

```bash
# Run from the repository root. The script reads the harness home from
# `DSH_HOME` (falling back to `~/.dsh`), so no path flags are needed.

# 1. Preview (safe while the GUI is running; writes nothing)
node tools/migration/migrate-sessions-to-top-level.mjs --dry-run

# 2. Stop the DSH host (the script prints its pid if you run step 3 too early)
pkill -f 'dsh web'

# 3. Apply (takes a backup automatically; asks for no confirmation with --yes)
node tools/migration/migrate-sessions-to-top-level.mjs --apply --yes

# 4. Restart the host the same way it was started
dsh web --no-open
```

Then reload the GUI: the former `Calycopis-broker-uksrc-zrq` and
`Calycopis-openapi-uksrc-zrq` projects are gone and all 14 sessions are listed
under `Calycopis` (newest first).

### Options

| Flag | Meaning |
|---|---|
| `--dry-run` | Print the plan; write nothing. |
| `--apply --yes` | Perform the migration. |
| `--restore <backup-dir>` | Undo a run from its backup. |
| `--target <path>` | Target workspace (default `/Calycopis`). |
| `--sessions-root`, `--dsh-home`, `--backup-root` | Override the `$DSH_HOME`-derived locations above. |
| `--only <session-id>` | Migrate only the named session(s). Repeatable; accepts `session-<uuid>` or the bare uuid. See below. |
| `--keep-projects` | Leave emptied sub-directory workspaces registered instead of removing them. |
| `--allow-skipped` | Migrate even when a stored session cannot be read; it is left behind. |
| `--allow-newer-format` | Migrate sessions whose log format is newer than the validated v4 header layout. |
| `--force-running` | Proceed despite a detected DSH host (unsafe). |

### Migrating a single session

By default every session whose header `cwd` is not the target is migrated. To
move one session and leave the rest alone, name it with `--only` (repeatable):

```bash
# preview just this session
node tools/migration/migrate-sessions-to-top-level.mjs --dry-run \
    --only <uuid>

# apply it
node tools/migration/migrate-sessions-to-top-level.mjs --apply --yes \
    --only <uuid>
```

Sessions that would otherwise have moved are listed as `Not selected` and are
left untouched; sessions already on the target are still reported as skipped.
An id that matches no stored session aborts before the backup is taken, so a
typo cannot quietly do nothing. The filter is idempotent too — naming a session
that already sits on the target reports "nothing to do" rather than rewriting
it.

### Unreadable sessions

A session that cannot be read — a corrupt or unreadable header, a header with no
`cwd`, or a session directory with no generation file — would be left behind, so
the script refuses rather than migrating a partial history. The refusal names
them and offers two ways forward: `--only` to migrate one specific session
anyway, or `--allow-skipped` to migrate everything else and leave the unreadable
ones alone. `--dry-run` reports the same refusal and exits non-zero too, so a
preview predicts what an apply would do.

### Format compatibility

The script writes durable DSH state directly, so it pins the formats it
understands and checks them before writing anything:

| Artifact | Pinned format | On mismatch |
|---|---|---|
| `storages/workspace.json` | `workspace` v2 | **Aborts** before the backup. DSH opens it as a whole-unit document and rejects a version it does not expect, so writing the wrong shape would leave the harness unable to open its own registry. |
| `storages/session_projcache.json`, `storages/session_projcache/sessions/*.json` | `session_projcache` v7, accepting the declared v3–v6 predecessors | **Reports and skips** that document. The cache is derived data that DSH rebuilds, and its own store discards records it cannot read. |
| Session logs | header format v4 | Treated as an unreadable session and refused, unless `--allow-newer-format` is given. |

Two behaviours DSH does not export are pinned by self-tests that run on every
invocation: `projectKey`, against golden values captured from DSH's own
implementation, and the zstd frame scanner, against a stream the script builds
itself. If either drifts, the run fails immediately rather than filing sessions
under the wrong project directory or corrupting a log. After a DSH upgrade,
re-verify these pins against `@deepseek-ai/dsh-session-persistence-jsonl` and
`@deepseek-ai/dsh-workspace` before migrating.

## Rollback

Each run prints its backup directory. To undo:

```bash
# stop the host first
dsh_home="${DSH_HOME:-$HOME/.dsh}"
node tools/migration/migrate-sessions-to-top-level.mjs \
    --restore "$dsh_home/backups/session-rebase-<timestamp>" \
    --yes
# restart the host
```

Restore copies the original session directories back to their old project
directories and restores `workspace.json` and the projection caches. Note that
this discards anything written to those sessions *after* the migration, so
restore promptly if you are going to.

## What was verified before handing this over

The script was exercised end-to-end against a throwaway copy of the real
sessions root and storages (13 sessions, 15 generation files, 47.8 MB of
decompressed JSONL):

- every generation's **body is byte-identical** after migration — only the
  header's `cwd` differs;
- zstd **frame counts and the independent-header-frame invariant** are preserved
  (the header is rebuilt as its own frame; all later frames are untouched);
- legacy v0 logs (`session.jsonl.zstd`) migrate alongside the current v3 logs;
- the registry has no duplicate accounts and `workspaceIds` matches its table,
  which is what DSH validates at startup;
- cached titles are preserved and the session order is genuinely newest-first;
- `--restore` reproduces the original sessions tree and storage files exactly;
- `--apply` refuses to run while a DSH host is detected.

## Notes and limitations

- Legacy v0 sessions are migrated to the current format by DSH itself the first
  time they are opened; the script only rewrites their header `cwd`.
- Emptied sub-directory projects are removed from the sidebar. Their directories
  still exist on disk — removing a workspace registration never deletes files.
  If you later start a new session in one of those directories, re-add it as a
  project from the GUI.
- The script is idempotent: sessions already on the target are skipped.
