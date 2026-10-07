#!/usr/bin/env node
// <meta:header>
//   <meta:licence>
//     Copyright (C) 2026 by Wizzard Solutions Ltd, wizzard@metagrid.co.uk
//
//     This information is free software: you can redistribute it and/or modify
//     it under the terms of the GNU General Public License as published by
//     the Free Software Foundation, either version 3 of the License, or
//     (at your option) any later version.
//
//     This information is distributed in the hope that it will be useful,
//     but WITHOUT ANY WARRANTY; without even the implied warranty of
//     MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//     GNU General Public License for more details.
//
//     You should have received a copy of the GNU General Public License
//     along with this program.  If not, see <http://www.gnu.org/licenses/>.
//   </meta:licence>
// </meta:header>
//
// AIMetrics: [
//     {
//     "timestamp": "2026-10-07T03:37:40",
//     "name": "@deepseek-ai/dsh",
//     "version": "0.2.0-rc.2",
//     "model": "deepseek-flash",
//     "contribution": {
//       "value": 35,
//       "units": "%"
//       }
//     }
//   ]
//
/**
 * Rebase existing DSH sessions onto a top-level workspace directory.
 *
 * WHY THIS EXISTS
 * ---------------
 * DSH derives a session's project (workspace) membership from the `cwd` field
 * in the session header, and `Workspace.attachSession` refuses any session
 * whose canonical cwd differs from the workspace path. There is no supported
 * API or GUI action to move a session between workspaces, so sessions created
 * in a sub-directory stay grouped under that sub-directory forever.
 *
 * This script performs the equivalent migration OFFLINE, by rewriting the two
 * halves of that derivation so they agree:
 *
 *   1. the session header's `cwd` (first line, in its own zstd frame), and
 *   2. the session directory location under the sessions root, which DSH
 *      recomputes from cwd and asserts against the physical path, and
 *   3. the workspace registry's ordered `sessionIds` accounts.
 *
 * WHAT IT TOUCHES
 * ---------------
 *   <sessions-root>/<projectKey(oldCwd)>/<id>/   ->  <sessions-root>/<projectKey(target)>/<id>/
 *   <dsh-home>/storages/workspace.json
 *   <dsh-home>/storages/session_projcache.json
 *   <dsh-home>/storages/session_projcache/sessions/<id>.json
 *
 * A complete copy of the sessions root and the three storage artifacts is
 * taken first, under <backup-root>/session-rebase-<timestamp>/.
 *
 * LOCATIONS
 * ---------
 *   The harness home is read from the DSH_HOME environment variable, falling
 *   back to ~/.dsh — the same precedence DSH's own `resolveDshHome` applies.
 *   The sessions root and backup root then default to <dsh-home>/sessions and
 *   <dsh-home>/backups, matching the shipped profile's `dshHomePath('sessions')`
 *   layout, so no path flags are needed on a host DSH already configures.
 *   Naming --dsh-home relocates the other two unless they are named too.
 *
 * REQUIREMENTS
 * ------------
 *   - The DSH host (e.g. `dsh web`) MUST be stopped: it caches the workspace
 *     registry in memory and rewrites workspace.json on its next mutation,
 *     which would clobber the edits made here. `--dry-run` may be used while
 *     it runs.
 *   - Node.js >= 22.15 (node:zlib zstd support).
 *
 * USAGE
 * -----
 *   node migrate-sessions-to-top-level.mjs --dry-run
 *   node migrate-sessions-to-top-level.mjs --apply --yes
 *   node migrate-sessions-to-top-level.mjs --restore <backup-dir> --yes
 *   node migrate-sessions-to-top-level.mjs --dry-run --only session-<uuid>
 *   node migrate-sessions-to-top-level.mjs --apply --yes --only <uuid> ...
 *
 * See MIGRATION-README.md for the full runbook.
 */

import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;
const NEWLINE = 0x0a;

/**
 * DSH stamps every frame it writes with a zstd content checksum
 * (`CHECKSUM_OPTIONS` in `@deepseek-ai/dsh-session-persistence-jsonl`). Match
 * it so a rebuilt header frame is the encoding DSH would have produced, not
 * merely one it can read.
 */
const DSH_FRAME_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/* ------------------------------------------------------------------ *
 * DSH format pins
 * ------------------------------------------------------------------ */

/**
 * The on-disk formats this script reads and writes. Each mirrors a DSH
 * specification — `workspaceDomainSpec` in `@deepseek-ai/dsh-workspace` and
 * `projectionCacheDomainSpec` in `@deepseek-ai/dsh-session-projection-cache`.
 * A DSH upgrade that bumps one of these needs the matching code path here
 * re-verified before the pin is changed. See MIGRATION-README.md.
 */
const WORKSPACE_DOMAIN = { name: 'workspace', version: 2 };
const PROJCACHE_DOMAIN = {
  name: 'session_projcache',
  version: 7,
  compatible: [3, 4, 5, 6],
};

/**
 * Highest session-log format whose header semantics this script was verified
 * against (`SESSION_FORMAT_VERSION` is 4 as of DSH 0.2.0-rc.2). A newer header
 * is refused rather than rewritten, because a future format could move or
 * rename the `cwd` field this migration depends on.
 */
const VALIDATED_SESSION_VERSION = 4;

/* ------------------------------------------------------------------ *
 * zstd concatenated-frame container
 * ------------------------------------------------------------------ */

/**
 * Locate complete Zstandard frames in a concatenated-frame stream.
 *
 * This mirrors DSH's own `scanZstdFrames`: DSH stores each append batch as its
 * own frame, and requires the FIRST frame to decode to exactly the header
 * line. We therefore parse frame boundaries structurally (never decompressing
 * the bulk) so that everything after frame 0 can be preserved byte-for-byte.
 *
 * @param {Buffer} buf - complete artifact bytes.
 * @returns {{frames: Array<{start: number, end: number}>, tornStart?: number}}
 */
function scanFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buf.length) return { frames, tornStart: start };
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * Exercise the frame scanner against a stream this script builds itself. DSH
 * does not export `scanZstdFrames`, so this pins this copy's behaviour — frame
 * boundaries, checksummed frames, torn tails, bad magic — rather than DSH's.
 * A DSH-side change instead surfaces as a decoding refusal from decodeHeader.
 */
function assertFrameScannerContract() {
  const frame = (text) => zstdCompressSync(Buffer.from(text, 'utf8'), DSH_FRAME_OPTIONS);
  const parts = [frame('{"type":"session"}\n'), frame('{"a":1}\n'), frame('{"a":2}\n')];
  const stream = Buffer.concat(parts);

  const whole = scanFrames(stream);
  if (whole.tornStart !== undefined || whole.frames.length !== parts.length) {
    throw new Error('frame scanner drift: concatenated frames are no longer split correctly');
  }
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    if (whole.frames[index].start !== offset || whole.frames[index].end !== offset + part.length) {
      throw new Error(`frame scanner drift: frame ${index} boundary is wrong`);
    }
    offset += part.length;
  }

  const torn = scanFrames(stream.subarray(0, stream.length - 5));
  if (torn.frames.length !== 2 || torn.tornStart !== parts[0].length + parts[1].length) {
    throw new Error('frame scanner drift: a torn trailing frame is no longer detected');
  }

  let rejected = false;
  try {
    scanFrames(Buffer.concat([Buffer.from([0, 0, 0, 0]), parts[0]]));
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('frame scanner drift: bad frame magic is no longer rejected');
}

/* ------------------------------------------------------------------ *
 * sessions-root layout (mirrors DSH's projection of cwd -> directory)
 * ------------------------------------------------------------------ */

/**
 * Encode a filesystem-safe project directory name for a project path.
 * Byte-for-byte equivalent to DSH's `projectKey`, so we can assert that the
 * directory a session currently lives in really is the one its cwd names.
 *
 * @param {string} cwd - absolute project directory.
 * @returns {string} e.g. "/Calycopis" -> "--Calycopis--".
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * `projectKey` golden values, captured by running DSH's own implementation
 * (`@deepseek-ai/dsh-session-persistence-jsonl`, which does not export it).
 * They are the contract this copy is held to: if the encoding ever drifts,
 * sessions get filed under the wrong project directory.
 */
const PROJECT_KEY_GOLDEN = [
  ['/Calycopis', '--Calycopis--'],
  [
    '/Calycopis/Calycopis-broker/Calycopis-broker-uksrc-zrq',
    '--Calycopis-Calycopis-broker-Calycopis-broker-uksrc-zrq--',
  ],
  ['/Zarquan/lithosia-quadra', '--Zarquan-lithosia-quadra--'],
  ['/', '--root--'],
  ['/trailing/slash/', '--trailing-slash---'],
  ['/a b', '--a~0020b--'],
  ['C:\\Users\\x', '--C-Users-x--'],
  ['/Calycopis/\u65e5\u672c\u8a9e', '--Calycopis-~65E5~672C~8A9E--'],
  ['/sess~tilde', '--sess~007Etilde--'],
];

/** Fail loudly if this copy of `projectKey` no longer matches DSH's. */
function assertProjectKeyContract() {
  for (const [path, expected] of PROJECT_KEY_GOLDEN) {
    const actual = projectKey(path);
    if (actual !== expected) {
      throw new Error(
        `projectKey drift: '${path}' encodes to '${actual}' but DSH produces '${expected}'`,
      );
    }
  }
  if (projectKey(`/${'x'.repeat(300)}`) !== `--${'x'.repeat(251)}--`) {
    throw new Error('projectKey drift: over-long paths no longer truncate to 251 characters');
  }
}

/** Canonical generation filename -> format version (`session.jsonl` is v0). */
function versionOf(filename) {
  const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(filename);
  if (match === null) return undefined;
  return match[1] === undefined ? 0 : Number(match[1]);
}

/* ------------------------------------------------------------------ *
 * artifact read / rewrite
 * ------------------------------------------------------------------ */

/**
 * Decode exactly the first frame and require it to be one header line.
 * @param {Buffer} bytes - artifact bytes.
 * @param {boolean} plain - true for uncompressed `.jsonl`.
 * @returns {{header: object, headerEnd: number}} parsed header and byte offset.
 */
function decodeHeader(bytes, plain) {
  let first;
  let headerEnd;
  if (plain) {
    const nl = bytes.indexOf(NEWLINE);
    if (nl === -1) throw new Error('empty or header-less session log');
    first = bytes.subarray(0, nl + 1);
    headerEnd = nl + 1;
  } else {
    const { frames } = scanFrames(bytes);
    if (frames.length === 0) throw new Error('empty or header-less Zstandard session log');
    first = zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end));
    headerEnd = frames[0].end;
    if (first.length === 0 || first.indexOf(NEWLINE) !== first.length - 1) {
      throw new Error('corrupt Zstandard session log: first frame is not exactly one header line');
    }
  }
  const header = JSON.parse(first.subarray(0, first.length - 1).toString('utf8'));
  if (header.type !== 'session') throw new Error('first record is not a session header');
  return { header, headerEnd };
}

/** Read just the header of one stored generation. */
function readHeader(file) {
  const plain = file.endsWith('.jsonl');
  const bytes = readFileSync(file);
  return decodeHeader(bytes, plain).header;
}

/**
 * Rewrite the header's `cwd` while preserving every later byte of the log.
 *
 * Frame 0 is rebuilt from the new header line; all following frames (and any
 * torn trailing frame) are copied verbatim. Key order of the header object is
 * preserved because JSON.parse/stringify keep insertion order for these keys.
 *
 * @returns {{changed: boolean, header: object, bytesBefore: number, bytesAfter: number}}
 */
