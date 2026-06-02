// ── JJFS Core ────────────────────────────────────────────────────────
// JavaScript Journaling File System — universal library.
// No imports. No Node.js. Works in any browser (ES modules) or in Node.js.
//
// All functions take a wsForKey object — a map of workspace names to their
// directory trees (e.g. { default: {}, myapp: { "src/": {...} } }).
// Mutating functions modify wsForKey in place and return { success, result }.
// Persistence (saving to disk, etc.) is the caller's responsibility.

// Navigate a workspace tree to { parent, name } for an arbitrary POSIX path.
// workspace: the workspace object itself (e.g. wsForKey['default'])
// pathStr:   POSIX path, leading slash optional — e.g. "/src/app.js" or "src/app.js"
export function jjfsNavigate(workspace, pathStr) {
  const parts = (pathStr || '').replace(/^\//, '').split('/').filter(Boolean);
  if (parts.length === 0) return { error: 'Path refers to the workspace root' };
  let node = workspace;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof node[part] !== 'object' || node[part] === null) {
      return { error: `Not a directory: /${parts.slice(0, i + 1).join('/')}` };
    }
    node = node[part];
  }
  return { parent: node, name: parts[parts.length - 1] };
}

// Parse "wsName:/path" from target. For JJFS_READ, an optional range suffix is
// also parsed:
//   :N      → from line N to end of file
//   :N:M    → lines N through M (1-indexed, inclusive)
//   :cN     → from character N to end of file
//   :cN:M   → characters [N, M) (0-indexed, half-open)
export function parseTarget(target, forRead) {
  const firstColon = target.indexOf(':');
  if (firstColon === -1) return { error: 'Invalid target — expected format: wsName:/path' };
  const wsName = target.slice(0, firstColon);
  if (!wsName) return { error: 'Workspace name cannot be empty' };
  const rest = target.slice(firstColon + 1) || '/';
  if (forRead) {
    const m = rest.match(/^(.*?):(c?)(\d+)(?::(\d+))?$/);
    if (m) {
      const filePath = m[1] || '/';
      const start = parseInt(m[3]);
      const end = m[4] !== undefined ? parseInt(m[4]) : undefined;
      if (m[2] === 'c') return { wsName, filePath, startChar: start, endChar: end };
      return { wsName, filePath, startLine: start, endLine: end };
    }
  }
  return { wsName, filePath: rest };
}

// Count all leaf files (strings) in a workspace tree.
export function countFiles(node) {
  if (typeof node === 'string') return 1;
  if (typeof node !== 'object' || node === null) return 0;
  return Object.values(node).reduce((sum, v) => sum + countFiles(v), 0);
}

// Read a file or list a directory.
// Optionally return only a slice of a file:
//   startLine/endLine — 1-indexed, inclusive. endLine omitted means "to end".
//   startChar/endChar — 0-indexed, half-open [startChar, endChar). endChar
//                       omitted means "to end". A character range takes
//                       precedence over a line range when both are given.
// Returns { success: true, result: string } or { success: false, result: errorMessage }.
export function jjfsRead(wsForKey, wsName, filePath, startLine, endLine, startChar, endChar) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };

  // Root listing
  const trimmed = (filePath || '').replace(/^\//, '');
  if (!trimmed) {
    const lines = Object.keys(ws).map(k => typeof ws[k] === 'object' ? k + '/' : k);
    return { success: true, result: lines.join('\n') || '(empty workspace)' };
  }

  const nav = jjfsNavigate(ws, filePath);
  if (nav.error) return { success: false, result: nav.error };
  const { parent, name } = nav;
  const node = parent[name];
  if (node === undefined) return { success: false, result: `Not found: ${filePath}` };

  if (typeof node === 'object' && node !== null) {
    // Directory listing — append '/' to subdirs for clarity
    const lines = Object.keys(node).map(k => typeof node[k] === 'object' ? k + '/' : k);
    return { success: true, result: lines.join('\n') || '(empty directory)' };
  }

  let content = String(node);
  if (startChar !== undefined) {
    const from = Math.max(0, startChar);
    const to = endChar !== undefined ? Math.min(content.length, endChar) : content.length;
    content = content.slice(from, Math.max(from, to));
  } else if (startLine !== undefined) {
    const allLines = content.split('\n');
    const from = Math.max(0, startLine - 1);
    const to = endLine !== undefined ? Math.min(allLines.length, endLine) : allLines.length;
    content = allLines.slice(from, Math.max(from, to)).join('\n');
  }
  return { success: true, result: content };
}

