/**
 * dsh-wsl-git — the pure contract.
 *
 * Everything the plugin decides WITHOUT touching a WSL host: which git executes
 * a request, how a path is spelled on the way in and on the way out, what argv
 * one WSL call is made of, and how a failure of the launcher is told apart from
 * an answer from git. Those are the decisions that go wrong silently, so they are
 * the ones pinned here; the end-to-end behaviour needs a real distribution and is
 * covered by the acceptance run instead.
 *
 * Run: node --test tests/target.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  canonicalWindowsPath,
  canonicalWslUnc,
  describeTarget,
  hostToLinux,
  isAbsoluteLinuxPath,
  isLinuxOnlyPath,
  isValidWslUsername,
  joinUnc,
  linuxPathOf,
  linuxToHost,
  lookupEntry,
  mntToWindowsPath,
  normalizeLinuxPath,
  parseWslUnc,
  readWslWorkspaces,
  resolveTarget,
  TARGET_SOURCE,
  windowsToMntPath,
} from '../src/target.js'
import {
  buildWslArgv,
  gitProgramFor,
  gitSpawnSpec,
  launcherFailureOf,
  normalizeDiagnostic,
  remoteGitMissingOf,
  wslEnv,
  WSL_EXE,
} from '../src/wsl-git.js'

/* The shapes this host actually has: an Ubuntu-24.04 workspace stored as a UNC
   path, and an Ubuntu-20.04 one, so a test can prove the distribution comes from
   the path rather than from any constant. */
const UNC = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf\\workspace\\device_xcar_1.0'
const UNC_SLASHED = '//wsl.localhost/Ubuntu-24.04/home/steaf/workspace/device_xcar_1.0'
const UNC_OTHER_DISTRO = '\\\\wsl.localhost\\Ubuntu-20.04\\home\\steaf\\neptune_os_utils'

/* ============================== UNC parsing ============================== */

test('parseWslUnc reads both hosts and both separator spellings', () => {
  const expected = { distro: 'Ubuntu-24.04', linuxPath: '/home/steaf/workspace/device_xcar_1.0' }
  assert.deepEqual(parseWslUnc(UNC), expected)
  // The forward-slash form is the one that actually arrives: the host's repoRow
  // slash-normalizes every discovery row before the client ever sees it.
  assert.deepEqual(parseWslUnc(UNC_SLASHED), expected)
  assert.deepEqual(parseWslUnc('\\\\wsl$\\Ubuntu-24.04\\home\\steaf'), { distro: 'Ubuntu-24.04', linuxPath: '/home/steaf' })
  assert.deepEqual(parseWslUnc('//wsl$/Ubuntu-24.04/home/steaf'), { distro: 'Ubuntu-24.04', linuxPath: '/home/steaf' })
})

test('parseWslUnc normalizes a distro root and a trailing separator', () => {
  assert.deepEqual(parseWslUnc('\\\\wsl.localhost\\Ubuntu-24.04'), { distro: 'Ubuntu-24.04', linuxPath: '/' })
  assert.deepEqual(parseWslUnc('\\\\wsl.localhost\\Ubuntu-24.04\\'), { distro: 'Ubuntu-24.04', linuxPath: '/' })
  assert.deepEqual(parseWslUnc(UNC + '\\\\'), { distro: 'Ubuntu-24.04', linuxPath: '/home/steaf/workspace/device_xcar_1.0' })
})

test('parseWslUnc keeps a distribution name that contains a space', () => {
  // WSL allows these, and dsh-wsl-workspace documents the same pattern.
  assert.deepEqual(parseWslUnc('\\\\wsl.localhost\\Ubuntu 24.04\\home'), { distro: 'Ubuntu 24.04', linuxPath: '/home' })
})

test('parseWslUnc refuses anything that is not a WSL UNC', () => {
  for (const value of ['C:\\Users\\steaf', '/home/steaf', '\\\\server\\share\\x', '\\\\wsl.localhost', '\\\\wsl.localhost\\', '', 'relative/path', null, undefined, 42]) {
    assert.equal(parseWslUnc(value), null, `expected null for ${JSON.stringify(value)}`)
  }
})