function rewriteHeaderCwd(file, targetCwd) {
  const plain = file.endsWith('.jsonl');
  const bytes = readFileSync(file);
  const { header, headerEnd } = decodeHeader(bytes, plain);
  if (typeof header.id !== 'string') throw new Error(`${file}: header has no id`);

  const originalLines = countLines(bytes, plain);

  if (header.cwd === targetCwd) {
    return { changed: false, header, bytesBefore: bytes.length, bytesAfter: bytes.length };
  }
  header.cwd = targetCwd;
  const line = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8');

  let out;
  if (plain) {
    out = Buffer.concat([line, bytes.subarray(headerEnd)]);
  } else {
    const newFrame = zstdCompressSync(line, DSH_FRAME_OPTIONS);
    const tail = bytes.subarray(headerEnd);
    out = Buffer.concat([newFrame, tail]);
    // The rewritten frame 0 must be the only byte-range difference; any torn
    // trailing frame is carried over untouched by the tail-identity check.
    const after = scanFrames(out);
    if (after.frames.length !== scanFrames(bytes).frames.length) {
      throw new Error(`${file}: frame count changed during rewrite`);
    }
    if (!out.subarray(newFrame.length).equals(tail)) {
      throw new Error(`${file}: post-rewrite tail differs from the original bytes`);
    }
  }

  // Verify before publishing: header decodes correctly and the record count is
  // unchanged (skipped when the artifact has a torn tail we cannot fully read).
  const check = decodeHeader(out, plain).header;
  if (check.cwd !== targetCwd || check.id !== header.id) {
    throw new Error(`${file}: post-rewrite header verification failed`);
  }
  const newLines = countLines(out, plain);
  if (originalLines !== null && newLines !== null && originalLines !== newLines) {
    throw new Error(
      `${file}: record count changed during rewrite (${originalLines} -> ${newLines})`,
    );
  }

  writeAtomic(file, out);
  return {
    changed: true,
    header: check,
    bytesBefore: bytes.length,
    bytesAfter: out.length,
  };
}

/**
 * Decode every complete frame and concatenate the plaintext.
 *
 * Node's one-shot `zstdDecompressSync` stops after the first frame of a
 * concatenated stream, so frames are decoded individually — the same strategy
 * as DSH's public-API fallback decoder.
 */
function decodeAllFrames(bytes) {
  const { frames } = scanFrames(bytes);
  const parts = [];
  for (const frame of frames) {
    parts.push(zstdDecompressSync(bytes.subarray(frame.start, frame.end)));
  }
  return Buffer.concat(parts);
}

/** Total newline count of the decoded complete-frame stream, or null when unreadable. */
function countLines(bytes, plain) {
  try {
    const decoded = plain ? bytes : decodeAllFrames(bytes);
    let count = 0;
    for (let i = 0; i < decoded.length; i += 1) if (decoded[i] === NEWLINE) count += 1;
    return count;
  } catch {
    return null;
  }
}

