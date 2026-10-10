/**
 * dsh-wsl-git — workspace target resolution and path translation.
 *
 * Two jobs:
 *
 *  1. Decide WHICH git executes a request, from the workspace path alone. A WSL
 *     workspace path already names its own distribution — DSH stores it as
 *     `\\wsl.localhost\<distro>\<linux>` — so nothing here is hard-coded and no
 *     configuration is required for the ordinary case.
 *  2. Translate between the two spellings a path has in this plugin: the HOST
 *     spelling the HTTP boundary speaks (a WSL UNC path, or a Windows drive
 *     path) and the LINUX spelling the distribution's git needs.
 *
 * Everything except {@link readWslWorkspaces} is a pure function, which is what
 * makes the whole contract testable without a WSL host (tests/target.test.mjs).
 *
 * The path helpers are PORTED from dsh-wsl-workspace's `src/shared/paths.ts`
 * rather than imported: that package exports only `.`, `./shell`, `./fs` and
 * `./client`, so its helpers have no importable subpath and a sibling plugin's
 * internals are not a dependency surface. They are pinned by this plugin's own
 * tests instead.
 *
 * @module dsh-wsl-git/target
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/* ============================== UNC parsing ============================== */

/** WSL2 default loopback bridge host: `\\wsl.localhost\<distro>\...`. */
const WSL_LOCALHOST_HOST = 'wsl.localhost'
/** Legacy WSL interop host: `\\wsl$\<distro>\...`. */
const WSL_LEGACY_HOST = 'wsl$'
/** The two UNC hosts WSL exposes a distribution's filesystem under. */
const UNC_HOSTS = [WSL_LOCALHOST_HOST, WSL_LEGACY_HOST]

/** Linux username shape, matching `wsl.exe -u` and the upstream plugin. */
const WSL_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/

/** A Windows drive path: `C:\foo` or `C:/foo`. */
const DRIVE_PATH_PATTERN = /^([A-Za-z]):[\\/](.*)$/

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse a WSL UNC path into its distribution and Linux path.
 *
 * Accepts the WSL2 `\\wsl.localhost\<distro>\<linux>` form, the legacy
 * `\\wsl$\<distro>\<linux>` interop form, and forward-slash spellings of
 * either — the client sends repo roots back with `/` separators
 * (`repoRow` slash-normalizes them), so the forward form is the one that
 * actually arrives on the wire.
 *
 * @param {unknown} raw - candidate absolute path.
 * @returns {{distro: string, linuxPath: string} | null} the parsed target, or
 *   null when the path is not a WSL UNC.
 */
export function parseWslUnc(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  const normalized = raw.replace(/\\/g, '/').replace(/\/\/+/g, '//')
  if (!normalized.startsWith('//')) return null
  const segments = normalized.slice(2).split('/')
  const host = (segments[0] === undefined ? '' : segments[0]).toLowerCase()
  if (!UNC_HOSTS.includes(host)) return null
  const distro = segments[1] === undefined ? '' : segments[1]
  if (distro === '') return null
  const rest = segments.slice(2).filter(segment => segment.length > 0)
  return { distro: distro, linuxPath: '/' + rest.join('/') }
}

/** Whether a value is an absolute, non-empty Linux path. */
export function isAbsoluteLinuxPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
}

/**
 * The Linux spelling of a host absolute path — the INVERSE of
 * {@link linuxToHost}, for the few values that are git ARGUMENTS rather than git
 * output.
 *
 * Upstream 0.15.0 introduced two calls that pass an absolute path as an argument:
 * `clone`'s target directory and `diff --no-index`'s file. Handing the
 * distribution's git the Windows or UNC spelling of a path inside its own
 * filesystem names nothing, and the failure is quiet — an empty patch, or a
 * `not a git repository` about a directory that is one.
 *
 * A path outside the target's own root is still expressible when it lives on a
 * drvfs mount (`/mnt/<drive>`), which is how a WSL workspace reaches a Windows
 * drive. Anything else — another distribution's filesystem, for instance — has no
 * spelling this world can open, and returns null so the caller can refuse it by
 * name instead of guessing.
 *
 * @param {{kind: string, hostPath: string, linuxPath?: string}} target - the resolved target.
 * @param {string} hostPath - an absolute host path.
 * @returns {string | null} the path in the target's own spelling, or null when it has none.
 */
