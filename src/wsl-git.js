/**
 * dsh-wsl-git — the WSL transport: how a git command is spelled for a target,
 * and how a failure of the LAUNCHER is told apart from a failure of git.
 *
 * Everything here is a pure function over a target and an argv, so the whole
 * transport contract is asserted without a WSL host (tests/target.test.mjs).
 * The spawn itself stays in src/index.js, because that is where `PanelError`
 * lives and the HTTP surface needs one error taxonomy.
 *
 * The argv shape is not invented here — it is the one the installed WSL plugins
 * already use and that is known to work on this host:
 *
 *   dsh-wsl-tool/lib/runner.js:257-264           ['wsl.exe', -d…, -u…, '-e', 'bash', '-lc', script]
 *   dsh-wsl-workspace/src/host/wsl-bash-tool.ts  ['wsl.exe', -d…, -u…, '--cd', dir, '-e', 'bash', …]
 *
 * Two deliberate differences:
 *
 *  1. `git -C <dir>` instead of `--cd <dir>`. `--cd` needs a wsl.exe new enough
 *     to have it; `-C` needs only git. It also keeps the whole call an argv
 *     array with NO shell, so a commit message containing a quote, a newline or
 *     a `$` crosses the boundary exactly as written.
 *  2. The git environment travels as `-e env KEY=VALUE git …` rather than through
 *     `WSLENV`. That keeps the mutation local to this one call instead of
 *     editing a variable the user and every other plugin share.
 *
 * @module dsh-wsl-git/wsl-git
 */

/** The WSL launcher. */
export const WSL_EXE = 'wsl.exe'

/** The git program to run when nothing overrides it. */
export const DEFAULT_GIT = 'git'

/** git settings this plugin has always forced, for the local and WSL worlds alike. */
const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
}

/** Round-trip a trimmed string option, treating blank and absent alike. */
function option(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * The git program for a target: the world-specific environment override, then
 * the plugin setting, then `git`.
 *
 * `DSH_IDE_GIT_BIN` keeps its upstream meaning (the LOCAL binary) so an existing
 * install is not silently reconfigured; `DSH_WSL_GIT_BIN` is its sibling for the
 * program looked up INSIDE the distribution, which is a different namespace —
 * a Windows path there would name nothing.
 *
 * @param {{kind: string}} target - the resolved target.
 * @param {string} [configured] - the plugin's `gitPath` setting.
 * @param {NodeJS.ProcessEnv} [env] - environment to read overrides from.
 * @returns {string} the program to execute.
 */
export function gitProgramFor(target, configured, env = process.env) {
  const override = target.kind === 'wsl' ? option(env.DSH_WSL_GIT_BIN) : option(env.DSH_IDE_GIT_BIN)
  if (override !== undefined) return override
  const setting = option(configured)
  return setting === undefined ? DEFAULT_GIT : setting
}

/**
 * The argv one WSL git call is made of.
 *
 * `-d` and `-u` are launcher options and sit before `-e`, which is what makes
 * the rest the distribution's own argv. The distribution is never omitted: this
 * machine's default distribution is a different one than the workspace's, so
 * letting wsl.exe choose would run the wrong git against the wrong filesystem.
 *
 * @param {{distro: string, user?: string, linuxPath: string}} target - a WSL target.
 * @param {readonly string[]} args - git arguments, shell-free.
 * @param {string} program - the git program, as the distribution sees it.
 * @returns {string[]} the argv for `spawn`.
 */
export function buildWslArgv(target, args, program) {
  const argv = [WSL_EXE, '-d', target.distro]
  if (target.user !== undefined && target.user !== '') argv.push('-u', target.user)
  argv.push(
    '-e', 'env',
    `GIT_TERMINAL_PROMPT=${GIT_ENV.GIT_TERMINAL_PROMPT}`,
    `GIT_OPTIONAL_LOCKS=${GIT_ENV.GIT_OPTIONAL_LOCKS}`,
    program,
    '-C', target.linuxPath,
  )
  for (const arg of args) argv.push(arg)
  return argv
}

/**
 * The environment for the `wsl.exe` process itself.
 *
 * `WSL_UTF8=1` is load-bearing rather than cosmetic: without it wsl.exe writes
 * its own diagnostics as UTF-16, and `Buffer.toString('utf8')` turns
 * `Wsl/E_ACCESSDENIED` into a string no pattern here can match — measured on
 * this host as mojibake ending in `W s l / E _ A C C E S S D E N I E D`.
 *
 * @param {NodeJS.ProcessEnv} [base] - the environment to extend.
 * @returns {Record<string, string>} the child environment.
 */
export function wslEnv(base = process.env) {
  const merged = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) merged[key] = value
  }
  merged.WSL_UTF8 = '1'
  return merged
}