// Create or overwrite a file. Creates intermediate directories automatically.
//
// An optional `range` enables a partial write instead of a full overwrite,
// splicing `content` (a string) into the existing file:
//   { startLine, endLine } — replace lines startLine..endLine (1-indexed,
//                            inclusive) with content.
//   { startLine }          — insert content before line startLine.
//   { startChar, endChar } — replace characters [startChar, endChar) (0-indexed,
//                            half-open) with content.
//   { startChar }          — insert content at character offset startChar.
// A character range takes precedence over a line range when both are given.
// Ranged writes treat a missing file as empty, so an insert can create a file.
export function jjfsWrite(wsForKey, wsName, filePath, content, range) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };
  if (!filePath || filePath === '/') return { success: false, result: 'Cannot write to workspace root' };

  const parts = filePath.replace(/^\//, '').split('/').filter(Boolean);
  if (parts.length === 0) return { success: false, result: 'Invalid path' };

  // Walk path, creating intermediate directories as needed.
  let node = ws;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (node[part] === undefined) {
      node[part] = {};
    } else if (typeof node[part] !== 'object' || node[part] === null) {
      return { success: false, result: `Path conflict: /${parts.slice(0, i + 1).join('/')} is a file, not a directory` };
    }
    node = node[part];
  }

  const name = parts[parts.length - 1];
  if (typeof node[name] === 'object' && node[name] !== null && typeof content !== 'object') {
    return { success: false, result: `Path conflict: ${filePath} is a directory` };
  }

  // Partial (ranged) write — splice content into the existing file.
  const hasRange = range && (range.startLine !== undefined || range.startChar !== undefined);
  if (hasRange) {
    if (typeof content !== 'string') {
      return { success: false, result: 'Ranged write requires string content' };
    }
    const base = name in node ? String(node[name]) : '';
    let updated;
    if (range.startChar !== undefined) {
      if (range.startChar < 0 || (range.endChar !== undefined && range.endChar < range.startChar)) {
        return { success: false, result: `Invalid character range for: ${filePath}` };
      }
      const from = Math.min(range.startChar, base.length);
      const to = range.endChar !== undefined ? Math.min(range.endChar, base.length) : from;
      updated = base.slice(0, from) + content + base.slice(to);
    } else {
      if (range.startLine < 1 || (range.endLine !== undefined && range.endLine < range.startLine)) {
        return { success: false, result: `Invalid line range for: ${filePath}` };
      }
      const lines = base === '' ? [] : base.split('\n');
      const startIdx = range.startLine - 1;
      // Pad with empty lines so an insert/replace past EOF still lands cleanly.
      while (lines.length < startIdx) lines.push('');
      const deleteCount = range.endLine !== undefined ? (range.endLine - range.startLine + 1) : 0;
      lines.splice(startIdx, deleteCount, ...content.split('\n'));
      updated = lines.join('\n');
    }
    const existed = name in node;
    node[name] = updated;
    return { success: true, result: `${existed ? 'Updated' : 'Created'}: ${wsName}:${filePath}` };
  }

  const existed = name in node;
  node[name] = content;
  return { success: true, result: `${existed ? 'Overwrote' : 'Created'}: ${wsName}:${filePath}` };
}

// Surgical search-and-replace within a file. search must appear exactly once.
export function jjfsEdit(wsForKey, wsName, filePath, searchStr, replaceStr) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };

  const nav = jjfsNavigate(ws, filePath);
  if (nav.error) return { success: false, result: nav.error };
  const { parent, name } = nav;
  if (!(name in parent)) return { success: false, result: `Not found: ${filePath}` };
  if (typeof parent[name] !== 'string') return { success: false, result: `Not a file: ${filePath}` };

  const occurrences = parent[name].split(searchStr).length - 1;
  if (occurrences === 0) return { success: false, result: `Search text not found in: ${filePath}` };
  if (occurrences > 1) return { success: false, result: `Search text is not unique (${occurrences} matches) in: ${filePath}` };

  parent[name] = parent[name].replace(searchStr, replaceStr);
  return { success: true, result: `Edited: ${wsName}:${filePath}` };
}