test('joinUnc round-trips and fences the share structure', () => {
  assert.equal(joinUnc('Ubuntu-24.04', '/home/steaf'), '\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf')
  assert.equal(joinUnc('Ubuntu-24.04', '/'), '\\\\wsl.localhost\\Ubuntu-24.04')
  assert.equal(joinUnc('Ubuntu-24.04', '/home/steaf/'), '\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf')
  assert.equal(canonicalWslUnc(UNC_SLASHED), UNC)
  // A name with a separator or a dot-dir would escape the share root.
  assert.throws(() => joinUnc('../evil', '/home'))
  assert.throws(() => joinUnc('a\\b', '/home'))
  assert.throws(() => joinUnc('Ubuntu-24.04', 'not/absolute'))
})

/* ============================== drive spelling ============================== */

test('windowsToMntPath and mntToWindowsPath are inverses', () => {
  assert.equal(windowsToMntPath('C:\\Users\\steaf'), '/mnt/c/Users/steaf')
  assert.equal(windowsToMntPath('d:/workspace/x'), '/mnt/d/workspace/x')
  assert.equal(windowsToMntPath('C:\\'), '/mnt/c')
  assert.equal(mntToWindowsPath('/mnt/c/Users/steaf'), 'C:\\Users\\steaf')
  assert.equal(mntToWindowsPath('/mnt/d'), 'D:\\')
  assert.equal(mntToWindowsPath('/mnt/c'), 'C:\\')
  assert.equal(windowsToMntPath('\\\\wsl.localhost\\Ubuntu\\home'), null)
  assert.equal(mntToWindowsPath('/home/steaf'), null)
  assert.equal(mntToWindowsPath('/mnt/cc/x'), null)
})

test('canonicalWindowsPath lowercases, unifies separators and strips a trailing one', () => {
  assert.equal(canonicalWindowsPath('C:\\Users\\Me\\'), 'c:\\users\\me')
  assert.equal(canonicalWindowsPath('c:/users/me'), 'c:\\users\\me')
  assert.equal(canonicalWindowsPath('C:\\Users\\Me'), canonicalWindowsPath('c:\\users\\me'))
  assert.equal(canonicalWindowsPath('\\\\wsl.localhost\\Ubuntu\\home'), null)
})

/* ============================== direction mapping ============================== */

test('linuxToHost names an ext4 path through its distribution and a drvfs path by drive', () => {
  // ext4: only the 9P share can serve it, so it travels as a UNC path.
  assert.equal(linuxToHost('/home/steaf/workspace/x', 'Ubuntu-24.04'), '\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf\\workspace\\x')
  /* drvfs: the share answers Access denied for /mnt (measured on this host:
     readdirSync('\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\c') → EPERM), so it must
     travel as the drive letter. This branch is why the mapping is not "always UNC". */
  assert.equal(linuxToHost('/mnt/c/Users/steaf', 'Ubuntu-24.04'), 'C:\\Users\\steaf')
  assert.equal(linuxToHost('/mnt/d/x', 'Ubuntu-24.04'), 'D:\\x')
  // A path that is already a host spelling, and a relative one, are not ours.
  assert.equal(linuxToHost('//wsl.localhost/Ubuntu-24.04/home', 'Ubuntu-24.04'), null)
  assert.equal(linuxToHost('home/steaf', 'Ubuntu-24.04'), null)
  // An ext4 path with no distribution cannot be named.
  assert.equal(linuxToHost('/home/steaf', undefined), null)
  assert.equal(linuxToHost('/home/steaf', ''), null)
})

test('hostToLinux reports which kind of host path it was', () => {
  assert.deepEqual(hostToLinux(UNC), { kind: 'unc', distro: 'Ubuntu-24.04', linuxPath: '/home/steaf/workspace/device_xcar_1.0' })
  assert.deepEqual(hostToLinux(UNC_SLASHED), { kind: 'unc', distro: 'Ubuntu-24.04', linuxPath: '/home/steaf/workspace/device_xcar_1.0' })
  assert.deepEqual(hostToLinux('C:\\Users\\steaf'), { kind: 'drive', linuxPath: '/mnt/c/Users/steaf' })
  assert.equal(hostToLinux('/home/steaf'), null)
  assert.equal(hostToLinux('relative'), null)
})

/* The regression this pairing exists for.
 *
 * `rev-parse --show-toplevel` answers in the world git ran in, so a WSL call
 * returns a LINUX path. Every absolute path git reports therefore has to go
 * through `linuxToHost` before it becomes a target again — and one site
 * (`scanRepos`) originally did not, which was measured end to end as
 * `repos` failing with `cannot run git: spawn git ENOENT` while `summary`,
 * `branches`, `log` and `commitDetail` all worked on the same workspace. The
 * negative control below is what makes the positive one meaningful: it pins the
 * exact wrong answer the missing mapping produced. */
