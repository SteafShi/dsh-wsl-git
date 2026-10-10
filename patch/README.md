# The patch

`dsh-wsl-git-0.15.0-wsl.on-dsh-ide-git-0.15.0.patch` is this release expressed as
a patch **on top of the pristine upstream baseline**. It is the authoritative
statement of "what changed relative to the baseline": a unified diff of two
commits, generated from a real repository — commit 1 is `dsh-ide-git@0.15.0`
exactly as published, commit 2 is this fork.

## Apply it

From a checkout of `dsh-ide-git` at **0.15.0** (or from the published tarball):

```sh
# the published baseline, pristine
curl -LO https://registry.npmjs.org/dsh-ide-git/-/dsh-ide-git-0.15.0.tgz
mkdir baseline && tar -xzf dsh-ide-git-0.15.0.tgz -C baseline
cd baseline/package
git init -q . && git add -A && git commit -qm baseline

# this patch
git apply -p1 /path/to/dsh-wsl-git-0.15.0-wsl.on-dsh-ide-git-0.15.0.patch
```

`git apply` is recommended rather than `patch(1)`: the diff carries **rename
metadata** (`README_EN.md` → `README.upstream.en.md`) and binary-safe new-file
entries, which plain `patch` handles less reliably. If you do use `patch`, run it
with `-p1 --forward` and expect the rename to land as a delete plus an add.

## What is in it

| Kind | Files |
|---|---|
| **New modules** | `src/target.js`, `src/wsl-git.js` |
| **Changed** | `src/index.js`, `src/client.js`, `package.json`, `dsh.plugin.json`, `cordis.patch.yml`, `README.md` |
| **New docs / tooling** | `CHANGELOG.md`, `FORK.md`, `NOTICE`, `PUBLISHING.md`, `README.upstream.md`, `tests/target.test.mjs`, `scripts/acceptance.mjs` |
| **Renamed** | `README_EN.md` → `README.upstream.en.md` |

Files the patch does **not** touch — because the fork does not change them — are
absent from the diff entirely: `LICENSE`, `icon.svg`, `locale/*.json`,
`docs/screenshots/*`.

## Why this file is not in the repository's own diff

The fork's repository history is two commits per baseline — the verbatim upstream
release, then this fork — so the second commit is the patch. But a patch cannot
contain itself, and this directory ships inside the package, so the file above is
the repository diff **minus `patch/`**. That is the only difference, and it was
checked rather than assumed:

* the released patch has 16 file sections, the repository's diff has 18;
* the two extra are `patch/README.md` and the `.patch` file itself;
* every one of the 16 shared sections is byte-identical between the two.

So: to review the fork, either read this file, or `git log -p` the second commit
and ignore the two `patch/` entries.

## How it was generated

```sh
git init repo && cd repo
git config core.autocrlf false          # a byte-faithful diff
git config core.safecrlf false
# commit 1: the published 0.15.0 tarball, extracted as-is
git add -A && git commit -m "baseline: dsh-ide-git 0.15.0"
# commit 2: this fork, with patch/ excluded BY CONSTRUCTION
git add -A
git diff --cached --no-color -M --binary > dsh-wsl-git-0.15.0-wsl.on-dsh-ide-git-0.15.0.patch
```

Two details are load-bearing:

* `core.autocrlf=false`, because with git's text conversion left on the patch's
  own line endings can be rewritten so that it no longer applies.
* **`patch/` and `.git` are excluded when the fork tree is staged.** Omitting
  `.git` once replaced the generator repository's history with the plugin's own,
  which staged `patch/` as *deletions* and produced a patch that could not apply.
  The generation step now asserts three things before the patch is trusted: one
  commit, nothing staged under `patch/`, and no `patch/` section in the diff.

## Verification

The patch was not merely generated — it was checked, and checked by result rather
than by exit code:

1. `git apply --check -p1` against a pristine 0.15.0 tree → exit 0.
2. `git apply -p1` for real → exit 0.
3. **Every file of the patched tree was then compared, by SHA-256, against this
   package: all 27 files identical.** So the patch reproduces this release exactly
   from the baseline — it is not an approximation of it.

SHA-256 of the patch itself:

```
255dd5763cfa1e997d4817d761f1786c55bb3ade44e82dee70a9ac8db8475947
```

(Printed by `sha256sum` / `Get-FileHash`; recorded here so a download can be
checked against the released artifact.)
