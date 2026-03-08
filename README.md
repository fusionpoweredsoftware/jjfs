# JJFS — JavaScript Journaling File System

A universal, zero-dependency library for managing in-memory file system trees in JavaScript. Works in any browser (ES modules) or in Node.js without modification.

---

## Table of Contents

- [Overview](#overview)
- [Core Design](#core-design)
- [Data Structures](#data-structures)
- [API Reference](#api-reference)
  - [Internal Helpers](#internal-helpers)
  - [File Operations](#file-operations)
  - [Permissions](#permissions)
  - [Timestamps](#timestamps)
  - [Symbolic Links](#symbolic-links)
  - [Extended Attributes](#extended-attributes)
  - [Binary File Helpers](#binary-file-helpers)
  - [Permission Serialization](#permission-serialization)

---

## Overview

JJFS stores an entire file system as a plain JavaScript object (the **workspace tree**). Files are strings. Directories are nested objects. There are no imports, no Node.js APIs, and no native file I/O — persistence (writing to disk, a database, localStorage, etc.) is entirely the caller's responsibility.

Multiple named workspaces can exist side-by-side, organized inside a top-level map called `wsForKey`.

---

## Core Design

### How trees work

A workspace is a nested plain object where:

- **Files** are string values at any key.
- **Directories** are object values at any key.

```js
const wsForKey = {
  default: {
    "README.md": "# Hello",
    "src/": {
      "index.js": "console.log('hi')",
      "utils/": {
        "math.js": "export const add = (a, b) => a + b;"
      }
    }
  },
  sandbox: {}
};
```

### Path format

All paths are POSIX-style strings. A leading `/` is optional and is stripped internally. These are equivalent:

```
/src/index.js
src/index.js
```

### Target format

Several places accept a **target** string that encodes both a workspace name and a path in one string:

```
wsName:/path/to/file
```

For range reads, a target may also encode line boundaries:

```
wsName:/path/to/file:startLine:endLine
```

### Return shape

Every mutating function returns:

```js
{ success: boolean, result: string }
```

`success: true` means the operation completed. `success: false` means it failed; `result` contains the error message. Some permission-related functions also include a `status` (HTTP-style numeric code: `200`, `400`, `403`).

### No side effects beyond `wsForKey`

Functions that modify the tree (`jjfsWrite`, `jjfsEdit`, `jjfsDelete`, `jjfsMove`) mutate the `wsForKey` object **in place**. They do not persist anything, emit events, or touch any other state. The caller decides when and how to save.

---

## Data Structures

### `wsForKey`

```ts
{
  [workspaceName: string]: WorkspaceTree
}
```

A workspace tree is a plain object where string values are files and nested objects are directories.

### `fsPerms`

```ts
{
  [email: string]: {
    [target: string]: {   // target = "wsName:/path"
      mode?: string | object,
      owner?: string | string[]
    }
  }
}
```

Stores per-path permission entries keyed by user email, then by `wsName:/path`.

### `fsTimestamps`

```ts
{
  [email: string]: {
    [target: string]: {   // target = "wsName:/path"
      birthtime?: string,  // ISO-8601
      mtime?: string,      // ISO-8601
      ctime?: string       // ISO-8601
    }
  }
}
```

### `fsSymlinks`

```ts
{
  [email: string]: {
    [target: string]: string  // target = "wsName:/path", value = "/absolute/target"
  }
}
```

### `fsXattrs`

```ts
{
  [email: string]: {
    [target: string]: {   // target = "wsName:/path"
      [attrName: string]: string
    }
  }
}
```

---

## API Reference

---

### Internal Helpers

---

#### `jjfsNavigate(workspace, pathStr)`

Traverses a workspace tree along a POSIX path and returns the **parent node** and the **final segment name** so that the caller can read or modify the target entry.

**Parameters:**

| Parameter   | Type   | Description |
|-------------|--------|-------------|
| `workspace` | object | The workspace tree object (e.g. `wsForKey['default']`). |
| `pathStr`   | string | A POSIX path. Leading `/` is optional. Cannot be empty or refer to the root itself. |

**Returns:**

```js
{ parent: object, name: string }
// or
{ error: string }
```

- `parent` is the directory object that directly contains the target.
- `name` is the last path segment (the file or directory name).
- Returns `{ error }` if the path is root-only, or if any intermediate segment is not an object (i.e., is a file where a directory was expected).

**Example:**

```js
const ws = { src: { "index.js": "console.log(1)" } };
const { parent, name } = jjfsNavigate(ws, "/src/index.js");
// parent === ws.src, name === "index.js"
```

---

#### `parseTarget(target, forRead?)`

Splits a target string of the form `wsName:/path` (or `wsName:/path:startLine:endLine`) into its components.

**Parameters:**

| Parameter | Type    | Description |
|-----------|---------|-------------|
| `target`  | string  | The target string to parse. |
| `forRead` | boolean | When `true`, also attempts to parse an optional `:startLine:endLine` suffix. |

**Returns:**

```js
{ wsName: string, filePath: string }
// with forRead:
{ wsName: string, filePath: string, startLine: number, endLine: number }
// on failure:
{ error: string }
```

- Returns `{ error }` if there is no `:` separator or the workspace name is empty.
- Line numbers in the range form are parsed as integers.

**Examples:**

```js
parseTarget("default:/src/app.js");
// → { wsName: "default", filePath: "/src/app.js" }

parseTarget("default:/src/app.js:10:20", true);
// → { wsName: "default", filePath: "/src/app.js", startLine: 10, endLine: 20 }
```

---

#### `countFiles(node)`

Recursively counts the number of leaf files (string values) in a workspace subtree.

**Parameters:**

| Parameter | Type           | Description |
|-----------|----------------|-------------|
| `node`    | string\|object | A workspace tree, subtree, or file content string. |

**Returns:** `number` — the count of string leaves.

- A string node counts as 1.
- An object node counts as the sum of its children.
- Anything else (null, undefined, number) counts as 0.

**Example:**

```js
countFiles({ "a.js": "x", src: { "b.js": "y", "c.js": "z" } });
// → 3
```

---

### File Operations

---

#### `jjfsRead(wsForKey, wsName, filePath, startLine?, endLine?)`

Reads a file's content or lists a directory's entries.

**Parameters:**

| Parameter   | Type   | Description |
|-------------|--------|-------------|
| `wsForKey`  | object | The full workspace map. |
| `wsName`    | string | Name of the workspace to read from. |
| `filePath`  | string | Path to the file or directory. An empty string or `/` lists the workspace root. |
| `startLine` | number | (optional) 1-based start line for a partial read. Requires `endLine`. |
| `endLine`   | number | (optional) 1-based inclusive end line for a partial read. |

**Returns:** `{ success: boolean, result: string }`

**Behavior:**

- If `filePath` is empty or `/`, returns a newline-separated listing of the workspace root. Directory entries are shown with a trailing `/`.
- If `filePath` points to a directory, returns a listing of that directory's children (with trailing `/` on subdirectories).
- If `filePath` points to a file, returns the full file content as a string. If `startLine`/`endLine` are given, only those lines (1-based, inclusive) are returned. Line numbers are clamped to the actual file length.
- Returns `{ success: false }` if the workspace, path, or intermediate directory does not exist.

**Examples:**

```js
jjfsRead(wsForKey, "default", "/");
// → { success: true, result: "src/\nREADME.md" }

jjfsRead(wsForKey, "default", "/src/index.js");
// → { success: true, result: "console.log('hi')" }

jjfsRead(wsForKey, "default", "/src/index.js", 2, 5);
// → { success: true, result: "lines 2–5 of the file" }
```

---

#### `jjfsWrite(wsForKey, wsName, filePath, content)`

Creates or overwrites a file. Automatically creates any missing intermediate directories along the path.

**Parameters:**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `wsForKey` | object | The full workspace map. |
| `wsName`   | string | Name of the target workspace. |
| `filePath` | string | Absolute or relative path to the file. Cannot be `/` or empty. |
| `content`  | any    | The value to store. Typically a string for text files; can be any value (e.g. an object when cloning directories via `jjfsMove`/`jjfsCopy`). |

**Returns:** `{ success: boolean, result: string }`

- On success: `result` is `"Created: wsName:/path"` or `"Overwrote: wsName:/path"`.
- On failure: `result` describes the conflict or invalid input.

**Errors:**

| Condition | Error message |
|-----------|---------------|
| Workspace not found | `"Workspace not found: {wsName}"` |
| Path is `/` or empty | `"Cannot write to workspace root"` |
| An intermediate segment is a file, not a directory | `"Path conflict: /partial/path is a file, not a directory"` |
| Target path is an existing directory | `"Path conflict: {filePath} is a directory"` |

**Example:**

```js
jjfsWrite(wsForKey, "default", "/src/utils/math.js", "export const add = (a,b)=>a+b;");
// Creates wsForKey.default.src.utils["math.js"] = "..."
// Also creates intermediate objects if src/ or utils/ didn't exist.
```

---

#### `jjfsEdit(wsForKey, wsName, filePath, searchStr, replaceStr)`

Performs a surgical search-and-replace on a file. The search string must appear **exactly once** in the file; otherwise the operation is rejected.

**Parameters:**

| Parameter    | Type   | Description |
|--------------|--------|-------------|
| `wsForKey`   | object | The full workspace map. |
| `wsName`     | string | Name of the target workspace. |
| `filePath`   | string | Path to the file to edit. |
| `searchStr`  | string | The exact string to find. Must appear exactly once. |
| `replaceStr` | string | The string to substitute in place of `searchStr`. |

**Returns:** `{ success: boolean, result: string }`

**Errors:**

| Condition | Error message |
|-----------|---------------|
| Workspace not found | `"Workspace not found: {wsName}"` |
| Path navigation fails | Navigation error message |
| File not found | `"Not found: {filePath}"` |
| Target is a directory | `"Not a file: {filePath}"` |
| Search string not found | `"Search text not found in: {filePath}"` |
| Search string found more than once | `"Search text is not unique (N matches) in: {filePath}"` |

**Example:**

```js
jjfsEdit(wsForKey, "default", "/src/index.js", "console.log('hi')", "console.log('hello')");
```

The uniqueness requirement prevents accidental multi-site edits. If you need to replace all occurrences, call `jjfsEdit` repeatedly or use `jjfsWrite` for a full overwrite.

---

#### `jjfsDelete(wsForKey, wsName, filePath)`

Removes a file or an entire directory subtree from the workspace.

**Parameters:**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `wsForKey` | object | The full workspace map. |
| `wsName`   | string | Name of the target workspace. |
| `filePath` | string | Path to the file or directory to remove. Cannot be `/` or empty. |

**Returns:** `{ success: boolean, result: string }`

**Errors:**

| Condition | Error message |
|-----------|---------------|
| Workspace not found | `"Workspace not found: {wsName}"` |
| Path is `/` or empty | `"Cannot delete workspace root — use DELETE /api/fs/workspaces/:name"` |
| Path not found | `"Not found: {filePath}"` |

**Note:** Deleting a directory removes the entire subtree. Caller is responsible for also cleaning up associated permissions, timestamps, symlinks, and xattrs via `removePermissionsUnder`, `removeTimestampsUnder`, `removeSymlinksUnder`, and `removeXattrsUnder`.

---

#### `jjfsMove(wsForKey, wsName, srcPath, destPath)`

Moves (renames) a file or directory within the same workspace. The source is deep-cloned to the destination, then the source is removed.

**Parameters:**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `wsForKey` | object | The full workspace map. |
| `wsName`   | string | Name of the workspace containing both paths. |
| `srcPath`  | string | Source path. |
| `destPath` | string | Destination path. Intermediate directories are created as needed. |

**Returns:** `{ success: boolean, result: string }`

- On success: `result` is `"Moved: wsName:srcPath → destPath"`.
- If the write to `destPath` fails, the source is left untouched and the write error is returned.

**Note:** The source is deep-cloned via `JSON.parse(JSON.stringify(...))`, so the move is safe against circular references or shared references, but any non-JSON-serializable values will be lost.

---

#### `jjfsCopy(wsForKey, wsName, srcPath, destPath)`

Duplicates a file or directory within the same workspace. Identical to `jjfsMove` except the source is not removed.

**Parameters:**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `wsForKey` | object | The full workspace map. |
| `wsName`   | string | Name of the workspace containing both paths. |
| `srcPath`  | string | Source path. |
| `destPath` | string | Destination path. Intermediate directories are created as needed. |

**Returns:** `{ success: boolean, result: string }` — the result of the underlying `jjfsWrite` call.

**Note:** Like `jjfsMove`, uses `JSON.parse(JSON.stringify(...))` for deep cloning.

---

### Permissions

JJFS ships a full permission model inspired by POSIX file permissions but extended with ACL (Access Control List) support. Permissions are stored in a separate `fsPerms` structure and are never embedded inside `wsForKey`.

---

#### Permission Modes

A permission `mode` can be expressed in several formats:

| Format | Example | Meaning |
|--------|---------|---------|
| `"ro"` | `"ro"` | Read-only for everyone |
| `"rw"` | `"rw"` | Read-write for everyone (default) |
| Octal string (3 digits) | `"644"` | Unix-style: user bits, group bits, other bits |
| Octal string (4 digits) | `"1755"` | Unix-style with sticky bit in leading digit |
| ACL object | `{ "user@example.com": "ro", "*": "rw" }` | Per-key overrides; `*` is the wildcard fallback |

In the ACL object, values can be `"ro"`, `"rw"`, or a single octal digit string (`"0"`–`"7"`), or `null` to remove a key.

---

#### `normalizePath(p)`

Normalizes a POSIX path by resolving `.` and `..` segments and collapsing multiple slashes.

**Parameters:**

| Parameter | Type   | Description |
|-----------|--------|-------------|
| `p`       | string | Any POSIX path (absolute or relative, with or without leading `/`). |

**Returns:** `string` — an absolute path beginning with `/`. Empty input returns `"/"`.

**Examples:**

```js
normalizePath("src/../lib/./index.js")  // → "/lib/index.js"
normalizePath("/a/b/../../c")           // → "/c"
normalizePath("")                        // → "/"
```

---

#### `isValidMode(mode)`

Validates that a value is a legal JJFS permission mode.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `mode`    | any  | The value to validate. |

**Returns:** `boolean`

**Valid inputs:**
- `"ro"` or `"rw"`
- A string of 3–4 octal digits (e.g. `"644"`, `"1755"`)
- An ACL object whose values are `"ro"`, `"rw"`, `null`, or a single octal digit string

---

#### `parseOctalBits(digit)`

Decodes a single octal digit into read/write/execute permission bits using standard Unix bit mapping (4=read, 2=write, 1=execute).

**Parameters:**

| Parameter | Type   | Description |
|-----------|--------|-------------|
| `digit`   | string | A single character `"0"`–`"7"`. |

**Returns:**

```js
{ read: boolean, write: boolean, execute: boolean }
```

**Examples:**

```js
parseOctalBits("7")  // → { read: true, write: true, execute: true }
parseOctalBits("6")  // → { read: true, write: true, execute: false }
parseOctalBits("4")  // → { read: true, write: false, execute: false }
parseOctalBits("0")  // → { read: false, write: false, execute: false }
```

---

#### `getStickyBit(mode)`

Checks whether a 4-digit octal mode string has the sticky bit set (leading digit has bit 1 set, i.e. `1xxx`).

**Parameters:**

| Parameter | Type   | Description |
|-----------|--------|-------------|
| `mode`    | string | A permission mode string. |

**Returns:** `boolean` — `true` only if `mode` is a 4-digit octal string with a leading digit whose value has bit 1 set (1, 3, 5, or 7).

**Examples:**

```js
getStickyBit("1755")  // → true   (directory with sticky bit)
getStickyBit("0755")  // → false
getStickyBit("755")   // → false  (3-digit, no sticky bit position)
```

---

#### `getEffectivePermission(fsPerms, email, wsName, filePath)`

Finds the most specific applicable permission entry for a path by walking from the given path upward to the workspace root. Returns the first match found, annotated with whether it was inherited.

**Parameters:**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `fsPerms`  | object | The full permissions map. |
| `email`    | string | The user whose permissions to look up. |
| `wsName`   | string | The workspace name. |
| `filePath` | string | The path to look up. |

**Returns:**

```js
{
  mode: ...,           // from the matching permission entry
  owner: ...,          // from the matching permission entry
  effectivePath: string,  // the path that actually had the entry
  inherited: boolean   // true if effectivePath !== filePath
}
// or null if no applicable entry was found at any level
```

**Lookup order:** The exact path is checked first, then each parent directory up to `/`. The first match wins.

---

#### `getPermBitsForKey(perm, callerId)`

Decodes the read/write/execute bits from a permission entry for a specific caller ID.

**Parameters:**

| Parameter  | Type          | Description |
|------------|---------------|-------------|
| `perm`     | object\|null  | A permission entry (from `getEffectivePermission`). |
| `callerId` | string\|null  | The identifier of the caller (e.g. an API key name). |

**Returns:** `{ read: boolean, write: boolean, execute: boolean }`

**Mode resolution rules (in order):**

1. No `perm` or no `mode` → `{ read: true, write: true, execute: false }` (default: full access)
2. `"ro"` → read-only
3. `"rw"` → read-write
4. ACL object → looks up `callerId` first, then `"*"` fallback. Interprets values as `"ro"`, `"rw"`, or a single octal digit.
5. 3- or 4-digit octal string → uses the **user bits** (first digit after optional sticky) if `callerId` is listed in `perm.owner`; otherwise uses the **other bits** (last digit).

---

#### `checkWriteAccess(fsPerms, email, wsName, filePath, callerId)`

Checks whether `callerId` has write permission on a path. Session auth (`callerId === null`) always passes.

**Returns:** `{ allowed: true }` or `{ allowed: false, error: string }`

When denied, the error message includes the path and, if the permission was inherited, the path from which it was inherited.

---

#### `checkReadAccess(fsPerms, email, wsName, filePath, callerId)`

Checks whether `callerId` has read permission on a path. Session auth (`callerId === null`) always passes.

**Returns:** `{ allowed: true }` or `{ allowed: false, error: string }`

---

#### `checkOwnerAccess(fsPerms, email, wsName, filePath, callerId)`

Checks whether `callerId` is the owner of the **exact** permission entry at `filePath` (no inheritance). If there is no explicit entry, or no owner is set, access is granted. Only the listed owners may modify an owned entry.

This is used internally by `jjfsChmod` and `jjfsChown` before they modify a permission record.

**Returns:** `{ allowed: true }` or `{ allowed: false, error: string }`

---

#### `checkStickyBit(fsPerms, email, wsName, filePath, callerId)`

Enforces the sticky-bit rule: when a directory has the sticky bit set (`1xxx`), only the file's owner or the directory's owner may delete or rename files within that directory.

**Parameters:**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `fsPerms`  | object | The full permissions map. |
| `email`    | string | The workspace owner's email. |
| `wsName`   | string | The workspace name. |
| `filePath` | string | The path of the file being deleted or renamed. |
| `callerId` | string\|null | The caller's identifier. |

**Returns:** `{ allowed: true }` or `{ allowed: false, error: string }`

**Logic:**
1. Resolve the parent directory path.
2. If the parent has no permission entry, or its mode does not have the sticky bit, allow.
3. Otherwise, allow only if `callerId` is in the file's owner list or the directory's owner list.

---

#### `setPermission(fsPerms, email, wsName, filePath, updates)`

Low-level upsert for a permission entry. Merges `updates` into the existing entry, or creates a new one. If the result has no meaningful mode and no owner, the entry is deleted entirely (to avoid storing no-op entries).

**Parameters:**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `fsPerms`  | object | The full permissions map (mutated in place). |
| `email`    | string | The workspace owner's email. |
| `wsName`   | string | The workspace name. |
| `filePath` | string | The path to set permissions on. |
| `updates`  | object | `{ mode?: ..., owner?: ... }` — fields to update. |

**Mode update semantics:**
- A **string** `mode` replaces the existing mode entirely.
- An **object** `mode` is **merged** with the existing mode. Keys with `null` values are removed. If the result collapses to a single `"*"` key, it is simplified to a plain string.

**Cleanup:** Modes that are semantically equivalent to the default (`"rw"`, `"666"`, `"0666"`, or an empty object) are treated as no-op and omitted. An entry with no meaningful mode and no owner is deleted.

---

#### `removePermissionsUnder(fsPerms, email, wsName, filePath)`

Deletes all permission entries for `filePath` and any path that starts with `filePath/`. Should be called whenever a file or directory is deleted or moved.

---

#### `jjfsChmod(fsPerms, email, wsName, filePath, mode, callerId)`

Public API to set the permission mode on a path.

**Parameters:**

| Parameter  | Type          | Description |
|------------|---------------|-------------|
| `fsPerms`  | object        | The full permissions map. |
| `email`    | string        | The workspace owner's email. |
| `wsName`   | string        | The workspace name. |
| `filePath` | string        | The path to chmod. |
| `mode`     | string\|object | The new mode (validated by `isValidMode`). |
| `callerId` | string\|null  | The caller's identifier (for owner check). |

**Returns:** `{ success: boolean, status: number, result: string }`

- `400` if `mode` is invalid.
- `403` if the caller is not the owner.
- `200` on success.

---

#### `jjfsChown(fsPerms, email, wsName, filePath, owner, validOwners, callerId)`

Public API to set the owner of a path.

**Parameters:**

| Parameter     | Type                   | Description |
|---------------|------------------------|-------------|
| `fsPerms`     | object                 | The full permissions map. |
| `email`       | string                 | The workspace owner's email. |
| `wsName`      | string                 | The workspace name. |
| `filePath`    | string                 | The path to chown. |
| `owner`       | string\|string[]\|null | The new owner(s). Pass `null` or empty to clear. |
| `validOwners` | string[]               | The list of caller IDs that are permitted to be owners. |
| `callerId`    | string\|null           | The caller's identifier (for owner check). |

**Returns:** `{ success: boolean, status: number, result: string }`

- `400` if any owner value is not in `validOwners`.
- `403` if the caller is not the current owner.
- `200` on success (with or without a new owner set).

---

### Timestamps

JJFS tracks three timestamp fields per path, stored in a separate `fsTimestamps` map (not inside `wsForKey`). All timestamps are ISO-8601 strings. Persistence is the caller's responsibility.

| Field | Updated when |
|-------|-------------|
| `birthtime` | Set once when the path is first created |
| `mtime` | Set when file content changes |
| `ctime` | Set on any metadata change: `chmod`, `chown`, rename, xattr update |

---

#### `touchTimestamps(fsTimestamps, email, wsName, filePath, fields)`

Sets the specified timestamp fields to the current time (`new Date().toISOString()`).

**Parameters:**

| Parameter      | Type     | Description |
|----------------|----------|-------------|
| `fsTimestamps` | object   | The full timestamps map (mutated in place). |
| `email`        | string   | The workspace owner's email. |
| `wsName`       | string   | The workspace name. |
| `filePath`     | string   | The path to update timestamps for. |
| `fields`       | string[] | Array of fields to update: any combination of `"birthtime"`, `"mtime"`, `"ctime"`. |

**Example:**

```js
// On file creation:
touchTimestamps(fsTimestamps, email, "default", "/src/index.js", ["birthtime", "mtime", "ctime"]);

// On content edit:
touchTimestamps(fsTimestamps, email, "default", "/src/index.js", ["mtime", "ctime"]);

// On chmod/chown:
touchTimestamps(fsTimestamps, email, "default", "/src/index.js", ["ctime"]);
```

---

#### `getTimestamps(fsTimestamps, email, wsName, filePath)`

Returns the timestamp object for a path, or `null` if no timestamps have been recorded.

**Returns:** `{ birthtime?, mtime?, ctime? }` or `null`

---

#### `removeTimestampsUnder(fsTimestamps, email, wsName, filePath)`

Deletes all timestamp entries for `filePath` and any path that starts with `filePath/`. Should be called when a file or directory is deleted or moved.

---

### Symbolic Links

Symlinks are stored as metadata in `fsSymlinks`, entirely separate from the workspace tree. A symlink maps a source path to an absolute target path within the same workspace. The target is stored after normalization (via `normalizePath`).

The library follows up to **8 symlink hops** before returning an error, matching the Linux `MAXSYMLINKS` default.

---

#### `resolveSymlink(fsSymlinks, email, wsName, filePath, depth?)`

Follows a symlink chain from `filePath` to its final destination.

**Parameters:**

| Parameter    | Type   | Description |
|--------------|--------|-------------|
| `fsSymlinks` | object | The full symlinks map. |
| `email`      | string | The workspace owner's email. |
| `wsName`     | string | The workspace name. |
| `filePath`   | string | The path to resolve. |
| `depth`      | number | (internal) Current recursion depth. Do not set — defaults to `0`. |

**Returns:**

```js
{ path: string }       // resolved final path (normalized)
{ error: string }      // if depth > 8
```

If `filePath` has no symlink entry, `{ path: filePath }` is returned immediately (it is already resolved). If it has a symlink, the function recurses on the target.

---

#### `getSymlinksInDir(fsSymlinks, email, wsName, dirPath)`

Returns a map of all symlinks whose source is a **direct child** of `dirPath` (exactly one path segment below it, not deeper).

**Returns:** `{ [name: string]: "/target/path" }` — name only (no leading path), value is the full target path.

**Example:**

```js
// If fsSymlinks has "default:/src/link.js" → "/lib/real.js"
getSymlinksInDir(fsSymlinks, email, "default", "/src");
// → { "link.js": "/lib/real.js" }
```

---

#### `removeSymlinksUnder(fsSymlinks, email, wsName, filePath)`

Deletes all symlink entries for `filePath` and any path that starts with `filePath/`. Should be called when a file or directory is deleted or moved.

---

#### `jjfsSetSymlink(fsSymlinks, email, wsName, filePath, target)`

Creates or removes a symlink.

**Parameters:**

| Parameter    | Type          | Description |
|--------------|---------------|-------------|
| `fsSymlinks` | object        | The full symlinks map (mutated in place). |
| `email`      | string        | The workspace owner's email. |
| `wsName`     | string        | The workspace name. |
| `filePath`   | string        | The symlink source path. |
| `target`     | string\|null  | The symlink target (an absolute path in the same workspace). Pass `null` or `""` to remove the symlink. |

**Returns:** `{ success: true, result: string }`

- On creation: `"Symlink created: wsName:/path -> /target"`
- On removal: `"Symlink removed: wsName:/path"`

The target is normalized before storage. This function does **not** verify that the target path actually exists in the workspace tree.

---

### Extended Attributes

JJFS supports extended attributes (xattrs), following Linux's namespace convention. Only two namespaces are supported:

- `user.*` — user-defined metadata
- `trusted.*` — trusted/system metadata

Attribute names must match the pattern: `user.<name>` or `trusted.<name>`, where `<name>` consists of alphanumeric characters, `.`, `_`, and `-`.

The allowed name pattern is exported as a constant:

```js
export const XATTR_NAME_RE = /^(user|trusted)\.[a-zA-Z0-9._-]+$/;
```

All values are stored as strings.

---

#### `getXattrs(fsXattrs, email, wsName, filePath)`

Returns the extended attribute map for a path.

**Returns:** `{ [attrName: string]: string }` — empty object `{}` if no xattrs have been set.

---

#### `removeXattrsUnder(fsXattrs, email, wsName, filePath)`

Deletes all xattr entries for `filePath` and any path that starts with `filePath/`. Should be called when a file or directory is deleted or moved.

---

#### `jjfsSetXattr(fsXattrs, email, wsName, filePath, op)`

Applies an xattr operation to a path.

**Parameters:**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `fsXattrs` | object | The full xattrs map (mutated in place). |
| `email`    | string | The workspace owner's email. |
| `wsName`   | string | The workspace name. |
| `filePath` | string | The path to update xattrs on. |
| `op`       | object | Operation descriptor: `{ set?: { [name]: value }, remove?: string | string[] }` |

**`op` fields:**

- `op.set` — an object of attribute names to set. Each name is validated against `XATTR_NAME_RE`. Values are coerced to strings.
- `op.remove` — a single attribute name or array of names to delete.

**Returns:** `{ success: boolean, status: number, result: string }`

- `400` if any name in `op.set` is invalid.
- `200` on success.

After the operation, if the xattr map for the path is empty, the entry is removed from `fsXattrs` entirely.

**Example:**

```js
jjfsSetXattr(fsXattrs, email, "default", "/src/index.js", {
  set: { "user.author": "alice", "user.reviewed": "true" }
});

jjfsSetXattr(fsXattrs, email, "default", "/src/index.js", {
  remove: "user.reviewed"
});
```

---

### Binary File Helpers

JJFS stores all file content as strings. To store binary data (images, compiled artifacts, etc.), JJFS base64-encodes the bytes. These helpers abstract the encode/decode step and work in both Node.js and browsers.

---

#### `jjfsWriteBinary(wsForKey, wsName, filePath, bytes)`

Encodes binary data as base64 and writes it to a file.

**Parameters:**

| Parameter  | Type                              | Description |
|------------|-----------------------------------|-------------|
| `wsForKey` | object                            | The full workspace map. |
| `wsName`   | string                            | The workspace name. |
| `filePath` | string                            | The path to write the binary file to. |
| `bytes`    | Uint8Array \| Buffer \| number[]  | The raw binary data to store. |

**Returns:** `{ success: boolean, result: string }` — the result of the underlying `jjfsWrite` call.

**Environment detection:**

- **Node.js** (where `Buffer` is defined): uses `Buffer.from(bytes).toString('base64')`.
- **Browser**: converts to `Uint8Array`, iterates byte-by-byte into a binary string, then calls `btoa()`.

---

#### `jjfsReadBinary(wsForKey, wsName, filePath)`

Reads a file previously written with `jjfsWriteBinary` and decodes it back to binary.

**Parameters:**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `wsForKey` | object | The full workspace map. |
| `wsName`   | string | The workspace name. |
| `filePath` | string | The path of the binary file to read. |

**Returns:**

```js
{ success: true, result: Buffer }      // Node.js
{ success: true, result: Uint8Array }  // browser
{ success: false, result: string }     // error
```

**Environment detection:**

- **Node.js**: `Buffer.from(base64String, 'base64')`.
- **Browser**: `atob()` to a binary string, then `Uint8Array` from `charCodeAt`.

---

### Permission Serialization

---

#### `hashPermForResponse(perm, hashFn)`

Converts a raw permission entry (which may contain sensitive caller IDs as ACL keys or owner values) into a safe response-ready form by replacing raw keys with opaque tokens.

**Parameters:**

| Parameter | Type     | Description |
|-----------|----------|-------------|
| `perm`    | object\|null | The permission entry (from `getEffectivePermission`). |
| `hashFn`  | function | `(rawKey: string) => string` — a hashing function, e.g. SHA-256 hex. Pass `k => k` to skip hashing. |

**Returns:** A new object with the same structure as `perm`, but:
- ACL object keys that are not `"*"` are replaced with `hashFn(key)`.
- `owner` is always returned as an array (even if stored as a string), with each value passed through `hashFn`.
- `effectivePath` and `inherited` are passed through unchanged if present.
- Returns `null` if `perm` is null.

**Example:**

```js
const perm = {
  mode: { "alice@example.com": "ro", "*": "rw" },
  owner: "alice@example.com",
  inherited: true,
  effectivePath: "/"
};

hashPermForResponse(perm, k => sha256hex(k));
// → {
//   mode: { "e3b0...": "ro", "*": "rw" },
//   owner: ["e3b0..."],
//   inherited: true,
//   effectivePath: "/"
// }
```

---

## Usage Pattern

Because JJFS is stateless (no globals, no singletons), you bring your own state and your own persistence:

```js
import {
  jjfsRead, jjfsWrite, jjfsEdit, jjfsDelete, jjfsMove, jjfsCopy,
  jjfsChmod, jjfsChown,
  touchTimestamps, getTimestamps, removeTimestampsUnder,
  jjfsSetSymlink, resolveSymlink, removeSymlinksUnder,
  jjfsSetXattr, getXattrs, removeXattrsUnder,
  removePermissionsUnder
} from './jjfs.js';

// Initialize state
const wsForKey = { default: {} };
const fsPerms = {};
const fsTimestamps = {};
const fsSymlinks = {};
const fsXattrs = {};

// Write a file
jjfsWrite(wsForKey, "default", "/hello.txt", "Hello, world!");
touchTimestamps(fsTimestamps, "user@example.com", "default", "/hello.txt", ["birthtime", "mtime", "ctime"]);

// Read it back
const { result } = jjfsRead(wsForKey, "default", "/hello.txt");
console.log(result); // "Hello, world!"

// Edit it
jjfsEdit(wsForKey, "default", "/hello.txt", "world", "JJFS");
touchTimestamps(fsTimestamps, "user@example.com", "default", "/hello.txt", ["mtime", "ctime"]);

// Restrict read access
jjfsChmod(fsPerms, "user@example.com", "default", "/hello.txt", "ro", null);
touchTimestamps(fsTimestamps, "user@example.com", "default", "/hello.txt", ["ctime"]);

// Delete and clean up all metadata
jjfsDelete(wsForKey, "default", "/hello.txt");
removePermissionsUnder(fsPerms, "user@example.com", "default", "/hello.txt");
removeTimestampsUnder(fsTimestamps, "user@example.com", "default", "/hello.txt");
removeSymlinksUnder(fsSymlinks, "user@example.com", "default", "/hello.txt");
removeXattrsUnder(fsXattrs, "user@example.com", "default", "/hello.txt");

// Persist however you like
saveToDatabase({ wsForKey, fsPerms, fsTimestamps, fsSymlinks, fsXattrs });
```

---

## Design Notes

### No I/O

JJFS performs zero I/O. It has no dependencies on `fs`, `fetch`, `localStorage`, or any other runtime API. All state lives in plain JavaScript objects that you supply and own.

### Mutations are in-place

All write operations (`jjfsWrite`, `jjfsEdit`, `jjfsDelete`, `jjfsMove`, `touchTimestamps`, `setPermission`, etc.) modify their input objects directly. If you need snapshots or undo history, deep-clone before calling.

### Metadata is always separate

Permissions, timestamps, symlinks, and xattrs are stored in their own maps, entirely separate from `wsForKey`. This keeps the workspace tree clean and serializable as plain JSON.

### Cleanup is manual

When you delete or move a file or directory, you must manually call the corresponding `removeXxxUnder` functions to clean up orphaned metadata. JJFS does not do this automatically because it does not know which metadata maps you are using.

### Binary data

Files are always strings. Binary content must be base64-encoded using `jjfsWriteBinary` / `jjfsReadBinary`. The helpers handle environment detection (Node.js vs. browser) automatically.