const GIT_TOPLEVEL = '/home/steaf/workspace/device_xcar_1.0'

test('a git toplevel maps back to the same WSL target (the repos ENOENT regression)', () => {
  const hostPath = linuxToHost(GIT_TOPLEVEL, 'Ubuntu-24.04')
  assert.equal(hostPath, UNC)
  const roundTrip = resolveTarget(hostPath, { store: {} })
  assert.equal(roundTrip.kind, 'wsl', 'the mapped path must still resolve to the distribution')
  assert.equal(roundTrip.distro, 'Ubuntu-24.04')
  // Closed: what git printed is what the next request runs against.
  assert.equal(roundTrip.linuxPath, GIT_TOPLEVEL)
})

test('an unmapped Linux path silently becomes the LOCAL world (why the mapping is mandatory)', () => {
  // Exactly what the missing `hostPathOf` did: not a UNC path, no registry entry,
  // so it fell through to the local git and then to spawn with a cwd of
  // `C:\home\steaf\...`, which does not exist.
  const naive = resolveTarget(GIT_TOPLEVEL, { store: {} })
  assert.equal(naive.kind, 'local')
  assert.equal(naive.source, TARGET_SOURCE.LOCAL)
})

test('isLinuxOnlyPath is the guard requireAbsolute applies to wire input', () => {
  assert.equal(isLinuxOnlyPath('/home/steaf/x'), true)
  assert.equal(isLinuxOnlyPath('/mnt/c/Users/steaf'), true)
  // A forward-slash UNC path is a HOST path: the client legitimately sends it
  // back after repoRow slash-normalizes a repository root.
  assert.equal(isLinuxOnlyPath('//wsl.localhost/Ubuntu-24.04/home'), false)
  assert.equal(isLinuxOnlyPath('\\\\wsl.localhost\\Ubuntu-24.04\\home'), false)
  assert.equal(isLinuxOnlyPath('C:\\Users\\steaf'), false)
  assert.equal(isLinuxOnlyPath(null), false)
})

test('normalizeLinuxPath and isAbsoluteLinuxPath agree on the edge cases', () => {
  assert.equal(normalizeLinuxPath('/home//steaf/'), '/home/steaf')
  assert.equal(normalizeLinuxPath('/'), '/')
  assert.equal(isAbsoluteLinuxPath('/x'), true)
  assert.equal(isAbsoluteLinuxPath('x'), false)
  assert.equal(isAbsoluteLinuxPath('/x\0y'), false)
})

/* ============================== registry lookup ============================== */

test('lookupEntry finds a drive workspace by containment, not equality', () => {
  const store = {
    'c:\\users\\steaf\\workspace': { distro: 'Ubuntu-24.04', username: 'steaf' },
    'd:\\other': { distro: 'Ubuntu-20.04' },
  }
  assert.equal(lookupEntry(store, 'C:\\Users\\steaf\\workspace')?.distro, 'Ubuntu-24.04')
  /* The load-bearing case: discovery resolves the workspace, but every later call
     passes the REPO ROOT git reported. An equality-only lookup misses here and
     drops those calls back to the Windows git. */
  assert.equal(lookupEntry(store, 'C:\\Users\\steaf\\workspace\\myrepo')?.distro, 'Ubuntu-24.04')
  assert.equal(lookupEntry(store, 'c:\\USERS\\steaf\\workspace\\myrepo\\sub')?.distro, 'Ubuntu-24.04')
  /* A sibling whose name merely starts with the same letters is NOT inside it. */
  assert.equal(lookupEntry(store, 'C:\\Users\\steaf\\workspace-other'), undefined)
  assert.equal(lookupEntry(store, 'C:\\Users\\steaf'), undefined)
  assert.equal(lookupEntry({}, 'C:\\Users\\steaf\\workspace'), undefined)
})

test('lookupEntry prefers the longest registered key', () => {
  const store = {
    'c:\\ws': { distro: 'Ubuntu-20.04' },
    'c:\\ws\\inner': { distro: 'Ubuntu-24.04', username: 'steaf' },
  }
  assert.equal(lookupEntry(store, 'C:\\ws\\inner\\repo')?.distro, 'Ubuntu-24.04')
  assert.equal(lookupEntry(store, 'C:\\ws\\other')?.distro, 'Ubuntu-20.04')
})

