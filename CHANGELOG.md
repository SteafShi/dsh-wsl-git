# Changelog

This file records changes against the upstream baseline. The baseline's own
documentation is preserved verbatim as [README.upstream.md](README.upstream.md)
and [README.upstream.en.md](README.upstream.en.md).

**Baseline:** [`dsh-ide-git@0.15.0`](https://registry.npmjs.org/dsh-ide-git/-/dsh-ide-git-0.15.0.tgz)
— MIT, Copyright (c) 2026 KannaKuron.

---

## 0.15.0-wsl — rebased onto upstream 0.15.0

The first release on the **0.15.0** baseline (0.14.0 was built on 0.13.5). The
panel is still the baseline's, unmodified, and the WSL execution layer is
unchanged — what this release adds is the reconciliation with everything upstream
changed in between, plus the mapping direction that reconciliation turned out to
require.

### Added — the argument direction of the path contract

Upstream 0.15.0 introduced **two calls that pass an ABSOLUTE path as a git
argument**, where every earlier call only ever read one back from git's output:

| Upstream call | What it passes |
|---|---|
| `clone` (new in 0.15.0) | the target directory, as `git clone <url> <dir>` |
| `diff` with `untracked: true` (new in 0.15.0) | the file, as `git diff --no-index -- /dev/null <file>` |

`hostPathOf` maps git's *output* into the host spelling; these needed its
**inverse**. Handing the distribution's git the Windows or UNC spelling of a path
inside its own filesystem names nothing, and the failure is quiet — an empty
patch, or a `not a git repository` about a directory that is one.

- `linuxPathOf` in `src/target.js` — pure, beside its inverse, returning `null`
  when a path has no spelling this world can open (another distribution's
  filesystem) so the caller can refuse it by name.
- `linuxSpellingOf` in `src/index.js` — the throwing form, for the two callers.
- `clone` and the untracked-`diff` branch now spell their argument the way the
  world that runs git spells it. The untracked branch uses **one** spelling for
  both the argument and the header rewrite, which matches it literally; using two
  would have left an absolute path in the preview's header.
- 3 new assertions, including the invariant that makes a rebase safe:
  `linuxPathOf(host spelling) === what git itself reported`.

### Added — carried from upstream 0.15.0

The rebase brings in everything upstream shipped between the two baselines, with
the WSL layer applied to each: two-phase changes (`stats` / `statsDeferred`,
which skips the two `numstat` passes and fetches them separately), concurrent
read chains in `summary`, the untracked-file diff preview, the `clone` method,
the bounded "Git output" ring buffer (`gitLogs`, `GIT_LOG_MAX_ENTRIES = 200`) and
the immersive conversation seat. The ring buffer names the world a run happened
in — `[Ubuntu-24.04] status --porcelain` — because the same git arguments now
mean different programs, and that is the first question a bug report asks.

### Changed

- Rebased onto `dsh-ide-git@0.15.0`; `README.upstream.md` and
  `README.upstream.en.md` are re-synced with that baseline (verified identical to
  the published tarball).
- Version `0.15.0-wsl` in `package.json` and `dsh.plugin.json`.

### Verification

- 38 assertions (`node --test tests/target.test.mjs`), up from 35.
- The live run now checks the argument direction end to end: a real
  `git diff --no-index -- /dev/null <absolute>` inside the distribution, plus the
  cross-check of `linuxPathOf` against git's own `--absolute-git-dir` output.
- The ~40 untouched call sites still pass through one spawn path, so the
  reconciliation is confined to the 5 output sites and the 2 argument sites.

### Known issue (not fixed here)

This machine intermittently stalls a `wsl.exe` launch. Measured: a call typically
returns in **256–300 ms** (stable across idle gaps of 25 s and across bursts), yet
three runs out of roughly ten saw a single call exceed the 30 s per-call deadline
and land as `git-timeout` — on `rev-parse` and `rev-list`, i.e. on trivial calls.
It is **not** concurrency (9 concurrent calls: 420–494 ms, no stall) and **not**
idle-wakeup (first call after 25 s idle: 256–300 ms), and it does not reproduce on
demand. It is recorded rather than papered over: no retry or timeout tuning was
shipped for a condition that could not be reproduced, because a speculative fix
for an unknown stall is more likely to hide it than to cure it.

---

## 0.14.0 — WSL execution

First release of this patch, on the `dsh-ide-git@0.13.5` baseline. The panel is
the baseline's, unmodified; the change is where `git` runs.

### Added

- **WSL execution world.** `git` runs inside the distribution the session
  workspace belongs to, addressed as
  `wsl.exe -d <distro> [-u <user>] -e env GIT_* <git> -C <linuxPath> <args…>`.
  The distribution is resolved from the workspace path — a WSL UNC path names its
  own distribution — so no configuration is required and one install serves every
  distribution.
- `src/target.js` — pure functions: WSL UNC parsing, `linuxToHost` /
  `hostToLinux` translation, registry lookup by longest containing key, and target
  resolution with a `source` field so the reason a target resolved is observable.
- `src/wsl-git.js` — pure functions: the `wsl.exe` argv, the spawn spec, and the
  failure classifiers.
- `hostPathOf()` in `src/index.js`, applied at the **five** sites where git
  defines an output field as an absolute path: `repoRootOf` (`--show-toplevel`),
  `worktreesOf` (`worktree list`), `operationOf` (`--absolute-git-dir`),
  `collectSubmoduleRepos` (submodule `--show-toplevel`), and `scanRepos` (its own
  discovery `--show-toplevel`).
- Client-side `distroOf`, `displayPath` and `workspaceLocation`, so labels show
  `Ubuntu-24.04 · /home/you/proj` with the raw host path on hover.
- Settings: `distro`, `user`, `gitPath` — all default empty, meaning "the
  workspace decides". Configuration never overrides a workspace that names its
  own distribution; it only covers a drive path that nothing registered.
- `version` reports `world` (`wsl` | `local`) and a human-readable `target`.
- `tests/target.test.mjs` — 35 assertions over the pure contract.
- `scripts/acceptance.mjs` — read-only live run: the transport, the mapping loop,
  and the panel's own HTTP route.

### Changed

- `runGit(cwd, args)` now resolves the execution world from `cwd` and delegates
  to `runGitTarget(target, args)`. It remains the single spawn path, so the ~40
  call sites in the baseline are untouched.
- `requireAbsolute` **refuses** a Linux absolute path
  (`cwd must be a host path …, not a Linux path`). The baseline accepted one and
  `path.resolve('/home/x')` silently produced `C:\home\x`, a path that names
  nothing — every later filesystem call missed without saying so.
- `undoApply` reads every restored file back and compares hashes before reporting
  success. Inside WSL those writes reach the repository through the 9P share, and
  the snapshot is the user's only copy of the discarded bytes; on a mismatch it
  throws and **leaves the undo entry on the stack** so the cause can be fixed and
  the restore retried.
- `baseName` / `dirName` normalize `\` to `/` before splitting. The baseline split
  on `/` alone, so a UNC repository root came back as a name that was the entire
  path.
- Identifiers renamed across both halves (41 occurrences): plugin id, route
  prefix (`/dsh-wsl-git/api`), `API_BASE`, `TAB_ID`, `NATIVE_ID`,
  `SETTINGS_BUNDLE`, `LOCALE_NS`, every localStorage prefix and every effect/log
  label. The cordis row id is `wsl-git`, not `ide-git`: settings are persisted
  under the row id, so sharing it would make the two plugins read and write one
  document.
- `files` in `package.json` lists the whole `src/` directory. The baseline listed
  `src/index.js` and `src/client.js` individually, which would drop this patch's
  new modules from a packed install.
- Routes, methods, request bodies and the client contract are otherwise
  unchanged: `cwd`, `repoRoot` and `paths` keep their meaning, and every path
  crossing the boundary is still the host spelling.

### Fixed (relative to the baseline's behaviour in a WSL workspace)

- An unregistered distribution is reported as `wsl-distro-missing` instead of
  `not a git repository`.
- An unhealthy WSL service is reported as `wsl-launcher`, carrying the
  locale-independent `Wsl/…` code.
- git missing inside the distribution is reported as `git-missing`, naming the
  distribution and how to install it.
- A merge, rebase, cherry-pick, revert or bisect in progress inside a WSL
  repository is detected again. The baseline's `existsSync` ran against a Linux
  git directory path, which on Windows names nothing, so the check silently
  answered "no operation in progress".
- Repository discovery works in a WSL workspace at all: the baseline handed
  Windows git a UNC path it cannot use as a working tree.

### Unchanged

The panel UI and layout algorithm; the commit graph; the branch tree; the change
list; the diff viewer; the context menus; the "send to chat" wiring; the AI
commit-message feature; all 21 locale dictionaries; and every safety semantic —
confirmation guards, per-repository write serialization, the undo stack,
protected branches, and argument validation.

### Compatibility

- `engines.dsh` and the `@deepseek-ai/dsh` peer range are inherited from the
  baseline unchanged.
- `dsh-better-sidebar` stays an optional peer: without it the panel mounts into
  DSH's native right sidebar.
- Windows-only in effect. On a POSIX host every workspace resolves to the local
  world and behaviour is the baseline's; the WSL code paths are unreachable.

### Verification

- `node --test tests/target.test.mjs` — 35 assertions, no WSL host required.
- `node scripts/acceptance.mjs` — live: `git 2.43.0` inside Ubuntu-24.04 and
  `git 2.25.1` inside Ubuntu-20.04, each toplevel mapping back to a host-readable
  path that re-resolves to the same world, the git directory readable for
  merge/rebase markers, and `version` / `repos` / `summary` / `branches` / `log` /
  `stashList` / `undoList` answering 200 over the panel's own route.
- Two development-time defects are pinned by positive/negative regression
  assertions rather than left to the live run: a missing mapping in `scanRepos`
  (measured as `repos` failing with `cannot run git: spawn git ENOENT` while every
  method that already mapped its paths worked), and the negative control for it —
  that a raw Linux path resolves to the LOCAL world, which is exactly the wrong
  answer the missing mapping produced. See [FORK.md](FORK.md).