/**
 * The argv and spawn options for one git call.
 *
 * The `cwd` of a WSL call is deliberately NOT the workspace path. Spawning a
 * Windows child with a UNC working directory is a documented Node/Windows edge
 * (`dsh-wsl-workspace/src/host/wsl-bash-tool.ts:399-401` says the same about its
 * own spawn), and `git -C` has already decided the Linux side, so the Windows
 * side only has to be a directory that exists.
 *
 * @param {{kind: string, distro?: string, user?: string, linuxPath?: string, hostPath: string}} target
 * @param {readonly string[]} args - git arguments.
 * @param {string} program - the git program.
 * @returns {{argv: string[], options: {cwd: string, env: Record<string, string>, windowsHide: boolean}}}
 */
export function gitSpawnSpec(target, args, program) {
  if (target.kind === 'wsl') {
    return {
      argv: buildWslArgv(target, args, program),
      options: {
        cwd: option(process.env.SystemRoot) === undefined ? 'C:\\Windows' : process.env.SystemRoot,
        env: wslEnv(),
        windowsHide: true,
      },
    }
  }
  return {
    argv: [program, ...args],
    options: {
      cwd: target.hostPath,
      env: { ...process.env, ...GIT_ENV },
      windowsHide: true,
    },
  }
}

/* ============================== failure classification ============================== */

/**
 * Recover ASCII from a diagnostic that may have arrived as UTF-16.
 *
 * The `WSL_UTF8` variable is the fix; this is the belt to its braces, because
 * the launcher's OWN errors are exactly the ones emitted before the variable is
 * honoured. UTF-16LE ASCII read as UTF-8 is the same bytes interleaved with
 * NULs, so dropping NULs recovers the text.
 *
 * @param {string} text - the decoded stream.
 * @returns {string} text safe to pattern-match against.
 */
export function normalizeDiagnostic(text) {
  return typeof text === 'string' ? text.replace(/\0/g, '') : ''
}

/** The WSL launcher's own failure codes, locale-independent unlike their messages. */
const LAUNCHER_CODE_PATTERN = /Wsl\/(?:Service\/)?([A-Za-z][A-Za-z0-9_]*)/

/** Markers wsl.exe prints when `-e` could not find the program to execute. */
const EXEC_MISSING_PATTERN = /execvpe|command not found|No such file or directory/i

/**
 * Describe a WSL launcher failure, or null when this result is not one.
 *
 * This is the difference between the bug this plugin fixes and a different bug
 * wearing its clothes: without it, a launch failure reaches `repoRootOf`, whose
 * non-zero `rev-parse` means "not a git repository", and the panel tells the
 * user their WSL repository does not exist.
 *
 * @param {{distro: string}} target - the WSL target the call was made for.
 * @param {{code: number, stdout: string, stderr: string}} result - the finished call.
 * @returns {{code: string, message: string} | null} the classified failure.
 */
export function launcherFailureOf(target, result) {
  if (result.code === 0) return null
  const text = normalizeDiagnostic(`${result.stderr}\n${result.stdout}`)
  const match = LAUNCHER_CODE_PATTERN.exec(text)
  if (match === null) return null
  const detail = normalizeDiagnostic(result.stderr).trim().split(/\r?\n/)[0] ?? ''
  const name = match[1] === undefined ? 'unknown' : match[1]
  if (/DISTRO_NOT_FOUND|E_DISTRO/i.test(name)) {
    return {
      code: 'wsl-distro-missing',
      message: `WSL distribution "${target.distro}" is not registered. Run \`wsl -l -v\` to list the available distributions, `
        + 'or add this workspace again so it names one that exists.',
    }
  }
  return {
    code: 'wsl-launcher',
    message: `the WSL launcher failed for "${target.distro}" (${name})${detail === '' ? '' : `: ${detail}`}. `
      + 'Check that WSL is healthy (`wsl --status`).',
  }
}

/**
 * Describe a `git` that is missing INSIDE the distribution, or null.
 *
 * Only exit 127 with an exec marker counts. Matching the message alone would
 * misread ordinary git errors that legitimately say "No such file or directory"
 * about a path the user typed.
 *
 * @param {{distro: string}} target - the WSL target the call was made for.
 * @param {{code: number, stdout: string, stderr: string}} result - the finished call.
 * @returns {{code: string, message: string} | null} the classified failure.
 */
export function remoteGitMissingOf(target, result) {
  if (result.code !== 127) return null
  const text = normalizeDiagnostic(`${result.stderr}\n${result.stdout}`)
  if (!EXEC_MISSING_PATTERN.test(text)) return null
  return {
    code: 'git-missing',
    message: `git is not available inside WSL distribution "${target.distro}". `
      + `Install it there (\`wsl -d ${target.distro} -- sudo apt install git\`) or point the plugin's "git path" setting at it.`,
  }
}