test('lookupEntry matches a UNC workspace by containment, inside its own distribution', () => {
  const store = {
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf\\workspace': { username: 'steaf' },
  }
  assert.equal(lookupEntry(store, UNC)?.username, 'steaf')
  // A submodule or a nested repository keeps the workspace's configured user.
  assert.equal(lookupEntry(store, '\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf\\workspace\\a\\b')?.username, 'steaf')
  // A different distribution is a different world, even at the same Linux path.
  assert.equal(lookupEntry(store, '\\\\wsl.localhost\\Ubuntu-20.04\\home\\steaf\\workspace\\x'), undefined)
  // The Linux path is case-SENSITIVE: /Home is not /home.
  assert.equal(lookupEntry(store, '\\\\wsl.localhost\\Ubuntu-24.04\\Home\\steaf\\workspace\\x'), undefined)
  // And a UNC key must not govern a drive path.
  assert.equal(lookupEntry(store, 'C:\\Users\\steaf\\workspace'), undefined)
})

/* ============================== target resolution ============================== */

test('a WSL workspace path names its own distribution', () => {
  const one = resolveTarget(UNC, { store: {} })
  assert.equal(one.kind, 'wsl')
  assert.equal(one.distro, 'Ubuntu-24.04')
  assert.equal(one.linuxPath, '/home/steaf/workspace/device_xcar_1.0')
  assert.equal(one.source, TARGET_SOURCE.UNC)

  const two = resolveTarget(UNC_OTHER_DISTRO, { store: {} })
  assert.equal(two.distro, 'Ubuntu-20.04')
  assert.equal(two.linuxPath, '/home/steaf/neptune_os_utils')
})

test('the workspace distribution beats a configured one', () => {
  // This is what makes the plugin general: the configured value is a fallback,
  // never an override, so one install serves every distribution.
  const target = resolveTarget(UNC, { store: {}, distro: 'Debian' })
  assert.equal(target.distro, 'Ubuntu-24.04')
  assert.equal(target.source, TARGET_SOURCE.UNC)
})

test('a registered drive workspace runs in WSL at its /mnt spelling', () => {
  const store = { 'c:\\users\\steaf\\proj': { distro: 'Ubuntu-24.04', username: 'steaf' } }
  const target = resolveTarget('C:\\Users\\steaf\\proj\\repo', { store })
  assert.equal(target.kind, 'wsl')
  assert.equal(target.distro, 'Ubuntu-24.04')
  assert.equal(target.user, 'steaf')
  assert.equal(target.linuxPath, '/mnt/c/Users/steaf/proj/repo')
  assert.equal(target.source, TARGET_SOURCE.DRIVE_WORKSPACE)
})

test('an unregistered drive path is an ordinary Windows workspace', () => {
  const target = resolveTarget('C:\\Users\\steaf\\plain', { store: {} })
  assert.equal(target.kind, 'local')
  assert.equal(target.source, TARGET_SOURCE.LOCAL)
  assert.equal(target.hostPath, 'C:\\Users\\steaf\\plain')
})

test('a configured distribution covers an unregistered drive path, and says so', () => {
  const target = resolveTarget('C:\\Users\\steaf\\plain', { store: {}, distro: 'Ubuntu-24.04' })
  assert.equal(target.kind, 'wsl')
  assert.equal(target.distro, 'Ubuntu-24.04')
  assert.equal(target.linuxPath, '/mnt/c/Users/steaf/plain')
  assert.equal(target.source, TARGET_SOURCE.CONFIGURED_DISTRO)
})

test('the Linux user resolves from the workspace, then config, then the environment', () => {
  const store = { '\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf': { username: 'fromstore' } }
  assert.equal(resolveTarget('\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf\\x', { store }).user, 'fromstore')
  // The workspace's own setting wins over a configured one.
  assert.equal(resolveTarget('\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf\\x', { store, user: 'fromconfig' }).user, 'fromstore')
  assert.equal(resolveTarget('\\\\wsl.localhost\\Ubuntu-24.04\\elsewhere', { store, user: 'fromconfig' }).user, 'fromconfig')
  // An invalid name is not a crash, it is simply not a user.
  assert.equal(resolveTarget('\\\\wsl.localhost\\Ubuntu-24.04\\elsewhere', { store: {}, user: '-rm -rf /' }).user, undefined)
  assert.equal(resolveTarget('\\\\wsl.localhost\\Ubuntu-24.04\\elsewhere', { store: {} }).user, undefined)
})