export function linuxPathOf(target, hostPath) {
  if (target === null || typeof target !== 'object') return null
  if (typeof hostPath !== 'string' || hostPath === '') return null
  // A local target already speaks host paths: the same string is the right answer.
  if (target.kind !== 'wsl') return hostPath
  if (typeof target.linuxPath !== 'string' || target.linuxPath === '') return null
  const resolved = resolve(hostPath)
  const root = resolve(target.hostPath)
  const inside = relative(root, resolved)
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    const suffix = inside === '' ? '' : '/' + inside.split(sep).join('/')
    return normalizeLinuxPath(target.linuxPath + suffix)
  }
  return windowsToMntPath(resolved)
}

/**
 * Whether a value is a Linux-only absolute path — one that is NOT also a host
 * path, and therefore must never cross the HTTP boundary.
 *
 * `node:path` on Windows calls `/home/steaf/x` "absolute" and then resolves it to
 * `C:\home\steaf\x`, a path that names nothing; every later filesystem call
 * misses silently. So the boundary refuses these by name instead. A
 * `//`-prefixed value is excluded because that IS a host path: it is the
 * forward-slash spelling of a UNC path, which is what the client sends back
 * after `repoRow` slash-normalized a repository root.
 *
 * @param {unknown} value - the candidate.
 * @returns {boolean} true when the value is Linux-only.
 */
export function isLinuxOnlyPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

/**
 * Normalize a Linux absolute path: collapse repeated slashes, strip a trailing
 * slash (root stays `/`).
 * @param {string} value - absolute Linux path.
 * @returns {string} the normalized path.
 */
export function normalizeLinuxPath(value) {
  const collapsed = value.replace(/\/+/g, '/')
  return collapsed === '/' ? '/' : collapsed.replace(/\/$/, '')
}

/**
 * Join a distribution and a Linux absolute path into the WSL2 UNC form used as
 * the workspace identity (`\\wsl.localhost\<distro>\<linux>`, backslash
 * segments) — the same spelling DSH stores as the session workspace path.
 * @param {string} distro - distribution name.
 * @param {string} linuxPath - absolute Linux path.
 * @returns {string} the UNC path.
 */