// Remove a file or directory.
export function jjfsDelete(wsForKey, wsName, filePath) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };
  if (!filePath || filePath === '/') return { success: false, result: 'Cannot delete workspace root — use DELETE /api/fs/workspaces/:name' };

  const nav = jjfsNavigate(ws, filePath);
  if (nav.error) return { success: false, result: nav.error };
  const { parent, name } = nav;
  if (!(name in parent)) return { success: false, result: `Not found: ${filePath}` };
  delete parent[name];
  return { success: true, result: `Deleted: ${wsName}:${filePath}` };
}

// Move (relocate) a file or directory within a workspace.
export function jjfsMove(wsForKey, wsName, srcPath, destPath) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };

  const srcNav = jjfsNavigate(ws, srcPath);
  if (srcNav.error) return { success: false, result: srcNav.error };
  const { parent: srcParent, name: srcName } = srcNav;
  if (!(srcName in srcParent)) return { success: false, result: `Not found: ${srcPath}` };

  const payload = JSON.parse(JSON.stringify(srcParent[srcName]));
  const writeResult = jjfsWrite(wsForKey, wsName, destPath, payload);
  if (!writeResult.success) return writeResult;

  delete srcParent[srcName];
  return { success: true, result: `Moved: ${wsName}:${srcPath} → ${destPath}` };
}

// Duplicate a file or directory within a workspace.
export function jjfsCopy(wsForKey, wsName, srcPath, destPath) {
  const ws = wsForKey[wsName];
  if (!ws) return { success: false, result: `Workspace not found: ${wsName}` };

  const srcNav = jjfsNavigate(ws, srcPath);
  if (srcNav.error) return { success: false, result: srcNav.error };
  const { parent: srcParent, name: srcName } = srcNav;
  if (!(srcName in srcParent)) return { success: false, result: `Not found: ${srcPath}` };

  const payload = JSON.parse(JSON.stringify(srcParent[srcName]));
  return jjfsWrite(wsForKey, wsName, destPath, payload);
}

// ── JJFS File Permissions ─────────────────────────────────────────────
// All permission functions take fsPerms as their first parameter — a map of
// { email: { "wsName:/path": { mode, owner } } } — matching the wsForKey
// convention so this module remains universal (no globals, no Node.js deps).