test('isValidWslUsername refuses anything that could be read as an option', () => {
  assert.equal(isValidWslUsername('steaf'), true)
  assert.equal(isValidWslUsername('_a.b-c'), true)
  assert.equal(isValidWslUsername('-root'), false)
  assert.equal(isValidWslUsername(''), false)
  assert.equal(isValidWslUsername('a b'), false)
})

test('describeTarget names the world a person reads', () => {
  assert.equal(describeTarget(resolveTarget(UNC, { store: {} })), 'Ubuntu-24.04:/home/steaf/workspace/device_xcar_1.0')
  assert.equal(describeTarget(resolveTarget(UNC, { store: {}, user: 'steaf' })), 'steaf@Ubuntu-24.04:/home/steaf/workspace/device_xcar_1.0')
  assert.equal(describeTarget(resolveTarget('C:\\plain', { store: {} })), 'local git in C:\\plain')
})

/* ============================== the registry file ============================== */

test('readWslWorkspaces tolerates a missing, corrupt or non-object file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wsl-git-'))
  try {
    // Absent: most installs have no /mnt workspace, and the plugin must load.
    assert.deepEqual(readWslWorkspaces(dir), {})

    writeFileSync(join(dir, 'wsl-workspaces.json'), '{"c:\\\\ws":{"distro":"Ubuntu-24.04"}}', 'utf8')
    assert.equal(readWslWorkspaces(dir)['c:\\ws']?.distro, 'Ubuntu-24.04')

    writeFileSync(join(dir, 'wsl-workspaces.json'), '{ this is not json', 'utf8')
    assert.deepEqual(readWslWorkspaces(dir), {})

    writeFileSync(join(dir, 'wsl-workspaces.json'), '["a list"]', 'utf8')
    assert.deepEqual(readWslWorkspaces(dir), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================== the transport ============================== */

test('gitProgramFor keeps the two worlds\u2019 overrides apart', () => {
  const wsl = { kind: 'wsl' }
  const local = { kind: 'local' }
  assert.equal(gitProgramFor(wsl, '', {}), 'git')
  assert.equal(gitProgramFor(local, '', {}), 'git')
  assert.equal(gitProgramFor(wsl, '/usr/bin/git', {}), '/usr/bin/git')
  assert.equal(gitProgramFor(local, 'C:\\git\\git.exe', {}), 'C:\\git\\git.exe')
  assert.equal(gitProgramFor(wsl, '', { DSH_WSL_GIT_BIN: '/opt/git' }), '/opt/git')
  assert.equal(gitProgramFor(local, '', { DSH_IDE_GIT_BIN: 'C:\\git.exe' }), 'C:\\git.exe')
  /* A Windows path set for one world must never be handed to the other: it would
     name nothing inside the distribution, and vice versa. */
  assert.equal(gitProgramFor(wsl, '', { DSH_IDE_GIT_BIN: 'C:\\git.exe' }), 'git')
  assert.equal(gitProgramFor(local, '', { DSH_WSL_GIT_BIN: '/opt/git' }), 'git')
})

test('buildWslArgv spells the call the way the working plugins do', () => {
  const target = { kind: 'wsl', distro: 'Ubuntu-24.04', linuxPath: '/home/steaf/ws' }
  assert.deepEqual(buildWslArgv(target, ['status', '--porcelain=v1', '-z'], 'git'), [
    WSL_EXE, '-d', 'Ubuntu-24.04',
    '-e', 'env', 'GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0',
    'git', '-C', '/home/steaf/ws',
    'status', '--porcelain=v1', '-z',
  ])
  // `-u` is a launcher option and sits before `-e`.
  assert.deepEqual(buildWslArgv({ ...target, user: 'steaf' }, ['--version'], 'git'), [
    WSL_EXE, '-d', 'Ubuntu-24.04', '-u', 'steaf',
    '-e', 'env', 'GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0',
    'git', '-C', '/home/steaf/ws', '--version',
  ])
})

test('the distribution is always named, never left to wsl.exe', () => {
  /* This host's default distribution is Ubuntu-20.04 while the workspace under
     test is Ubuntu-24.04, so dropping `-d` would run the wrong git against the
     wrong filesystem. */
  const argv = buildWslArgv({ kind: 'wsl', distro: 'Ubuntu-24.04', linuxPath: '/' }, ['status'], 'git')
  const index = argv.indexOf('-d')
  assert.ok(index >= 0, 'expected -d in the argv')
  assert.equal(argv[index + 1], 'Ubuntu-24.04')
})

test('arguments cross the boundary verbatim, with no shell to reinterpret them', () => {
  /* The whole reason for the argv (rather than a bash -lc script) shape: a commit
     message containing a quote, a newline, a `$` or a backtick is data, not code. */
  const message = 'fix: don\'t run `rm -rf $HOME`\n\nsecond line'
  const argv = buildWslArgv({ kind: 'wsl', distro: 'Ubuntu-24.04', linuxPath: '/ws' }, ['commit', '-m', message], 'git')
  assert.ok(argv.includes(message), 'the message must appear as ONE argv element')
  assert.equal(argv[argv.length - 1], message)
  assert.equal(argv.filter((entry) => entry === message).length, 1)
  // A path with a space is one element too.
  const spaced = buildWslArgv({ kind: 'wsl', distro: 'Ubuntu-24.04', linuxPath: '/home/my dir' }, ['add', '--', 'a b.txt'], 'git')
  assert.ok(spaced.includes('/home/my dir'))
  assert.ok(spaced.includes('a b.txt'))
})

test('a WSL spawn never uses the UNC workspace as its Windows cwd', () => {
  const target = resolveTarget(UNC, { store: {} })
  const spec = gitSpawnSpec(target, ['status'], 'git')
  /* Spawning a Windows child with a UNC working directory is a documented
     Node/Windows edge, and `git -C` already decides the Linux side. */
  assert.ok(!spec.options.cwd.startsWith('\\\\'), `cwd must not be a UNC path, got ${spec.options.cwd}`)
  assert.ok(!spec.options.cwd.startsWith('//'))
  assert.equal(spec.options.windowsHide, true)
  // UTF-16 diagnostics would be unreadable to every classifier downstream.
  assert.equal(spec.options.env.WSL_UTF8, '1')
  assert.equal(spec.argv[0], WSL_EXE)
})

test('a local spawn is byte-for-byte what the upstream plugin ran', () => {
  const target = resolveTarget('C:\\Users\\steaf\\plain', { store: {} })
  const spec = gitSpawnSpec(target, ['status'], 'git')
  assert.deepEqual(spec.argv, ['git', 'status'])
  assert.equal(spec.options.cwd, 'C:\\Users\\steaf\\plain')
  assert.equal(spec.options.env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(spec.options.env.GIT_TERMINAL_PROMPT, '0')
  // The WSL-only variable must not leak into the local world.
  assert.equal(spec.options.env.WSL_UTF8, undefined)
})

test('wslEnv adds WSL_UTF8 without dropping the environment Windows needs', () => {
  const env = wslEnv({ SystemRoot: 'C:\\Windows', PATH: 'x' })
  assert.equal(env.WSL_UTF8, '1')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.PATH, 'x')
})

/* ============================== argument-site mapping ============================== */

/* Upstream 0.15.0 introduced two calls that pass an absolute path as a git
 * ARGUMENT rather than reading one back from git's output: `clone`'s target
 * directory, and `diff --no-index`'s file for an untracked preview. `linuxToHost`
 * covers the output direction; `linuxPathOf` is its inverse, and the round trip
 * between them is the invariant that keeps a rebase honest — a new upstream call
 * that passes a path as an argument reintroduces exactly the defect this fork
 * exists to remove. */

test('linuxPathOf spells an argument the way the world that runs git spells it', () => {
  const target = resolveTarget(UNC, { store: {} })
  // The workspace itself, a file inside it, and a deeper path.
  assert.equal(linuxPathOf(target, UNC), '/home/steaf/workspace/device_xcar_1.0')
  assert.equal(linuxPathOf(target, UNC + '\\src\\main.c'), '/home/steaf/workspace/device_xcar_1.0/src/main.c')
  assert.equal(linuxPathOf(target, UNC_SLASHED + '/a/b'), '/home/steaf/workspace/device_xcar_1.0/a/b')
  // No doubled separator, whatever spelling came in.
  assert.equal(linuxPathOf(target, UNC + '\\'), '/home/steaf/workspace/device_xcar_1.0')
})

test('linuxPathOf round-trips with linuxToHost inside the target root', () => {
  const target = resolveTarget(UNC, { store: {} })
  const reported = '/home/steaf/workspace/device_xcar_1.0/src/main.c'
  // git prints the Linux spelling; the host maps it out and back again unchanged.
  const host = linuxToHost(reported, 'Ubuntu-24.04')
  assert.equal(host, UNC + '\\src\\main.c')
  assert.equal(linuxPathOf(target, host), reported)
})

test('linuxPathOf leaves a local target alone and refuses the unmappable', () => {
  const local = resolveTarget('C:\\Users\\steaf\\plain', { store: {} })
  // A local world already speaks host paths: the same string is the right answer.
  assert.equal(linuxPathOf(local, 'C:\\Users\\steaf\\plain\\a.txt'), 'C:\\Users\\steaf\\plain\\a.txt')

  const target = resolveTarget(UNC, { store: {} })
  /* Outside the workspace but on a drvfs mount: still expressible, and it MUST go
     through the drive letter — the 9P share answers EPERM for /mnt. */
  assert.equal(linuxPathOf(target, 'C:\\Users\\steaf\\other'), '/mnt/c/Users/steaf/other')
  /* Outside both: another distribution's filesystem has no spelling this world can
     open. Null, so the caller refuses it by name instead of handing git nonsense. */
  assert.equal(linuxPathOf(target, UNC_OTHER_DISTRO), null)
  // Degenerate input is a null, not a throw.
  assert.equal(linuxPathOf(target, ''), null)
  assert.equal(linuxPathOf(null, 'C:\\x'), null)
})

/* ============================== failure classification ============================== */

test('a launcher failure is named instead of being read as "not a repository"', () => {
  const target = { kind: 'wsl', distro: 'Ubuntu-24.04' }
  // The code is locale-independent, unlike the message around it.
  const missing = launcherFailureOf(target, { code: -1, stdout: '', stderr: 'Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n' })
  assert.equal(missing?.code, 'wsl-distro-missing')
  assert.match(missing.message, /Ubuntu-24\.04/)

  // Observed on this host when a sandboxed process ran `wsl.exe -e`.
  const denied = launcherFailureOf(target, { code: -1, stdout: '', stderr: '出现了错误。 Wsl/E_ACCESSDENIED 由于权限问题' })
  assert.equal(denied?.code, 'wsl-launcher')
  assert.match(denied.message, /E_ACCESSDENIED/)

  assert.equal(launcherFailureOf(target, { code: 0, stdout: 'ok', stderr: '' }), null)
  // git's own complaint must NOT be misread as an infrastructure failure.
  assert.equal(launcherFailureOf(target, { code: 128, stdout: '', stderr: 'fatal: not a git repository' }), null)
})

test('a UTF-16 diagnostic is still classified', () => {
  /* WSL_UTF8 is the fix; this is the belt to its braces, because the launcher's
     own errors are emitted before the variable is honoured. */
  const utf16AsUtf8 = 'W\0s\0l\0/\0S\0e\0r\0v\0i\0c\0e\0/\0W\0S\0L\0_\0E\0_\0D\0I\0S\0T\0R\0O\0_\0N\0O\0T\0_\0F\0O\0U\0N\0D\0'
  assert.equal(normalizeDiagnostic(utf16AsUtf8), 'Wsl/Service/WSL_E_DISTRO_NOT_FOUND')
  const failure = launcherFailureOf({ distro: 'Ubuntu-24.04' }, { code: -1, stdout: '', stderr: utf16AsUtf8 })
  assert.equal(failure?.code, 'wsl-distro-missing')
})

test('git missing inside the distribution is reported as such', () => {
  const target = { kind: 'wsl', distro: 'Ubuntu-24.04' }
  const missing = remoteGitMissingOf(target, { code: 127, stdout: '', stderr: 'execvpe(git) failed: No such file or directory' })
  assert.equal(missing?.code, 'git-missing')
  assert.match(missing.message, /Ubuntu-24\.04/)

  /* The false-positive guard: git legitimately says "No such file or directory"
     about a path the user typed, and that must stay git's own answer. */
  assert.equal(remoteGitMissingOf(target, { code: 128, stdout: '', stderr: "fatal: cannot change to '/gone': No such file or directory" }), null)
  assert.equal(remoteGitMissingOf(target, { code: 127, stdout: '', stderr: 'something else entirely' }), null)
  assert.equal(remoteGitMissingOf(target, { code: 0, stdout: 'ok', stderr: '' }), null)
})