export function joinUnc(distro, linuxPath) {
  if (!isAbsoluteLinuxPath(linuxPath)) {
    throw new Error(`dsh-wsl-git: cannot map a non-absolute Linux path "${linuxPath}" to UNC`)
  }
  // Defense in depth: a distribution name carrying a separator or a dot-dir
  // would escape the `\\wsl.localhost\` share structure. Names reaching here
  // come from a workspace path or the registry, but the fence is cheap.
  if (distro === '' || distro === '.' || distro === '..' || /[\\/]/.test(distro)) {
    throw new Error(`dsh-wsl-git: invalid distribution name "${distro}"`)
  }
  const normalized = normalizeLinuxPath(linuxPath)
  const withoutLeading = normalized.startsWith('/') ? normalized.slice(1) : normalized
  const windowsSegments = withoutLeading.replace(/\//g, '\\')
  const suffix = windowsSegments === '' ? '' : `\\${windowsSegments}`
  return `\\\\wsl.localhost\\${distro}${suffix}`
}

/**
 * Canonicalize any accepted WSL UNC spelling into the registry's key form.
 * @param {string} value - candidate workspace path.
 * @returns {string | null} the canonical UNC path, or null when not a WSL UNC.
 */
export function canonicalWslUnc(value) {
  const parsed = parseWslUnc(value)
  return parsed === null ? null : joinUnc(parsed.distro, parsed.linuxPath)
}

/**
 * Canonical Windows drive path for registry keys and cross-realm identity:
 * separators unified to `\`, trailing separator stripped, and the WHOLE path
 * lowercased — Windows paths compare case-insensitively and the registry may
 * realpath a different casing than the caller spelled.
 * @param {unknown} value - candidate Windows drive path.
 * @returns {string | null} the canonical form, or null when not drive-shaped.
 */
export function canonicalWindowsPath(value) {
  if (typeof value !== 'string') return null
  const match = DRIVE_PATH_PATTERN.exec(value)
  if (match === null) return null
  const rest = (match[2] === undefined ? '' : match[2]).replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase()
  return `${(match[1] === undefined ? '' : match[1]).toLowerCase()}:\\${rest}`
}

/**
 * Translate a Windows drive path to the drvfs mount path WSL distributions
 * conventionally expose it at (`C:\foo` → `/mnt/c/foo`). Only single-letter
 * drives under `/mnt` are mapped; custom mount points are out of scope.
 * @param {string} value - the candidate Windows path.
 * @returns {string | null} the `/mnt/<drive>/…` path, or null.
 */
export function windowsToMntPath(value) {
  if (typeof value !== 'string') return null
  const match = DRIVE_PATH_PATTERN.exec(value)
  if (match === null) return null
  const rest = (match[2] === undefined ? '' : match[2]).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  return `/mnt/${(match[1] === undefined ? '' : match[1]).toLowerCase()}${rest === '' ? '' : `/${rest}`}`
}

/**
 * Translate a `/mnt/<drive>/…` path back to its Windows drive path.
 * @param {string} value - the candidate Linux path.
 * @returns {string | null} the `X:\…` drive path, or null.
 */
export function mntToWindowsPath(value) {
  if (typeof value !== 'string') return null
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(value)
  if (match === null) return null
  const rest = (match[2] === undefined ? '' : match[2]).replace(/\//g, '\\')
  return `${(match[1] === undefined ? '' : match[1]).toUpperCase()}:\\${rest}`
}

/** Whether a value is a safe Linux username for `wsl.exe -u`. */
export function isValidWslUsername(value) {
  return typeof value === 'string' && WSL_USERNAME_PATTERN.test(value)
}

/* ============================== direction mapping ============================== */

/**
 * The HOST spelling of an absolute Linux path — the spelling the host process
 * can actually open, and the one the HTTP boundary uses.
 *
 * The split is not cosmetic. The 9P share that serves `\\wsl.localhost\…` covers
 * only the distribution's ext4 volume: a drvfs mount (`/mnt/<drive>`) answers
 * Access denied there (measured: `readdirSync('\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\c')`
 * → EPERM), so those paths must travel as their drive letter — which is also
 * how DSH registers a `/mnt` workspace in the first place.
 *
 * @param {string} linuxPath - absolute Linux path.
 * @param {string} distro - the distribution the path lives in.
 * @returns {string | null} the host spelling, or null when it cannot be named.
 */
export function linuxToHost(linuxPath, distro) {
  if (!isAbsoluteLinuxPath(linuxPath)) return null
  // A `//`-prefixed spelling is already a UNC host path, not a Linux one.
  if (linuxPath.startsWith('//')) return null
  const drive = mntToWindowsPath(linuxPath)
  if (drive !== null) return drive
  if (distro === undefined || distro === '') return null
  return joinUnc(distro, linuxPath)
}

/**
 * The Linux spelling of a host path, plus which kind of host path it was.
 *
 * Returns null for a Windows drive path: a drive path *can* be `/mnt/<drive>`,
 * but only the registry knows whether that drive is a WSL workspace, and
 * guessing would hand a Linux path to a distribution that never owned the
 * directory. {@link resolveTarget} makes that call.
 *
 * @param {string} hostPath - a UNC or drive path.
 * @returns {{kind: 'unc' | 'drive', distro?: string, linuxPath: string} | null}
 */
export function hostToLinux(hostPath) {
  const unc = parseWslUnc(hostPath)
  if (unc !== null) return { kind: 'unc', distro: unc.distro, linuxPath: unc.linuxPath }
  const mnt = windowsToMntPath(hostPath)
  if (mnt !== null) return { kind: 'drive', linuxPath: mnt }
  return null
}

/* ============================== the workspace registry ============================== */

/**
 * Read DSH's WSL workspace registry (`<dshHome>/wsl-workspaces.json`).
 *
 * This is the file dsh-wsl-workspace writes when a workspace is added, and it is
 * the only place a `/mnt/<drive>` workspace's distribution is recorded: 9P
 * cannot serve drvfs, so such a workspace registers under its Windows drive path
 * with the distribution stored beside it.
 *
 * A missing file reads as empty — most installs have no `/mnt` workspace, and
 * the plugin must load there. A file that exists but cannot be read is reported
 * rather than swallowed, because the symptom of the silent version is a `/mnt`
 * workspace quietly running Windows git.
 *
 * @param {string} dshHome - the harness home directory.
 * @returns {Record<string, {username?: string, distro?: string}>} the registry.
 */
export function readWslWorkspaces(dshHome) {
  const file = join(dshHome, 'wsl-workspaces.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return {}
    console.warn(`[dsh-wsl-git] cannot read ${file}: ${messageOf(error)} — a workspace registered by drive path will fall back to the Windows git`)
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[dsh-wsl-git] ${file} does not hold a JSON object; ignoring it`)
      return {}
    }
    return parsed
  } catch (error) {
    console.warn(`[dsh-wsl-git] ${file} is not valid JSON: ${messageOf(error)}; ignoring it`)
    return {}
  }
}

/** Whether one Linux path contains another, at a separator boundary. */
function containsLinuxPath(outer, inner) {
  if (outer === inner) return true
  const prefix = outer.endsWith('/') ? outer : outer + '/'
  return inner.startsWith(prefix)
}

/** A registry value, or undefined when it is not an object. */
function asEntry(value) {
  return value === undefined || value === null || typeof value !== 'object' ? undefined : value
}

/**
 * The registry entry governing a host path, by the LONGEST registered key that
 * contains it — for both spellings a workspace can have.
 *
 * Containment, not equality, is what makes the resolution stable across a whole
 * request. Discovery resolves the WORKSPACE path, but nearly every later call
 * passes the REPO ROOT git reported — the workspace itself for a single-repo
 * workspace, a subdirectory for a container one, a submodule path at any depth.
 * An equality-only lookup misses there, and the miss is silent in the worst way:
 * a drive path would drop back to the Windows git (the panel lists WSL
 * repositories and then fails to read any of them), and a UNC path would lose the
 * workspace's configured Linux user and quietly run as the distribution default.
 *
 * The two spellings compare differently, for a reason. A drive path is
 * case-insensitive (Windows), so both sides go through
 * {@link canonicalWindowsPath}. A UNC path carries a LINUX path, where case is
 * meaningful — `\\wsl.localhost\Ubuntu-24.04\Home` and `\home` are different
 * directories — so those compare through their Linux spellings, exactly.
 *
 * @param {Record<string, unknown>} store - the registry.
 * @param {string} hostPath - a host path: a WSL UNC path or a Windows drive path.
 * @returns {{username?: string, distro?: string} | undefined} the entry, or undefined.
 */
export function lookupEntry(store, hostPath) {
  const target = parseWslUnc(hostPath)
  if (target !== null) {
    const wanted = normalizeLinuxPath(target.linuxPath)
    let bestLength = -1
    let best
    for (const [storedKey, entry] of Object.entries(store)) {
      const stored = parseWslUnc(storedKey)
      // A registry key for a different distribution describes a different world,
      // even when the Linux path is identical.
      if (stored === null || stored.distro !== target.distro) continue
      if (!containsLinuxPath(normalizeLinuxPath(stored.linuxPath), wanted)) continue
      if (stored.linuxPath.length > bestLength) {
        bestLength = stored.linuxPath.length
        best = entry
      }
    }
    return asEntry(best)
  }

  const key = canonicalWindowsPath(hostPath)
  if (key === null) return undefined
  let bestKey = null
  let best
  for (const [storedKey, entry] of Object.entries(store)) {
    // Only drive-shaped stored keys can govern a drive path; the UNC keys in the
    // same registry describe a different kind of workspace.
    if (canonicalWindowsPath(storedKey) === null) continue
    if (key !== storedKey && !key.startsWith(storedKey + '\\')) continue
    if (bestKey === null || storedKey.length > bestKey.length) {
      bestKey = storedKey
      best = entry
    }
  }
  return asEntry(best)
}

/* ============================== target resolution ============================== */

/** Distinguish why a target came out the way it did (diagnostics + tests). */
export const TARGET_SOURCE = {
  /** The workspace path is a WSL UNC path; the distribution is in the path. */
  UNC: 'unc',
  /** A drive path registered as a WSL workspace; the distribution came from the registry. */
  DRIVE_WORKSPACE: 'drive-workspace',
  /** A drive path with no registry entry, mapped only because a distro was configured. */
  CONFIGURED_DISTRO: 'configured-distro',
  /** Not a WSL workspace: the local git binary runs, exactly as upstream. */
  LOCAL: 'local',
}

/** Round-trip a trimmed string option, treating blank and absent alike. */
function option(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The Linux user for a workspace: registry first, then config, then the env override. */
function resolveUser(stored, configured) {
  const fromEnv = option(process.env.DSH_WSL_USER)
  for (const candidate of [stored, configured, fromEnv]) {
    if (candidate !== undefined && isValidWslUsername(candidate)) return candidate
  }
  return undefined
}

/**
 * Decide which git runs a request, from the path the client sent.
 *
 * Order, and why:
 *  1. A WSL UNC path names its own distribution. The workspace always wins over
 *     configuration — that is what makes this plugin general rather than
 *     installed-for-one-machine.
 *  2. A drive path registered in the WSL workspace registry belongs to the
 *     distribution stored there, at its `/mnt/<drive>` spelling.
 *  3. A configured `distro` covers a drive path nothing registered. Off by
 *     default; with it empty, an unregistered drive path is an ordinary Windows
 *     workspace.
 *  4. Anything else is local: the Windows git binary, unchanged.
 *
 * @param {string} hostPath - the workspace or repo-root path the client sent.
 * @param {{store?: Record<string, unknown>, distro?: string, user?: string}} [options]
 * @returns {{kind: 'wsl'|'local', hostPath: string, source: string, distro?: string,
 *   user?: string, linuxPath?: string}} the target.
 */
export function resolveTarget(hostPath, options = {}) {
  const store = options.store === undefined || options.store === null ? {} : options.store
  const configuredDistro = option(options.distro)
  const configuredUser = option(options.user)

  const unc = parseWslUnc(hostPath)
  if (unc !== null) {
    const entry = lookupEntry(store, hostPath)
    return {
      kind: 'wsl',
      hostPath: hostPath,
      source: TARGET_SOURCE.UNC,
      distro: unc.distro,
      user: resolveUser(entry === undefined ? undefined : entry.username, configuredUser),
      linuxPath: unc.linuxPath,
    }
  }

  const entry = lookupEntry(store, hostPath)
  const entryDistro = entry !== undefined && typeof entry.distro === 'string' && entry.distro !== '' ? entry.distro : undefined
  const distro = entryDistro === undefined ? configuredDistro : entryDistro
  const linuxPath = distro === undefined ? null : windowsToMntPath(hostPath)
  if (distro !== undefined && linuxPath !== null) {
    return {
      kind: 'wsl',
      hostPath: hostPath,
      source: entryDistro === undefined ? TARGET_SOURCE.CONFIGURED_DISTRO : TARGET_SOURCE.DRIVE_WORKSPACE,
      distro: distro,
      user: resolveUser(entry === undefined ? undefined : entry.username, configuredUser),
      linuxPath: linuxPath,
    }
  }

  return { kind: 'local', hostPath: hostPath, source: TARGET_SOURCE.LOCAL }
}

/**
 * A target named the way a person reads it, for error messages and logs.
 * @param {{kind: string, distro?: string, linuxPath?: string, hostPath: string}} target
 * @returns {string} e.g. `Ubuntu-24.04:/home/steaf/workspace/x`, or `local:<path>`.
 */
export function describeTarget(target) {
  if (target.kind !== 'wsl') return `local git in ${target.hostPath}`
  const user = target.user === undefined ? '' : `${target.user}@`
  return `${user}${target.distro}:${target.linuxPath}`
}