export function normalizePath(p) {
  const parts = [];
  for (const seg of (p || '').replace(/^\//, '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export function isValidMode(mode) {
  if (mode === 'ro' || mode === 'rw') return true;
  if (typeof mode === 'string' && /^[0-7]{3,4}$/.test(mode)) return true;
  if (typeof mode === 'object' && mode !== null && !Array.isArray(mode))
    return Object.values(mode).every(v =>
      v === 'ro' || v === 'rw' || v === null || (typeof v === 'string' && /^[0-7]$/.test(v)));
  return false;
}

export function parseOctalBits(digit) {
  const n = parseInt(digit, 8);
  return { read: !!(n & 4), write: !!(n & 2), execute: !!(n & 1) };
}

export function getStickyBit(mode) {
  if (!mode || typeof mode !== 'string') return false;
  if (/^[0-7]{4}$/.test(mode)) return !!(parseInt(mode[0], 8) & 1);
  return false;
}

// Returns the most specific applicable permission entry for a path (searching
// from the given path up to the workspace root), or null if none found.
export function getEffectivePermission(fsPerms, email, wsName, filePath) {
  const permsForEmail = fsPerms[email] || {};
  const normalized = normalizePath(filePath);
  const parts = normalized.replace(/^\//, '').split('/').filter(Boolean);
  const pathsToCheck = [];
  let current = '';
  for (const part of parts) { current += '/' + part; pathsToCheck.push(current); }
  pathsToCheck.reverse();
  pathsToCheck.push('/');
  for (const p of pathsToCheck) {
    const key = `${wsName}:${p}`;
    if (permsForEmail[key]) return { ...permsForEmail[key], effectivePath: p, inherited: p !== normalized };
  }
  return null;
}

// Decode read/write/execute bits for a specific caller from a permission entry.
export function getPermBitsForKey(perm, callerId) {
  const m = perm?.mode;
  if (!m) return { read: true, write: true, execute: false };
  if (m === 'ro') return { read: true, write: false, execute: false };
  if (m === 'rw') return { read: true, write: true, execute: false };
  if (typeof m === 'object') {
    const val = m[callerId] ?? m['*'];
    if (val === null || val === undefined) return { read: true, write: true, execute: false };
    if (val === 'ro') return { read: true, write: false, execute: false };
    if (val === 'rw') return { read: true, write: true, execute: false };
    return parseOctalBits(String(val));
  }
  if (/^[0-7]{3,4}$/.test(m)) {
    const owners = perm?.owner ? (Array.isArray(perm.owner) ? perm.owner : [perm.owner]) : [];
    const isOwner = callerId && owners.includes(callerId);
    const userDigit  = m.length === 4 ? m[1] : m[0];
    const otherDigit = m.length === 4 ? m[3] : m[2];
    return parseOctalBits(isOwner ? userDigit : otherDigit);
  }
  return { read: true, write: true, execute: false };
}

// Returns { allowed: true } or { allowed: false, error }.
// Session auth (callerId = null) always passes.
export function checkWriteAccess(fsPerms, email, wsName, filePath, callerId) {
  if (!callerId) return { allowed: true };
  // The _system workspace is read-only for all callers except internal updates
  if (wsName === '_system' && callerId !== '__internal_system__') {
    return { allowed: false, error: `Permission denied: _system workspace is read-only` };
  }
  const perm = getEffectivePermission(fsPerms, email, wsName, filePath);
  const bits = getPermBitsForKey(perm, callerId);
  if (bits.write) return { allowed: true };
  const loc = perm?.inherited ? ` (inherited from ${wsName}:${perm.effectivePath})` : '';
  return { allowed: false, error: `Permission denied (no write): ${wsName}:${filePath}${loc}` };
}

export function checkReadAccess(fsPerms, email, wsName, filePath, callerId) {
  if (!callerId) return { allowed: true };
  const perm = getEffectivePermission(fsPerms, email, wsName, filePath);
  const bits = getPermBitsForKey(perm, callerId);
  if (bits.read) return { allowed: true };
  const loc = perm?.inherited ? ` (inherited from ${wsName}:${perm.effectivePath})` : '';
  return { allowed: false, error: `Permission denied (no read): ${wsName}:${filePath}${loc}` };
}

// Checks ownership at the EXACT path only (not inherited). Anyone can modify a
// path with no explicit owner; otherwise only a key listed as owner may.
export function checkOwnerAccess(fsPerms, email, wsName, filePath, callerId) {
  if (!callerId) return { allowed: true };
  const permsForEmail = fsPerms[email] || {};
  const normalized = normalizePath(filePath);
  const perm = permsForEmail[`${wsName}:${normalized}`];
  if (!perm || !perm.owner) return { allowed: true };
  const owners = Array.isArray(perm.owner) ? perm.owner : [perm.owner];
  if (owners.includes(callerId)) return { allowed: true };
  return { allowed: false, error: 'Only the owner can modify permissions for this path' };
}

// Sticky bit: when a directory has the sticky bit set (1xxx), only the file
// owner or directory owner may delete/rename files within it.
export function checkStickyBit(fsPerms, email, wsName, filePath, callerId) {
  if (!callerId) return { allowed: true };
  const parentPath = normalizePath(filePath + '/..');
  const parentKey = `${wsName}:${parentPath}`;
  const dirPerm = (fsPerms[email] || {})[parentKey];
  if (!dirPerm || !getStickyBit(dirPerm.mode)) return { allowed: true };
  const normalized = normalizePath(filePath);
  const filePerm = (fsPerms[email] || {})[`${wsName}:${normalized}`];
  const fileOwners = filePerm?.owner ? [].concat(filePerm.owner) : [];
  if (fileOwners.includes(callerId)) return { allowed: true };
  const dirOwners = dirPerm?.owner ? [].concat(dirPerm.owner) : [];
  if (dirOwners.includes(callerId)) return { allowed: true };
  return { allowed: false, error: `Permission denied: sticky bit set on ${wsName}:${parentPath}` };
}

// Upsert a permission entry. mode updates: string replaces entirely; object
// merges (null values remove individual keys). Removes the entry altogether
// when it becomes a no-op (no meaningful mode, no owner).
export function setPermission(fsPerms, email, wsName, filePath, updates) {
  if (!fsPerms[email]) fsPerms[email] = {};
  const normalized = normalizePath(filePath);
  const key = `${wsName}:${normalized}`;
  const existing = fsPerms[email][key] || {};

  let newMode = existing.mode;
  if (updates.mode !== undefined) {
    if (typeof updates.mode === 'string') {
      newMode = updates.mode;
    } else if (typeof updates.mode === 'object' && updates.mode !== null) {
      const base = typeof existing.mode === 'string' ? { '*': existing.mode }
                 : typeof existing.mode === 'object' ? { ...existing.mode } : {};
      for (const [k, v] of Object.entries(updates.mode)) {
        if (v === null) delete base[k]; else base[k] = v;
      }
      const keys = Object.keys(base);
      newMode = keys.length === 0 ? undefined
              : keys.length === 1 && base['*'] ? base['*']
              : base;
    }
  }

  const newOwner = updates.owner !== undefined ? updates.owner : existing.owner;
  const modeIsDefault = !newMode || newMode === 'rw' || newMode === '666' || newMode === '0666'
    || (typeof newMode === 'object' && Object.keys(newMode).length === 0);

  if (modeIsDefault && !newOwner) {
    delete fsPerms[email][key];
  } else {
    fsPerms[email][key] = {
      ...(modeIsDefault ? {} : { mode: newMode }),
      ...(newOwner ? { owner: newOwner } : {}),
    };
  }
}

// Remove all permission entries for a path and any paths under it (called on delete/move).
export function removePermissionsUnder(fsPerms, email, wsName, filePath) {
  if (!fsPerms[email]) return;
  const normalized = normalizePath(filePath);
  const prefix = `${wsName}:${normalized}`;
  for (const k of Object.keys(fsPerms[email])) {
    if (k === prefix || k.startsWith(prefix + '/')) delete fsPerms[email][k];
  }
}

// Set the mode (permissions) on a path. Returns { success, status, result }.
// Does NOT handle persistence — caller must save and update timestamps.
export function jjfsChmod(fsPerms, email, wsName, filePath, mode, callerId) {
  if (!isValidMode(mode))
    return { success: false, status: 400, result: 'chmod must be "ro", "rw", a 3- or 4-digit octal string ("644", "1755"), or an ACL object { key: "ro"|"rw"|"[0-7]", ... }' };
  const oc = checkOwnerAccess(fsPerms, email, wsName, filePath, callerId);
  if (!oc.allowed) return { success: false, status: 403, result: oc.error };
  setPermission(fsPerms, email, wsName, filePath, { mode });
  return { success: true, status: 200, result: `Mode set on ${wsName}:${filePath}` };
}

// Set the owner of a path. validOwners is the list of caller IDs permitted as
// owners; owner must be null or a caller ID (or array of them) from that list.
// Does NOT handle persistence — caller must save and update timestamps.
export function jjfsChown(fsPerms, email, wsName, filePath, owner, validOwners, callerId) {
  const newOwner = owner || null;
  if (newOwner !== null) {
    const ownerKeys = Array.isArray(newOwner) ? newOwner : [newOwner];
    const invalid = ownerKeys.filter(k => !validOwners.includes(k));
    if (invalid.length > 0) return { success: false, status: 400, result: 'chown owner must be in the list of valid owner IDs' };
  }
  const oc = checkOwnerAccess(fsPerms, email, wsName, filePath, callerId);
  if (!oc.allowed) return { success: false, status: 403, result: oc.error };
  setPermission(fsPerms, email, wsName, filePath, { owner: newOwner });
  return { success: true, status: 200, result: newOwner ? `Owner set: ${wsName}:${filePath}` : `Owner removed: ${wsName}:${filePath}` };
}

// ── JJFS Timestamps ───────────────────────────────────────────────────
// All timestamp functions take fsTimestamps as their first parameter — a map of
// { email: { "wsName:/path": { birthtime, mtime, ctime } } }.
// Timestamps are ISO-8601 strings. birthtime is set once on creation; mtime on
// content change; ctime on any metadata change (chmod, chown, rename, xattr).
// Persistence is the caller's responsibility.

// Update the given timestamp fields to now. fields: array of 'birthtime' | 'mtime' | 'ctime'.
export function touchTimestamps(fsTimestamps, email, wsName, filePath, fields) {
  if (!fsTimestamps[email]) fsTimestamps[email] = {};
  const key = `${wsName}:${normalizePath(filePath)}`;
  if (!fsTimestamps[email][key]) fsTimestamps[email][key] = {};
  const now = new Date().toISOString();
  for (const f of fields) fsTimestamps[email][key][f] = now;
}

// Return the timestamp object for a path, or null if none recorded.
export function getTimestamps(fsTimestamps, email, wsName, filePath) {
  return (fsTimestamps[email] || {})[`${wsName}:${normalizePath(filePath)}`] || null;
}

// Remove all timestamp entries for a path and any paths under it (called on delete/move).
export function removeTimestampsUnder(fsTimestamps, email, wsName, filePath) {
  if (!fsTimestamps[email]) return;
  const prefix = `${wsName}:${normalizePath(filePath)}`;
  for (const k of Object.keys(fsTimestamps[email])) {
    if (k === prefix || k.startsWith(prefix + '/')) delete fsTimestamps[email][k];
  }
}

// ── JJFS Symbolic Links ───────────────────────────────────────────────
// Symlinks are stored as metadata alongside the JJFS tree; the tree itself is
// not modified. The target is an absolute path within the same workspace.
// All symlink functions take fsSymlinks as their first parameter — a map of
// { email: { "wsName:/path": "/target/path" } }.

// Follow a symlink chain, returning { path } or { error } if the chain is broken
// or exceeds 8 hops (matching Linux MAXSYMLINKS default).
export function resolveSymlink(fsSymlinks, email, wsName, filePath, depth = 0) {
  if (depth > 8) return { error: 'Too many levels of symbolic links' };
  const normalized = normalizePath(filePath);
  const target = (fsSymlinks[email] || {})[`${wsName}:${normalized}`];
  if (!target) return { path: normalized };
  return resolveSymlink(fsSymlinks, email, wsName, normalizePath(target), depth + 1);
}

// Return a { name: "/target" } map of all symlinks whose source is a direct
// child of dirPath (i.e. one path segment below it, no deeper).
export function getSymlinksInDir(fsSymlinks, email, wsName, dirPath) {
  const normalized = normalizePath(dirPath);
  const base = normalized === '/' ? '' : normalized;
  const prefix = `${wsName}:${base}/`;
  const result = {};
  for (const [k, target] of Object.entries(fsSymlinks[email] || {})) {
    if (k.startsWith(prefix)) {
      const rest = k.slice(prefix.length);
      if (rest && !rest.includes('/')) result[rest] = target;
    }
  }
  return result;
}

// Remove all symlink entries for a path and any paths under it (called on delete/move).
export function removeSymlinksUnder(fsSymlinks, email, wsName, filePath) {
  if (!fsSymlinks[email]) return;
  const prefix = `${wsName}:${normalizePath(filePath)}`;
  for (const k of Object.keys(fsSymlinks[email])) {
    if (k === prefix || k.startsWith(prefix + '/')) delete fsSymlinks[email][k];
  }
}

// Create or remove a single symlink. Pass null/empty target to remove.
// Does NOT handle persistence — caller must save and update timestamps.
export function jjfsSetSymlink(fsSymlinks, email, wsName, filePath, target) {
  const key = `${wsName}:${normalizePath(filePath)}`;
  if (!target) {
    if (fsSymlinks[email]) delete fsSymlinks[email][key];
    return { success: true, result: `Symlink removed: ${wsName}:${filePath}` };
  }
  const targetPath = normalizePath(String(target));
  if (!fsSymlinks[email]) fsSymlinks[email] = {};
  fsSymlinks[email][key] = targetPath;
  return { success: true, result: `Symlink created: ${wsName}:${filePath} -> ${targetPath}` };
}

// ── JJFS Extended Attributes ──────────────────────────────────────────
// Extended attributes follow the Linux xattr namespace convention. Only
// "user.*" and "trusted.*" namespaces are supported. Values are strings.
// All xattr functions take fsXattrs as their first parameter — a map of
// { email: { "wsName:/path": { "user.key": "value", ... } } }.

// Valid xattr names: "user.<name>" or "trusted.<name>" with alphanumeric, '.', '_', '-'.
export const XATTR_NAME_RE = /^(user|trusted)\.[a-zA-Z0-9._-]+$/;

// Return the extended attribute map for a path, or {} if none recorded.
export function getXattrs(fsXattrs, email, wsName, filePath) {
  return (fsXattrs[email] || {})[`${wsName}:${normalizePath(filePath)}`] || {};
}

// Remove all xattr entries for a path and any paths under it (called on delete/move).
export function removeXattrsUnder(fsXattrs, email, wsName, filePath) {
  if (!fsXattrs[email]) return;
  const prefix = `${wsName}:${normalizePath(filePath)}`;
  for (const k of Object.keys(fsXattrs[email])) {
    if (k === prefix || k.startsWith(prefix + '/')) delete fsXattrs[email][k];
  }
}

// Apply an xattr operation { set?: { name: value }, remove?: string | string[] } to a path.
// Returns { success: false, status: 400, result } on invalid name, { success: true, status: 200 } otherwise.
// Does NOT handle persistence — caller must save and update timestamps.
export function jjfsSetXattr(fsXattrs, email, wsName, filePath, op) {
  const key = `${wsName}:${normalizePath(filePath)}`;
  if (!fsXattrs[email]) fsXattrs[email] = {};
  if (!fsXattrs[email][key]) fsXattrs[email][key] = {};
  if (op.set) {
    for (const [k, v] of Object.entries(op.set)) {
      if (!XATTR_NAME_RE.test(k))
        return { success: false, status: 400, result: `Invalid xattr name: "${k}". Must match user.* or trusted.*` };
      fsXattrs[email][key][k] = String(v);
    }
  }
  if (op.remove) {
    for (const k of [].concat(op.remove)) delete fsXattrs[email][key][k];
  }
  if (Object.keys(fsXattrs[email][key]).length === 0) delete fsXattrs[email][key];
  return { success: true, status: 200, result: `xattrs updated: ${wsName}:${filePath}` };
}

// ── JJFS Binary File Helpers ──────────────────────────────────────────
// Files are stored as strings, so binary data must be base64-encoded.
// These helpers handle the conversion automatically, working in both
// Node.js (via Buffer) and browsers (via btoa/atob + Uint8Array).

// Write binary data to a file. bytes may be a Uint8Array, Buffer, or any
// array-like of 0–255 integers. Stored as a plain base64 string.
export function jjfsWriteBinary(wsForKey, wsName, filePath, bytes) {
  if (typeof Buffer !== 'undefined') {
    return jjfsWrite(wsForKey, wsName, filePath, Buffer.from(bytes).toString('base64'));
  }
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return jjfsWrite(wsForKey, wsName, filePath, btoa(s));
}

// Read a binary file written with jjfsWriteBinary.
// Returns { success: true, result: Buffer (Node.js) | Uint8Array (browser) }.
export function jjfsReadBinary(wsForKey, wsName, filePath) {
  const r = jjfsRead(wsForKey, wsName, filePath);
  if (!r.success) return r;
  if (typeof Buffer !== 'undefined') {
    return { success: true, result: Buffer.from(r.result, 'base64') };
  }
  const s = atob(r.result);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return { success: true, result: arr };
}

// ── JJFS Permission Serialization ─────────────────────────────────────
// Convert a stored permission entry into a response-safe form by replacing raw
// owner/ACL keys with opaque tokens via hashFn. Pass (k => k) to skip hashing.
// hashFn: (rawKey: string) => string — e.g. SHA-256 hex of the key.
export function hashPermForResponse(perm, hashFn) {
  if (!perm) return null;
  const out = {};
  if (perm.mode !== undefined) {
    if (typeof perm.mode === 'object' && perm.mode !== null) {
      const hashed = {};
      for (const [k, v] of Object.entries(perm.mode)) {
        hashed[k === '*' ? '*' : hashFn(k)] = v;
      }
      out.mode = hashed;
    } else {
      out.mode = perm.mode;
    }
  }
  out.owner = perm.owner
    ? (Array.isArray(perm.owner) ? perm.owner.map(hashFn) : [hashFn(perm.owner)])
    : null;
  if (perm.effectivePath !== undefined) out.effectivePath = perm.effectivePath;
  if (perm.inherited !== undefined) out.inherited = perm.inherited;
  return out;
}
