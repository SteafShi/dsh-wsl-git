# Releasing

Maintainer notes. Everything here was checked on the machine this release was cut
on; the caveats are ones that were actually hit rather than anticipated.

**The distribution channel is GitHub, not npm.** npm publishing was dropped, so
this file describes the GitHub flow and nothing else.

## Pre-flight

```sh
node --test tests/target.test.mjs     # 38 pure assertions
node scripts/acceptance.mjs           # live: transport, both mapping directions, the HTTP route
git status --porcelain                # must be empty
```

Then confirm the surface that ships, by listing it rather than trusting the list:

```sh
tar -tzf dsh-wsl-git-0.15.0-wsl.tgz | sort
```

## How users install it

```sh
dsh plugin --profile desktop add github:SteafShi/dsh-wsl-git
# pinned to a release, which is what a bug report should quote:
dsh plugin --profile desktop add github:SteafShi/dsh-wsl-git#v0.15.0-wsl
```

pnpm resolves the **default branch** for an unpinned spec, so whatever is on
`main` is what an unpinned user gets. Cut a tag per release.

## ⚠️ Credentials: the cached account cannot write to this repository

Measured, on the first push attempt:

```
remote: Permission to SteafShi/dsh-wsl-git.git denied to Neptune-steaf.
fatal: unable to access 'https://github.com/SteafShi/dsh-wsl-git.git/': The requested URL returned error: 403
```

Git Credential Manager holds a credential for a **different GitHub account**
(`Neptune-steaf`), which has no write access to `SteafShi/dsh-wsl-git`. Reading the
repository works — it is public — so `git ls-remote` succeeds and the failure only
appears on push. Re-authenticate as the repository's owner before pushing:

```powershell
git credential-manager github logout        # or: git credential reject, then re-auth
git push -u origin main                     # GCM prompts for the SteafShi account
```

A fine-grained PAT with *Contents: read and write* on this repository also works,
and is the better option on a machine shared by several accounts:

```powershell
git remote set-url origin https://<user>:<token>@github.com/SteafShi/dsh-wsl-git.git
```

## Network

`github.com` resolves to `198.18.0.30` here — a benchmarking range, i.e. a
transparent local proxy — and requests through it are **occasionally flaky**: one
`fetch` to `github.com` failed outright while the next succeeded, and
`registry.npmjs.org` was unaffected. `git ls-remote` and `git fetch` both worked.
Retry a failed network step once before diagnosing it.

## Cutting a release

1. **Version in both places.** `package.json` and `dsh.plugin.json` carry it
   independently (the baseline shipped them in sync; keep them that way).
2. **Regenerate the patch**, because it must reproduce the package byte for byte.
   The procedure is in [`patch/README.md`](patch/README.md); change one shipped
   file and the old patch stops matching.
3. **Verify the patch by result, not by exit code**: apply it to a pristine
   baseline and compare every file's SHA-256 against the working tree. A patch
   that applies cleanly but lands different content is the failure worth catching.
4. Update [`CHANGELOG.md`](CHANGELOG.md).
5. Commit. The history is deliberately two commits per baseline — the pristine
   upstream release, then this fork — so `git diff` between them *is* the patch.
6. Tag and push.

```sh
git tag -a v0.15.0-wsl -m "dsh-wsl-git 0.15.0-wsl (baseline dsh-ide-git 0.15.0)"
git push origin main --follow-tags
```

## Which files ship

`package.json`'s `files` decides. Two entries matter more than they look:

* **`src`** — the whole directory, not `src/index.js` + `src/client.js` the way the
  baseline listed it. Listing files individually silently drops `src/target.js`
  and `src/wsl-git.js` from a packed install, and the plugin then fails at load
  with a bare module-resolution error. A `github:` install is not packed, so this
  bites npm-style installs rather than GitHub ones — it was still fixed, because
  the failure is invisible until someone packs it.
* **`patch`** — the released patch travels inside the package, so the diff against
  the baseline is always at hand. It cannot contain itself; see
  [`patch/README.md`](patch/README.md).

## Rebasing onto a newer upstream

This release is rebased onto **0.15.0** (it was 0.13.5 before). Upstream will move
again, and a rebase is a normal maintenance task rather than an accident. A
three-way merge does most of it:

```sh
git merge-file -p <new upstream>/src/index.js <old upstream>/src/index.js <this repo>/src/index.js
```

Then **re-confirm the path-contract sites are still the complete set.** That is
the part a rebase invalidates silently, and it has two directions now:

```sh
grep -n 'show-toplevel\|absolute-git-dir\|requireAbsolute' src/index.js   # outputs + arguments
```

| Direction | Sites | Mapped by |
|---|---|---|
| git **reports** an absolute path | 5 — `repoRootOf`, `worktreesOf`, `operationOf`, `collectSubmoduleRepos`, `scanRepos` | `hostPathOf` |
| an absolute path is passed as an **argument** | 2 — `clone`, the untracked `diff --no-index` | `linuxSpellingOf` |

Both lists are also in [CHANGELOG.md](CHANGELOG.md) and [FORK.md](FORK.md). A
baseline that adds either kind reintroduces the exact defect this fork's
regression tests pin, so extend `tests/target.test.mjs` with the new site rather
than only fixing the symptom. The argument direction was found exactly this way
when rebasing onto 0.15.0, which had added both of its two sites.
