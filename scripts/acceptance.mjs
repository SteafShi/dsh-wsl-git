/**
 * dsh-wsl-git — acceptance run.
 *
 * The unit suite (tests/target.test.mjs) proves the DECISIONS. This proves the
 * two things a unit test cannot: that the argv actually reaches a distribution's
 * own git, and that the paths it prints come back in a spelling the host can
 * read. Both are the failure modes this fork exists for, and both are silent
 * when they break — a wrong world answers "not a git repository" about a
 * repository that exists.
 *
 * READ-ONLY: no method called here mutates a repository.
 *
 * Usage (from the package root):
 *
 *   node scripts/acceptance.mjs
 *   node scripts/acceptance.mjs --distro Ubuntu-24.04 --workspace '\\wsl.localhost\Ubuntu-24.04\home\me\proj'
 *
 * With `--workspace` omitted it uses the workspaces DSH has registered, so on a
 * machine with WSL workspaces it needs no arguments. The HTTP half is skipped
 * when the harness is not reachable at --origin.
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { describeTarget, linuxPathOf, linuxToHost, readWslWorkspaces, resolveTarget } from '../src/target.js'
import { gitProgramFor, gitSpawnSpec, launcherFailureOf, remoteGitMissingOf } from '../src/wsl-git.js'

/* ============================== args ============================== */

function argOf(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const ORIGIN = argOf('origin', 'http://127.0.0.1:19387')
const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
const STORE = readWslWorkspaces(DSH_HOME)

/** The workspaces to check: the ones given, or every WSL one DSH knows about. */
function workspacesFromEnvironment() {
  const explicit = argOf('workspace', null)
  if (explicit !== null) return [explicit]
  const found = []
  for (const key of Object.keys(STORE)) {
    const target = resolveTarget(key, { store: STORE })
    // For a `/mnt` key the registered path is the workspace itself; for a UNC key
    // it is too. Either way the key resolves, so use it as-is.
    if (target.kind === 'wsl') found.push(key)
  }
  if (found.length === 0) {
    // Nothing registered by the WSL plugin: fall back to the workspace registry,
    // which is where a UNC workspace added from the GUI is recorded.
    try {
      const store = JSON.parse(readFileSync(path.join(DSH_HOME, 'storages', 'workspace.json'), 'utf8'))
      for (const entry of Object.values(store?.tables?.workspaces ?? {})) {
        if (typeof entry?.path === 'string' && resolveTarget(entry.path, { store: STORE }).kind === 'wsl') found.push(entry.path)
      }
    } catch { /* no workspace registry: the caller must pass --workspace */ }
  }
  return found
}

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${condition ? '' : ' — ' + (detail === undefined ? '' : JSON.stringify(detail))}`)
}
function note(label, value) {
  console.log(`  ${String(label).padEnd(18)} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/* ============================== 1. the transport ============================== */

/** Run argv to completion, resolving for any exit code. */
function run(spec) {
  return new Promise((resolve) => {
    const child = spawn(spec.argv[0], spec.argv.slice(1), spec.options)
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => resolve({ code: -1, stdout: '', stderr: String(error.message), error }))
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }))
  })
}

async function gitIn(target, args, program = gitProgramFor(target, '')) {
  return run(gitSpawnSpec(target, args, program))
}

const workspaces = workspacesFromEnvironment()
console.log(`\n### 1. the transport — which git answers, per workspace`)
console.log(`  registry: ${DSH_HOME}\\wsl-workspaces.json (${Object.keys(STORE).length} entries), ${workspaces.length} WSL workspace(s)`)
if (workspaces.length === 0) {
  console.log('  [SKIP] no WSL workspace found; pass --workspace to name one')
}

