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
| `--keep-projects` | Leave emptied sub-directory workspaces registered instead of removing them. |
| `--force-running` | Proceed despite a detected DSH host (unsafe). |

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