/** Durable replace: temp file + fsync + rename, mode 0600 like DSH artifacts. */
function writeAtomic(path, buf) {
  const tmp = `${path}.rebase-tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dirFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* directory fsync is best-effort */
  }
}

/* ------------------------------------------------------------------ *
 * discovery
 * ------------------------------------------------------------------ */

/** Every project directory currently under the sessions root. */
function listProjectDirs(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return [];
  return readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sessionsRoot, entry.name));
}

/**
 * Session ids are stored as `session-<uuid>`; accept the bare uuid too, so a
 * value taken from the GUI and one taken from a directory name both name the
 * same session. The prefix is stripped from BOTH sides, keeping it symmetric.
 *
 * @param {string} value - a stored id or a user-supplied one.
 * @returns {string} the id without its `session-` prefix.
 */
function normalizeSessionId(value) {
  return value.startsWith('session-') ? value.slice('session-'.length) : value;
}

/**
 * Build the migration plan: one entry per stored session whose header cwd is
 * not already the target. `only` (a list of session ids) narrows the plan to
 * just those sessions. Every session it excludes is reported back as
 * `unselected`, and an id that matches no stored session at all is surfaced as
 * `unknown`, so a typo can never silently migrate nothing.
 *
 * @returns {{plan: object[], skipped: object[], unselected: object[], unknown: string[]}}
 */
function buildPlan({ sessionsRoot, target, only = [], allowNewerFormat = false }) {
  const requested = only.length === 0 ? undefined : new Set(only.map(normalizeSessionId));
  const plan = [];
  const skipped = [];
  const unselected = [];
  const seen = new Set();
  for (const projectDir of listProjectDirs(sessionsRoot)) {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(projectDir, entry.name);
      const id = entry.name;
      seen.add(normalizeSessionId(id));
      const generations = readdirSync(dir)
        .filter((name) => versionOf(name) !== undefined)
        .map((name) => ({ name, version: versionOf(name) }));
      if (generations.length === 0) {
        skipped.push({ id, dir, reason: 'no session generation file', blocking: true });
        continue;
      }
      generations.sort((a, b) => b.version - a.version);
      const primary = join(dir, generations[0].name);
      let header;
      try {
        header = readHeader(primary);
      } catch (error) {
        skipped.push({ id, dir, reason: `unreadable header: ${error.message}`, blocking: true });
        continue;
      }
      if (typeof header.cwd !== 'string') {
        skipped.push({ id, dir, reason: 'header carries no cwd', blocking: true });
        continue;
      }
      if (
        !allowNewerFormat &&
        typeof header.version === 'number' &&
        header.version > VALIDATED_SESSION_VERSION
      ) {
        skipped.push({
          id,
          dir,
          reason:
            `session format v${header.version} is newer than the validated ` +
            `v${VALIDATED_SESSION_VERSION}`,
          blocking: true,
        });
        continue;
      }
      const expectedDirName = projectKey(header.cwd);
      const layoutMatches = basename(dirname(dir)) === expectedDirName;
      const entryPlan = {
        id,
        dir,
        currentProjectDirName: basename(dirname(dir)),
        headerCwd: header.cwd,
        createdAt: header.createdAt,
        primaryGeneration: generations[0].name,
        generations: generations.map((g) => g.name),
        layoutMatches,
      };
      if (header.cwd === target) {
        // Benign: the session is already where it belongs, so it never blocks.
        skipped.push({ ...entryPlan, reason: 'already on target workspace', blocking: false });
        continue;
      }
      entryPlan.newDirName = projectKey(target);
      entryPlan.newDir = join(sessionsRoot, entryPlan.newDirName, id);
      if (requested !== undefined && !requested.has(normalizeSessionId(id))) {
        unselected.push(entryPlan);
        continue;
      }
      plan.push(entryPlan);
    }
  }
  const newestFirst = (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0);
  plan.sort(newestFirst);
  unselected.sort(newestFirst);
  const unknown =
    requested === undefined ? [] : only.filter((value) => !seen.has(normalizeSessionId(value)));
  return { plan, skipped, unselected, unknown };
}

/* ------------------------------------------------------------------ *
 * registry + cache edits
 * ------------------------------------------------------------------ */

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomic(path, value) {
  writeAtomic(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

/** ISO-8601 timestamp in the same shape DSH stamps `updatedAt`. */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Move every migrated session into the target workspace's ordered account and
 * drop the emptied descendant projects.
 */
function rewriteWorkspaceRegistry({
  workspaceJsonPath,
  target,
  migratedIds,
  createdAtById,
  keepProjects,
}) {
  const doc = readJson(workspaceJsonPath);
  const workspaces = doc?.tables?.workspaces;
  const state = doc?.global;
  if (workspaces === undefined || state === undefined) {
    throw new Error(`${workspaceJsonPath}: unexpected workspace registry shape`);
  }
  const targetId = Object.keys(workspaces).find((id) => workspaces[id].path === target);
  if (targetId === undefined) {
    // DSH stores canonical workspace paths, so a miss here can mean the
    // registry holds a non-canonical spelling. Point that out rather than
    // leaving the caller to guess why an existing directory is unregistered.
    const aliases = Object.values(workspaces)
      .map((record) => record.path)
      .filter((path) => {
        try {
          return realpathSync(path) === target;
        } catch {
          return false;
        }
      });
    throw new Error(
      `${workspaceJsonPath}: no workspace record for '${target}'` +
        (aliases.length > 0
          ? `\n  note: record path(s) ${aliases
              .map((path) => `'${path}'`)
              .join(', ')} resolve to the target; DSH stores canonical workspace paths, ` +
            'so repair that record before migrating'
          : ''),
    );
  }

  const moved = new Set(migratedIds);
  const targetRecord = workspaces[targetId];

  // The target keeps its existing accounts and gains every migrated session.
  // Order is the display order, so present it newest-first by header createdAt.
  const members = new Set([...targetRecord.sessionIds, ...migratedIds]);
  targetRecord.sessionIds = [...members].sort((left, right) => {
    const delta = (createdAtById.get(right) ?? 0) - (createdAtById.get(left) ?? 0);
    return delta !== 0 ? delta : left.localeCompare(right);
  });
  targetRecord.updatedAt = nowIso();

  const removedProjects = [];
  const emptiedProjects = [];
  for (const id of Object.keys(workspaces)) {
    if (id === targetId) continue;
    const record = workspaces[id];
    const before = record.sessionIds.length;
    record.sessionIds = record.sessionIds.filter((sessionId) => !moved.has(sessionId));
    if (record.sessionIds.length !== before) record.updatedAt = nowIso();
    if (record.sessionIds.length === 0 && record.path.startsWith(`${target}/`)) {
      if (keepProjects) {
        emptiedProjects.push({ id, path: record.path });
      } else {
        delete workspaces[id];
        removedProjects.push({ id, path: record.path });
      }
    }
  }

  state.workspaceIds = state.workspaceIds.filter((id) => workspaces[id] !== undefined);
  if (!state.workspaceIds.includes(targetId)) state.workspaceIds.unshift(targetId);

  assertRegistryConsistency(doc);
  writeJsonAtomic(workspaceJsonPath, doc);
  return { targetId, removedProjects, emptiedProjects, sessionIds: [...targetRecord.sessionIds] };
}

/** newest-first `createdAt` for every session physically stored in one project dir. */
function createdAtIndexFor(sessionsRoot, cwd) {
  const index = new Map();
  const projectDir = join(sessionsRoot, projectKey(cwd));
  if (!existsSync(projectDir)) return index;
  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectDir, entry.name);
    const generations = readdirSync(dir)
      .filter((name) => versionOf(name) !== undefined)
      .sort((a, b) => versionOf(b) - versionOf(a));
    if (generations.length === 0) continue;
    try {
      index.set(entry.name, readHeader(join(dir, generations[0])).createdAt);
    } catch {
      /* an unreadable generation simply loses its ordering hint */
    }
  }
  return index;
}

/** Fail before writing if the edited registry would be internally inconsistent. */
function assertRegistryConsistency(doc) {
  const workspaces = doc.tables.workspaces;
  const order = doc.global.workspaceIds;
  const owner = new Map();
  for (const [id, record] of Object.entries(workspaces)) {
    for (const field of ['path', 'title', 'createdAt', 'updatedAt']) {
      if (typeof record[field] !== 'string' || record[field] === '') {
        throw new Error(`workspace '${id}' has an invalid ${field}`);
      }
    }
    if (!Array.isArray(record.sessionIds)) throw new Error(`workspace '${id}' sessionIds is not an array`);
    if (new Set(record.sessionIds).size !== record.sessionIds.length) {
      throw new Error(`workspace '${id}' contains duplicate session accounts`);
    }
    for (const sessionId of record.sessionIds) {
      if (owner.has(sessionId)) {
        throw new Error(
          `session '${sessionId}' would be accounted by both '${owner.get(sessionId)}' and '${id}'`,
        );
      }
      owner.set(sessionId, id);
    }
  }
  if (new Set(order).size !== order.length) throw new Error('workspaceIds contains duplicates');
  for (const id of order) {
    if (workspaces[id] === undefined) throw new Error(`workspaceIds names missing record '${id}'`);
  }
  for (const id of Object.keys(workspaces)) {
    if (!order.includes(id)) throw new Error(`workspace record '${id}' is missing from workspaceIds`);
  }
}

/**
 * Repoint projection-cache identity cwd so cached titles/stats stay valid.
 *
 * The cache is derived data — a fold shortcut DSH rebuilds on a cold read, and
 * its own store discards a record whose version stamp it does not accept — so a
 * document in an unrecognised format is reported and left alone rather than
 * rewritten or treated as fatal.
 *
 * @returns {{updated: string[], skipped: string[]}} human-readable lines.
 */
function rewriteProjectionCaches({ dshHome, target, migratedIds }) {
  const updated = [];
  const skipped = [];
  const accepted = [PROJCACHE_DOMAIN.version, ...PROJCACHE_DOMAIN.compatible];
  const moved = new Set(migratedIds);

  const monolithic = join(dshHome, 'storages', 'session_projcache.json');
  if (existsSync(monolithic)) {
    const doc = readJson(monolithic);
    const unit = doc?.unit;
    if (unit?.name !== PROJCACHE_DOMAIN.name) {
      skipped.push(`${monolithic}: not a '${PROJCACHE_DOMAIN.name}' unit`);
    } else if (!accepted.includes(unit.version)) {
      skipped.push(`${monolithic}: format v${unit.version} outside v${accepted.join('/v')}`);
    } else {
      const sessions = doc?.tables?.sessions ?? {};
      let touched = 0;
      for (const [id, value] of Object.entries(sessions)) {
        if (!moved.has(id)) continue;
        if (value?.identity?.cwd === target) continue;
        value.identity = { ...(value.identity ?? {}), cwd: target };
        touched += 1;
      }
      if (touched > 0) {
        writeJsonAtomic(monolithic, doc);
        updated.push(`${monolithic} (${touched})`);
      }
    }
  }

  const rowsDir = join(dshHome, 'storages', 'session_projcache', 'sessions');
  if (existsSync(rowsDir)) {
    let touched = 0;
    let refused = 0;
    const refusedVersions = new Set();
    for (const name of readdirSync(rowsDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!moved.has(id)) continue;
      const path = join(rowsDir, name);
      const doc = readJson(path);
      if (!accepted.includes(doc?.version)) {
        refused += 1;
        refusedVersions.add(doc?.version);
        continue;
      }
      if (doc?.record?.identity?.cwd === target) continue;
      doc.record = doc.record ?? {};
      doc.record.identity = { ...(doc.record.identity ?? {}), cwd: target };
      writeJsonAtomic(path, doc);
      touched += 1;
    }
    if (touched > 0) updated.push(`${rowsDir} (${touched})`);
    if (refused > 0) {
      skipped.push(
        `${rowsDir}: ${refused} row(s) at format ` +
          `${[...refusedVersions].map((v) => `v${v}`).join('/')} left untouched`,
      );
    }
  }
  return { updated, skipped };
}

/* ------------------------------------------------------------------ *
 * backup / restore
 * ------------------------------------------------------------------ */

const STORAGE_ARTIFACTS = ['workspace.json', 'session_projcache.json'];

function makeBackup({ dshHome, sessionsRoot, backupRoot, manifest }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(backupRoot, `session-rebase-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  cpSync(sessionsRoot, join(dir, 'sessions'), { recursive: true, preserveTimestamps: true });
  const storages = join(dir, 'storages');
  mkdirSync(storages, { recursive: true, mode: 0o700 });
  for (const name of STORAGE_ARTIFACTS) {
    const source = join(dshHome, 'storages', name);
    if (existsSync(source)) cpSync(source, join(storages, name), { preserveTimestamps: true });
  }
  const cacheRows = join(dshHome, 'storages', 'session_projcache');
  if (existsSync(cacheRows)) {
    cpSync(cacheRows, join(storages, 'session_projcache'), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

function restore({ backupDir, dshHome, sessionsRoot }) {
  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${backupDir}: not a rebase backup (no manifest.json)`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const restored = [];

  for (const entry of manifest.migrated ?? []) {
    const source = join(backupDir, 'sessions', entry.currentProjectDirName, entry.id);
    if (!existsSync(source)) throw new Error(`${source}: missing from backup`);
    if (existsSync(entry.newDir)) rmSync(entry.newDir, { recursive: true, force: true });
    mkdirSync(dirname(entry.dir), { recursive: true, mode: 0o700 });
    cpSync(source, entry.dir, { recursive: true, preserveTimestamps: true });
    restored.push(entry.id);
  }

  for (const name of STORAGE_ARTIFACTS) {
    const source = join(backupDir, 'storages', name);
    if (existsSync(source)) cpSync(source, join(dshHome, 'storages', name));
  }
  const cacheBackup = join(backupDir, 'storages', 'session_projcache');
  if (existsSync(cacheBackup)) {
    const destination = join(dshHome, 'storages', 'session_projcache');
    rmSync(destination, { recursive: true, force: true });
    cpSync(cacheBackup, destination, { recursive: true, preserveTimestamps: true });
  }
  return { restored, manifest };
}

/* ------------------------------------------------------------------ *
 * live-host detection
 * ------------------------------------------------------------------ */

/** Best-effort detection of a running DSH web host that would clobber edits. */
function findRunningHosts() {
  if (process.platform !== 'linux') return [];
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const hits = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    if (Number(entry) === process.pid) continue;
    let argv;
    try {
      argv = readFileSync(`/proc/${entry}/cmdline`).toString('utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (argv.length === 0) continue;
    const program = argv[0];
    const script = argv[1] ?? '';
    const isDsh =
      /(^|\/)dsh$/.test(program) || (/node$/.test(program) && /(^|\/)dsh$/.test(script));
    if (!isDsh) continue;
    const args = argv.slice(1);
    if (args.includes('web') || argv.join(' ').includes('--profile web')) {
      hits.push({ pid: Number(entry), command: argv.join(' ') });
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * prerun checks
 * ------------------------------------------------------------------ */

function assertRealDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  if (!statSync(path).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

/**
 * Canonicalize the target the way DSH stores a workspace path
 * (`realpathNormalize` in `@deepseek-ai/dsh-workspace`): trailing slashes, `..`
 * segments and symlinks all resolved. The header cwd written here is later
 * realpath'd by DSH and compared against the registry record, and the registry
 * lookup in this script is a literal string compare, so both sides must be
 * canonical.
 *
 * Only the target needs this. DSH resolves its own home from DSH_HOME with
 * `resolve`, not `realpath`, so the sessions root and storages stay as given.
 *
 * @param {string} path - target workspace directory, already known to exist.
 * @returns {string} the canonical absolute path.
 */
function canonicalizeTarget(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new Error(`cannot canonicalize target workspace '${path}': ${error.message}`);
  }
}

/**
 * Read-only compatibility check, run before anything is written.
 *
 * The workspace registry is pinned hard: DSH opens it as a whole-unit document
 * and its storage layer rejects a version it does not expect, so writing the
 * wrong shape there would leave the harness unable to open its own registry.
 * The derived projection cache is deliberately not pinned here — it is a fold
 * shortcut that DSH rebuilds, and `rewriteProjectionCaches` skips rather than
 * rewrites any document whose version it does not recognise.
 *
 * The two self-tests pin behaviour DSH does not export (`projectKey` and the
 * frame scanner), so an accidental change to this script's copies fails here
 * instead of mis-filing sessions or corrupting logs.
 */
function assertKnownFormats({ workspaceJsonPath }) {
  assertProjectKeyContract();
  assertFrameScannerContract();

  const doc = readJson(workspaceJsonPath);
  const unit = doc?.unit;
  if (unit?.name !== WORKSPACE_DOMAIN.name) {
    throw new Error(
      `${workspaceJsonPath}: expected a '${WORKSPACE_DOMAIN.name}' unit, found '${unit?.name}'`,
    );
  }
  if (unit.version !== WORKSPACE_DOMAIN.version) {
    throw new Error(
      `${workspaceJsonPath}: stored format v${unit.version}, expected v${WORKSPACE_DOMAIN.version}; ` +
        'the workspace registry schema changed, so this script needs updating before it can migrate',
    );
  }
  if (doc?.global === undefined || doc?.tables?.workspaces === undefined) {
    throw new Error(`${workspaceJsonPath}: unexpected workspace registry shape`);
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/** Expand `~`, `~/` and `~\` against the operating-system home, exactly as DSH does. */
function expandHomePath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the DeepSeek Harness home with DSH's own precedence: `$DSH_HOME`
 * when it is set to a non-blank value, otherwise `~/.dsh`. Kept in step with
 * `resolveDshHome` in `@deepseek-ai/dsh-home-paths`, which is what the shipped
 * profile's `dshHomePath('sessions')` uses to place the sessions root.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {string} absolute harness home.
 */
function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME;
  const fromEnv = configured !== undefined && configured.trim().length > 0;
  return resolve(expandHomePath(fromEnv ? configured : join(homedir(), '.dsh')));
}

/** Read the value following a flag, failing loudly when it is missing. */
function flagValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const dshHome = resolveDshHome();
  const options = {
    target: '/Calycopis',
    dshHome,
    sessionsRoot: join(dshHome, 'sessions'),
    backupRoot: join(dshHome, 'backups'),
    dryRun: false,
    apply: false,
    yes: false,
    keepProjects: false,
    forceRunning: false,
    allowSkipped: false,
    allowNewerFormat: false,
    only: [],
    restore: undefined,
  };
  let sessionsRootGiven = false;
  let backupRootGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run': options.dryRun = true; break;
      case '--apply': options.apply = true; break;
      case '--yes': case '-y': options.yes = true; break;
      case '--keep-projects': options.keepProjects = true; break;
      case '--force-running': options.forceRunning = true; break;
      case '--allow-skipped': options.allowSkipped = true; break;
      case '--allow-newer-format': options.allowNewerFormat = true; break;
      case '--only': options.only.push(flagValue(argv, ++i, arg)); break;
      case '--target': options.target = flagValue(argv, ++i, arg); break;
      case '--sessions-root':
        options.sessionsRoot = flagValue(argv, ++i, arg);
        sessionsRootGiven = true;
        break;
      case '--dsh-home': options.dshHome = flagValue(argv, ++i, arg); break;
      case '--backup-root':
        options.backupRoot = flagValue(argv, ++i, arg);
        backupRootGiven = true;
        break;
      case '--restore': options.restore = flagValue(argv, ++i, arg); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  // The harness home anchors the other two: naming --dsh-home relocates the
  // default sessions and backup roots beneath it unless they are named too.
  options.dshHome = resolve(expandHomePath(options.dshHome));
  options.target = resolve(expandHomePath(options.target));
  options.sessionsRoot = sessionsRootGiven
    ? resolve(expandHomePath(options.sessionsRoot))
    : join(options.dshHome, 'sessions');
  options.backupRoot = backupRootGiven
    ? resolve(expandHomePath(options.backupRoot))
    : join(options.dshHome, 'backups');
  if (options.restore !== undefined) options.restore = resolve(expandHomePath(options.restore));
  return options;
}

const USAGE = `Rebase DSH sessions onto a top-level workspace directory.

  node migrate-sessions-to-top-level.mjs --dry-run
  node migrate-sessions-to-top-level.mjs --apply --yes
  node migrate-sessions-to-top-level.mjs --restore <backup-dir> --yes
  node migrate-sessions-to-top-level.mjs --dry-run --only session-<uuid>

Options:
  --dry-run            Report the plan without writing anything (safe while DSH runs).
  --apply              Perform the migration (requires the DSH host to be stopped).
  --yes                Required for --apply and --restore: confirm the operation.
  --restore <dir>      Undo a previous run from its backup directory.
  --target <path>      Target workspace directory (default: /Calycopis).
  --sessions-root <p>  Sessions root (default: $DSH_HOME/sessions).
  --dsh-home <path>    DSH home holding storages (default: $DSH_HOME, or ~/.dsh).
  --backup-root <p>    Where backups are written (default: $DSH_HOME/backups).
  --only <session-id>  Migrate only the named session(s). Repeatable. Accepts
                       'session-<uuid>' or the bare uuid. Every other session is
                       left untouched and reported as "Not selected".
  --keep-projects      Leave emptied descendant workspaces registered instead of removing them.
  --allow-skipped      Migrate even when a stored session cannot be read; such
                       sessions are left behind.
  --allow-newer-format Migrate sessions whose log format is newer than the
                       validated v4 header layout.
  --force-running      Proceed even though a DSH host appears to be running (unsafe).

The harness home is read from DSH_HOME (falling back to ~/.dsh, as DSH itself
resolves it). Naming --dsh-home also relocates the default --sessions-root and
--backup-root beneath it, unless those are named too.

Before writing anything the script checks that the on-disk formats are the ones
it understands: an unexpected workspace registry version aborts, while an
unrecognised projection-cache format is reported and skipped, since DSH
rebuilds that cache.
`;

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (options.restore !== undefined) {
    if (!options.yes) {
      process.stderr.write('refusing to restore without --yes (it overwrites live session logs)\n');
      process.exitCode = 2;
      return;
    }
    assertRealDirectory(options.sessionsRoot, 'sessions root');
    const running = findRunningHosts();
    if (running.length > 0 && !options.forceRunning) {
      process.stderr.write(
        `refusing to restore: a DSH host is running:\n${running
          .map((hit) => `  pid ${hit.pid}: ${hit.command}`)
          .join('\n')}\nStop it first, or pass --force-running.\n`,
      );
      process.exitCode = 1;
      return;
    }
    const result = restore({
      backupDir: options.restore,
      dshHome: options.dshHome,
      sessionsRoot: options.sessionsRoot,
    });
    process.stdout.write(
      `Restored ${result.restored.length} session(s) and the storage artifacts from ${options.restore}.\n`,
    );
    return;
  }

  if (options.dryRun === options.apply) {
    process.stderr.write(`choose exactly one of --dry-run or --apply\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (options.apply && !options.yes) {
    process.stderr.write('refusing to migrate without --yes (pass --yes to confirm)\n');
    process.exitCode = 2;
    return;
  }

  // Fail fast: a live host caches the registry in memory and rewrites
  // workspace.json on its next mutation, which would clobber these edits.
  if (options.apply && !options.forceRunning) {
    const running = findRunningHosts();
    if (running.length > 0) {
      process.stderr.write(
        `refusing to migrate: a DSH host is running and would overwrite workspace.json:\n${running
          .map((hit) => `  pid ${hit.pid}: ${hit.command}`)
          .join('\n')}\nStop it first, or re-run with --force-running (unsafe).\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  assertRealDirectory(options.target, 'target workspace');
  assertRealDirectory(options.sessionsRoot, 'sessions root');

  // The registry stores canonical paths, so migrate toward the canonical
  // spelling even when the caller named a symlink, a trailing slash or `..`.
  const typedTarget = options.target;
  options.target = canonicalizeTarget(options.target);

  const workspaceJsonPath = join(options.dshHome, 'storages', 'workspace.json');
  if (!existsSync(workspaceJsonPath)) throw new Error(`workspace registry not found: ${workspaceJsonPath}`);

  // Fail before any mutation, including before the backup: a format this
  // script does not understand must be refused while the tree is still intact.
  assertKnownFormats({ workspaceJsonPath });

  const { plan, skipped, unselected, unknown } = buildPlan({
    sessionsRoot: options.sessionsRoot,
    target: options.target,
    only: options.only,
    allowNewerFormat: options.allowNewerFormat,
  });

  // A named session that matches nothing is a typo, not an empty migration:
  // fail before touching anything, backup included.
  if (unknown.length > 0) {
    process.stderr.write(
      `--only names ${unknown.length} session(s) not found under ${options.sessionsRoot}:\n` +
        `${unknown.map((id) => `  ${id}\n`).join('')}` +
        'Check the id, or run without --only to see every session.\n',
    );
    process.exitCode = 2;
    return;
  }

  process.stdout.write(
    `Target workspace : ${options.target}${
      options.target === typedTarget ? '' : ` (canonicalized from '${typedTarget}')`
    }\n`,
  );
  process.stdout.write(`Sessions root    : ${options.sessionsRoot}\n`);
  if (options.only.length > 0) {
    process.stdout.write(`Only             : ${options.only.join(', ')}\n`);
  }
  process.stdout.write(`Sessions to move : ${plan.length}\n`);
  for (const entry of plan) {
    process.stdout.write(
      `  ${entry.id}\n      ${entry.currentProjectDirName}/${entry.id}\n   -> ${entry.newDirName}/${entry.id}\n`,
    );
    if (!entry.layoutMatches) {
      process.stdout.write(
        `      note: header cwd '${entry.headerCwd}' implies project dir '${projectKey(
          entry.headerCwd,
        )}'; stored elsewhere\n`,
      );
    }
  }
  if (unselected.length > 0) {
    process.stdout.write(`Not selected     : ${unselected.length} (excluded by --only)\n`);
    for (const entry of unselected) process.stdout.write(`  ${entry.id}\n`);
  }
  if (skipped.length > 0) {
    process.stdout.write(`Skipped          : ${skipped.length}\n`);
    for (const entry of skipped) process.stdout.write(`  ${entry.id}: ${entry.reason}\n`);
  }

  // A stored session that cannot be read would be left behind, so refuse by
  // default: a partially migrated history is worse than none. `--only` narrows
  // the check to the sessions actually requested, and `--allow-skipped` is the
  // explicit escape hatch. Dry runs report the same refusal so a preview
  // predicts what an apply would do.
  const requestedIds = new Set(options.only.map(normalizeSessionId));
  const blocking = skipped.filter(
    (entry) =>
      entry.blocking === true &&
      (requestedIds.size === 0 || requestedIds.has(normalizeSessionId(entry.id))),
  );
  if (blocking.length > 0 && !options.allowSkipped) {
    process.stderr.write(
      `${
        options.dryRun ? 'dry run: would refuse to migrate' : 'refusing to migrate'
      }: ${blocking.length} stored session(s) cannot be read:\n` +
        blocking.map((entry) => `  ${entry.id}: ${entry.reason}\n`).join('') +
        'They would be left behind. Fix them, name the sessions you want with --only,\n' +
        'or pass --allow-skipped to migrate the rest anyway.\n',
    );
    process.exitCode = 2;
    return;
  }

  if (options.dryRun) {
    process.stdout.write('\nDry run: nothing was written.\n');
    return;
  }

  if (plan.length === 0) {
    process.stdout.write(
      options.only.length > 0
        ? 'Nothing to do: none of the sessions named by --only still need migrating (see Skipped above).\n'
        : 'Nothing to do: every session already targets the workspace.\n',
    );
    return;
  }

  const manifest = {
    createdAt: nowIso(),
    target: options.target,
    sessionsRoot: options.sessionsRoot,
    dshHome: options.dshHome,
    migrated: plan.map((entry) => ({
      id: entry.id,
      dir: entry.dir,
      currentProjectDirName: entry.currentProjectDirName,
      newDir: entry.newDir,
      newDirName: entry.newDirName,
      headerCwd: entry.headerCwd,
      generations: entry.generations,
    })),
  };
  const backupDir = makeBackup({
    dshHome: options.dshHome,
    sessionsRoot: options.sessionsRoot,
    backupRoot: options.backupRoot,
    manifest,
  });
  process.stdout.write(`\nBackup written to ${backupDir}\n`);

  mkdirSync(join(options.sessionsRoot, projectKey(options.target)), { recursive: true, mode: 0o700 });

  const migratedIds = [];
  for (const entry of plan) {
    for (const generation of entry.generations) {
      const file = join(entry.dir, generation);
      const result = rewriteHeaderCwd(file, options.target);
      process.stdout.write(
        `${result.changed ? 'rewrote' : 'kept   '} ${entry.id}/${generation}\n`,
      );
    }
    if (resolve(entry.dir) !== resolve(entry.newDir)) {
      if (existsSync(entry.newDir)) {
        throw new Error(`${entry.newDir}: destination already exists; aborting before any move`);
      }
      mkdirSync(dirname(entry.newDir), { recursive: true, mode: 0o700 });
      renameSync(entry.dir, entry.newDir);
      process.stdout.write(`moved   ${entry.id} -> ${entry.newDir}\n`);
    }
    migratedIds.push(entry.id);
  }

  const registry = rewriteWorkspaceRegistry({
    workspaceJsonPath,
    target: options.target,
    migratedIds,
    createdAtById: createdAtIndexFor(options.sessionsRoot, options.target),
    keepProjects: options.keepProjects,
  });
  process.stdout.write(
    `workspace.json: ${migratedIds.length} session(s) now accounted by '${registry.targetId}'; ` +
      `${registry.sessionIds.length} total\n`,
  );
  for (const removed of registry.removedProjects) {
    process.stdout.write(`workspace.json: removed emptied project '${removed.path}'\n`);
  }
  for (const emptied of registry.emptiedProjects) {
    process.stdout.write(`workspace.json: kept emptied project '${emptied.path}'\n`);
  }

  const caches = rewriteProjectionCaches({
    dshHome: options.dshHome,
    target: options.target,
    migratedIds,
  });
  for (const line of caches.updated) process.stdout.write(`projcache: updated ${line}\n`);
  for (const line of caches.skipped) {
    process.stdout.write(`projcache: skipped ${line} (DSH rebuilds this cache)\n`);
  }

  // Remove only the project directories this run actually vacated. Scanning
  // the root for empty directories instead would delete unrelated ones —
  // `_no-cwd`, a project whose sessions were archived earlier, or a directory
  // holding only non-generation artifacts.
  if (!options.keepProjects) {
    const vacated = new Set(
      manifest.migrated
        .filter((entry) => entry.currentProjectDirName !== entry.newDirName)
        .map((entry) => entry.currentProjectDirName),
    );
    for (const name of vacated) {
      const projectDir = join(options.sessionsRoot, name);
      if (!existsSync(projectDir)) continue;
      if (readdirSync(projectDir).length > 0) continue; // another session still lives here
      rmSync(projectDir, { recursive: true, force: true });
      process.stdout.write(`removed vacated project directory ${projectDir}\n`);
    }
  }

  // Final verification straight off disk.
  const failures = [];
  for (const entry of manifest.migrated) {
    for (const generation of entry.generations) {
      const file = join(entry.newDir, generation);
      if (!existsSync(file)) {
        failures.push(`${entry.id}/${generation}: missing at new location`);
        continue;
      }
      const header = readHeader(file);
      if (header.cwd !== options.target) {
        failures.push(`${entry.id}/${generation}: header cwd is '${header.cwd}'`);
      }
    }
  }
  const check = JSON.parse(readFileSync(workspaceJsonPath, 'utf8'));
  const targetId = Object.keys(check.tables.workspaces).find(
    (id) => check.tables.workspaces[id].path === options.target,
  );
  const accounted = new Set(check.tables.workspaces[targetId].sessionIds);
  for (const id of migratedIds) if (!accounted.has(id)) failures.push(`${id}: not accounted by target`);

  if (failures.length > 0) {
    process.stderr.write(`\nVERIFICATION FAILED:\n${failures.map((f) => `  ${f}`).join('\n')}\n`);
    process.stderr.write(`Restore with: node ${basename(process.argv[1])} --restore ${backupDir} --yes\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `\nDone. ${migratedIds.length} session(s) rebased onto ${options.target}.\n` +
      `Restart the DSH host, then verify in the GUI.\n` +
      `Rollback: node ${basename(process.argv[1])} --restore ${backupDir} --yes\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`\nerror: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