const resolved = []
for (const hostPath of workspaces) {
  const target = resolveTarget(hostPath, { store: STORE })
  console.log(`\n  --- ${hostPath}`)
  note('target', describeTarget(target))
  if (target.kind !== 'wsl') { check('resolves to a WSL world', false, target.kind); continue }
  resolved.push({ hostPath, target })

  const version = await gitIn(target, ['--version'])
  note('git', (version.stdout || version.stderr).trim())
  const failure = launcherFailureOf(target, version) ?? remoteGitMissingOf(target, version)
  if (failure !== null) { check('git answered (no launcher failure)', false, failure.message); continue }
  check('git answered inside the distribution', version.code === 0 && /^git version /.test(version.stdout.trim()), version.stdout)

  const top = await gitIn(target, ['rev-parse', '--show-toplevel'])
  /* "Not a repository" is a NORMAL state for this panel — it answers with a repo
     picker, not an error — so it is reported, not failed. What would be a failure
     is the launcher talking instead of git, and that was already checked above. */
  if (top.code !== 0) {
    note('toplevel', 'not a git repository (a normal state; the panel shows its repo picker)')
    continue
  }
  const reported = top.stdout.trim()
  note('toplevel', reported)
  check('the workspace is a repository', reported !== '', reported)

  /* The loop that a missing mapping breaks: git answers in its own world, and the
     answer has to come back in one the host can read. */
  const mapped = linuxToHost(reported, target.distro)
  check('the reported path maps to a host spelling', typeof mapped === 'string' && mapped !== '', mapped)
  check('the host can stat the mapped path', mapped !== null && existsSync(mapped) === true, mapped)
  if (mapped !== null && existsSync(mapped)) {
    const entries = (() => { try { return readdirSync(mapped).length } catch { return -1 } })()
    check('the host can list the mapped path', entries >= 0, entries)
  }
  const again = resolveTarget(String(mapped), { store: STORE })
  check('the mapped path resolves to the SAME world', again.kind === 'wsl' && again.distro === target.distro && again.linuxPath === reported,
    describeTarget(again))

  /* The git directory is what `operationOf` stats for a merge/rebase in progress. */
  const gitDir = await gitIn(target, ['rev-parse', '--absolute-git-dir'])
  if (gitDir.code === 0 && gitDir.stdout.trim() !== '') {
    const mappedGitDir = linuxToHost(gitDir.stdout.trim(), target.distro)
    check('the git directory is readable from the host (merge/rebase markers)',
      mappedGitDir !== null && existsSync(path.join(mappedGitDir, 'HEAD')) === true, mappedGitDir)

    /* Ground truth for the INVERSE mapping. git just told us the Linux spelling of
       the repository's git directory; mapping the host spelling back must land on
       exactly that string. This is the invariant a rebase can silently break — and
       it needs no fixture, because git is the reference. */
    check('host -> Linux mapping agrees with git itself (linuxPathOf == git output)',
      linuxPathOf(target, String(mappedGitDir)) === gitDir.stdout.trim(),
      `mapped=${linuxPathOf(target, String(mappedGitDir))} git said=${gitDir.stdout.trim()}`)

    /* The ARGUMENT direction, introduced by upstream 0.15.0: `diff`'s untracked
       preview passes an ABSOLUTE path as a git argument. Exercised for real and
       read-only, using a file that always exists. Exit 1 means "differences
       found", which is data rather than failure — the same rule the route applies. */
    const probeFile = gitDir.stdout.trim() + '/HEAD'
    const probe = await gitIn(target, ['diff', '--no-color', '--no-ext-diff', '-U3', '--no-index', '--', '/dev/null', probeFile])
    check('an absolute path passed AS AN ARGUMENT reaches the file (diff --no-index)',
      (probe.code === 0 || probe.code === 1) && /^diff --git /m.test(probe.stdout) && probe.stdout.includes(probeFile),
      `exit=${probe.code} stderr=${probe.stderr.trim().slice(0, 120)}`)
  }
}

/* ============================== 2. the HTTP surface ============================== */

console.log(`\n### 2. the HTTP surface — the panel's own route, at ${ORIGIN}`)

const PLUGIN = 'dsh-wsl-git'
async function call(method, payload) {
  const response = await fetch(`${ORIGIN}/${PLUGIN}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, body }
}

const first = resolved[0]
if (first === undefined) {
  console.log('  [SKIP] no WSL workspace to drive the API with')
} else {
  let reachable = true
  try {
    const probe = await call('version', { cwd: first.hostPath })
    reachable = probe.status === 200
    note('version', probe.body?.data)
    check('the panel route answers and names the WSL world', probe.body?.data?.world === 'wsl', probe.body)
    check('it reports the distribution the workspace names',
      String(probe.body?.data?.target ?? '').includes(first.target.distro), probe.body?.data?.target)
  } catch (error) {
    reachable = false
    console.log(`  [SKIP] ${ORIGIN} is not reachable (${String(error.message).slice(0, 60)}); start the harness to check the HTTP half`)
  }

  if (reachable) {
    /* `cwd` and `repoRoot` are the two paths the browser sends, in the spellings
       it actually produces: the workspace as stored, and a repo row as the host
       slash-normalized it. */
    const repos = await call('repos', { cwd: first.hostPath })
    note('repos', repos.body?.data?.repos?.map((row) => row.kind + ' ' + row.path))
    check('discovery finds the workspace as a repository', repos.body?.data?.isRepo === true, repos.body)

    const repoRoot = repos.body?.data?.repos?.[0]?.path
    check('a discovered row carries the host spelling', typeof repoRoot === 'string' && repoRoot !== '', repoRoot)

    for (const method of ['summary', 'branches', 'log', 'stashList', 'undoList']) {
      const answer = await call(method, { cwd: first.hostPath, repoRoot, limit: 5 })
      check(`${method} answers`, answer.status === 200 && answer.body?.ok === true, answer.body)
    }

    /* The failure that used to be reported as "not a git repository". */
    const bogus = await call('repos', { cwd: '\\\\wsl.localhost\\NoSuchDistribution\\home\\x' })
    check('an unregistered distribution is named, not mistaken for a missing repository',
      bogus.body?.error?.code === 'wsl-distro-missing', bogus.body)

    const linuxPath = await call('repos', { cwd: '/home/x' })
    check('a Linux path is refused by name at the boundary',
      linuxPath.body?.error?.code === 'bad-request' && /not a Linux path/.test(String(linuxPath.body?.error?.message)), linuxPath.body)
  }
}

console.log(`\n${failures === 0 ? 'ACCEPTANCE PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
