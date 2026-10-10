# dsh-wsl-git

An IDE-grade Git tool window for DeepSeek Harness that runs `git` **inside the WSL
distribution the session workspace belongs to**.

Fork of [`dsh-ide-git`](https://github.com/KannaKuron/dsh-ide-git) 0.15.0 (MIT). The
panel — branch tree, commit graph, changes, staging, commit detail, stash, tags, the
AI commit message — is unchanged. What changed is the execution world of `git`.

---

## Why this fork exists

The upstream plugin spawns the local `git` with `node:path`'s Windows semantics. For a
WSL workspace that produced exactly two wrong answers, depending on where the
repository lived:

| Repository | What the upstream panel did |
|---|---|
| on the distribution's own filesystem (`/home/you/proj`) | handed Windows git the workspace path as a UNC path it cannot use as a working tree → **"not a git repository"** for a repository that exists |
| on a Windows drive (`/mnt/c/...`) | read the repository, but with the **Windows** git: WSL-side configuration, credentials and hooks did not apply |

Measured before the fork, through the panel's own route on this machine:

```
POST /dsh-ide-git/api/repos   {"cwd":"\\\\wsl.localhost\\Ubuntu-24.04\\home\\steaf\\workspace\\device_xcar_1.0"}
→ {"ok":false,"error":{"code":"not-a-repo","message":"not a git repository: …"}}
```

The repository is real: `git rev-parse --show-toplevel` answers
`/home/steaf/workspace/device_xcar_1.0` inside the distribution.

---

## The design

### The path contract

**Every path that crosses the HTTP boundary — in either direction — is spelled the way
the HOST names it**, which is the same spelling DSH stores as the session workspace.
A Linux path lives only inside the spawn boundary.

That is what keeps `sameDirectory`, `pathIdentity`, the repository picker and the
client's per-session remembered repository all comparing one identity, and it is why
the client never has to know which world it is talking to.

```
session workspace  \\wsl.localhost\<distro>\<linux>      (or  C:\… for a /mnt workspace)
   │  client scope.cwd  →  POST cwd / repoRoot
   ▼
requireAbsolute  ── refuses a Linux path BY NAME (path.resolve('/home/x') would
   │                 silently become C:\home\x, a path that names nothing)
   ▼
resolveTarget(cwd)  ──┬─► local : spawn('git', …)                unchanged from upstream
                      └─► wsl   : spawn('wsl.exe', -d <distro> … -e env GIT_* git -C <linux> …)
                                     │
                                     ▼
                          only the 5 fields git defines as ABSOLUTE are mapped back:
                          --show-toplevel · --absolute-git-dir · worktree list ·
                          submodule --show-toplevel · scanRepos' own toplevel
```

Rewriting a whole stdout stream instead would corrupt file content: a diff body may
legitimately contain an absolute Linux path.

### Which distribution — the workspace decides

Nothing is hard-coded, which is what makes one install serve every distribution:

1. **A WSL UNC path names its own distribution.** `\\wsl.localhost\Ubuntu-24.04\…` →
   `Ubuntu-24.04`. Nothing else is consulted; configuration never overrides this.
2. **A registered drive workspace** belongs to the distribution in
   `<DSH_HOME>/wsl-workspaces.json` (`dsh-wsl-workspace` writes it), at its
   `/mnt/<drive>` spelling.
3. **A configured `distro`** covers a drive path nothing registered. Off by default.
4. **Anything else is local**: the Windows `git`, byte-for-byte as upstream ran it.

The registry lookup is by **containment** (the longest registered key that contains the
path), not equality. Discovery resolves the *workspace*, but nearly every later call
passes the *repo root* git reported — the workspace itself, a subdirectory of a
container workspace, or a submodule at any depth. An equality-only lookup misses there
and the miss is silent: a drive path would drop back to the Windows git, and a UNC path
would lose the workspace's configured Linux user.

### The two spellings of a Linux path

```js
linuxToHost(p, distro) = mntToWindowsPath(p) ?? joinUnc(distro, p)
```

The split is not cosmetic. The 9P share that serves `\\wsl.localhost\…` covers only the
distribution's **ext4** volume; a drvfs mount answers Access denied there — measured on
this machine:

```
readdirSync('\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\c')  → EPERM
readdirSync('C:\\')                                     → 34 entries
```

So `/mnt/<drive>/…` must travel as its drive letter, which is also how DSH registers a
`/mnt` workspace in the first place.

### The transport

```js
['wsl.exe', '-d', <distro>, ?('-u', <user>), '-e', 'env',
 'GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0',
 <git>, '-C', <linuxPath>, ...gitArgs]
// child cwd: %SystemRoot%   — never the UNC workspace
// child env: WSL_UTF8=1     — or wsl.exe answers in UTF-16
```

Three decisions, each with a reason:

* **`-d` is never omitted.** This machine's default distribution is Ubuntu-20.04 while a
  workspace under test is Ubuntu-24.04; letting `wsl.exe` choose runs the wrong git
  against the wrong filesystem.
* **`git -C <dir>`, not `wsl.exe --cd <dir>`.** `--cd` needs a new enough `wsl.exe`;
  `-C` needs only git. It also keeps the whole call an argv array with **no shell**, so a
  commit message containing a quote, a newline or a `$` crosses the boundary as data.
  (`dsh-wsl-tool` and `dsh-wsl-workspace` use `-e bash -lc`/`--cd`; both shapes work —
  this one is chosen for the argv guarantee.)
* **The git environment travels as `-e env KEY=VALUE`**, not through `WSLENV`. That keeps
  the mutation local to one call instead of editing a variable the user and every other
  plugin share.

### Failures are named

The whole point of the fork: a failure of the **launcher** must never be read as git's
answer about the repository.

| Situation | Upstream said | This says |
|---|---|---|
| distribution not registered | `not a git repository` | `wsl-distro-missing` — names the distribution, suggests `wsl -l -v` |
| WSL service unhealthy | `not a git repository` | `wsl-launcher` — carries the locale-independent `Wsl/…` code |
| git not installed in the distribution | `not a git repository` | `git-missing` — names the distribution and how to install it |
| `cwd` is a Linux path | silently resolved to `C:\home\…` | `bad-request` — refused by name |

---

## Layout

| Path | Role |
|---|---|
| `src/target.js` | pure: UNC parsing, both path mappings, registry lookup, target resolution |
| `src/wsl-git.js` | pure: the argv, the spawn spec, failure classification |
| `src/index.js` | the HTTP surface; the ONE spawn path (`runGitTarget`) and the absolute-path mapping sites |
| `src/client.js` | the panel (upstream) + `displayPath`/`workspaceLocation` and a separator-aware `baseName` |
| `tests/target.test.mjs` | 35 pure assertions — the decisions |
| `scripts/acceptance.mjs` | the live run — the transport, the mapping, and the HTTP surface |

Dependency direction is one-way: `index.js` → {`target.js`, `wsl-git.js`} → node builtins.

---

## Verify

```bash
node --test tests/target.test.mjs     # the decisions (no WSL host needed)
node scripts/acceptance.mjs           # the live transport + the panel's own route
node scripts/acceptance.mjs --workspace '\\wsl.localhost\Ubuntu-24.04\home\you\proj'
```

`scripts/acceptance.mjs` is read-only — no method it calls mutates a repository. It
discovers the WSL workspaces DSH has registered, so on a machine that has them it needs
no arguments; the HTTP half is skipped when the harness is not reachable.

---

## Install / remove

```powershell
$dsh = "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add "link:<this directory>"
```

`link:` (rather than `file:`) symlinks the package, so edits to either half are live —
the client half after a page refresh, the host half after a restart (see below).

### The host half does not hot-reload

DSH picks up a newly added bundle without a restart, but **editing an already-mounted
host module does not re-import it** — measured: a fix to `src/index.js` stayed invisible
to the running host while the same route answered from the new code after a restart.
Reload it from the app: **Settings → Plugins → Restart now**, or toggle this plugin off
and on. The client half only needs a page refresh.

### Remove the upstream plugin

Both plugins register their own Git tab. Leaving `dsh-ide-git` bundled shows two Git
tabs, and one of them is broken in a WSL workspace. Remove it once this one is verified:

```powershell
& $dsh plugin --profile desktop remove dsh-ide-git
```

Reverting is `add dsh-ide-git` again — the profile's `package.json`, `cordis.patch.yml`
and `pnpm-lock.yaml` are backed up beside themselves as `*.dsh-wsl-git-backup-<stamp>`.

---

## Known limits

* **Upstream is followed by hand.** This release is rebased onto 0.15.0. Upstream
  changes after that are not merged automatically, and the part a rebase can
  silently invalidate is named in [PUBLISHING.md](PUBLISHING.md): a new upstream
  call that passes or reports an ABSOLUTE path needs a mapping, and the two
  argument-direction sites upstream 0.15.0 introduced are why.
* **Host-side filesystem access goes over 9P** for an ext4 repository: repository
  discovery (`findNestedRepos`, depth 2) and the discard-undo snapshots read through
  `\\wsl.localhost\…`. Measured on this machine that is cheap — `existsSync` 2–3 ms,
  `realpathSync` 7–9 ms, a 22-directory `.git` scan 44 ms — so the scan was deliberately
  left on the host. A workspace with far more entries would be the case to re-measure.
* **The discard undo verifies its own writes.** `undoApply` reads every restored file
  back and compares hashes, because inside WSL those writes land through the 9P share and
  the snapshot is the user's only copy of the discarded bytes. On a mismatch it throws and
  **leaves the undo entry on the stack**, so the cause can be fixed and the restore retried
  instead of the bytes being lost to a consumed handle.
* **`version` gained `world` and `target`.** Superset of the upstream response; the
  panel's own client does not call it.
