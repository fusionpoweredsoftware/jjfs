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

// Parse "wsName:/path" (or "wsName:/path:startLine:endLine" for JJFS_READ) from target.
export function parseTarget(target, forRead) {
  const firstColon = target.indexOf(':');
  if (firstColon === -1) return { error: 'Invalid target — expected format: wsName:/path' };
  const wsName = target.slice(0, firstColon);
  if (!wsName) return { error: 'Workspace name cannot be empty' };
  const rest = target.slice(firstColon + 1) || '/';
  if (forRead) {
    const m = rest.match(/^(.*):(\ d+):(\ d+)$/);
    if (m) return { wsName, filePath: m[1] || '/', startLine: parseInt(m[2]), endLine: parseInt(m[3]) };
  }
  return { wsName, filePath: rest };
}
