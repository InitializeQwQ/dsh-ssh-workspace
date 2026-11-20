/**
 * Which `~/.ssh/config` blocks are Git transport bindings, not machines.
 *
 * ## The problem
 *
 * `~/.ssh/config` is shared by everything that speaks SSH, and the single most
 * common thing people put in it is NOT a machine they log into: it is a
 * `Host github.com` block whose whole job is to bind an identity file (or a
 * different port) for `git push`. Such a block has no `HostName`, often no
 * `User`, and it is perfectly valid OpenSSH — `ssh -T git@github.com` answers
 * with a greeting and nothing else. It is nevertheless useless as a remote
 * workspace: `github.com` accepts `git` and no shell, so every panel card,
 * host picker and `ssh_workspace_hosts` row built from it is a dead end.
 *
 * Reading the config as a FALLBACK (so an already-configured machine needs no
 * duplication) therefore imported exact-host blocks that were never candidates,
 * and the user had to look at them on every screen that lists hosts.
 *
 * ## Why a name list instead of a connection probe
 *
 * "Can I log in?" cannot be answered without credentials, a network round trip
 * and a shell to test — for every host, on every listing. And a probe would
 * answer WRONG for the case that matters here: a Git service accepts the SSH
 * handshake and a `git`-user key, then refuses to start a shell. The signals
 * that actually distinguish the two kinds of block are textual and known:
 *
 *  - the target is a public Git service (its hostname says so), or
 *  - the block authenticates as `git`, the account every Git service uses
 *    because there is no login user behind it.
 *
 * Both are decisions a pure function can make, so they are made here and
 * tested directly (see `tests/git-endpoint-smoke.mjs`).
 *
 * ## What this is NOT
 *
 * This is not a security boundary and not a claim that a hidden block is
 * broken: `HostStore.resolve()` still resolves the alias, so an explicit
 * `ssh_workspace_mount` / exec against it keeps working. Only DISCOVERY (the
 * panel list, the host pickers, the agent tool) leaves it out — and the reason
 * is reported (`ignored`), never silently dropped.
 *
 * ## The escape hatch
 *
 * A legitimate machine can collide with both signals: a build account really
 * named `git`, or a self-hosted Gitea whose Git URL is `git@git.example.com`.
 * `DSH_SSH_WORKSPACE_SHOW_GIT_HOSTS=1` turns the filter off entirely, and the
 * panel note says so. A filter a user cannot overrule is a bug of its own.
 *
 * @module @initializeqwq/dsh-ssh-workspace/git-endpoint
 */

/**
 * Hostname suffixes of public Git services.
 *
 * Matched on a label boundary (`ssh.github.com` and `github.com` both match
 * `github.com`; `notgithub.com` does not). Deliberately a closed list: guessing
 * from a name like `git.` would hide real servers, which is the one failure
 * mode this feature must not have.
 */
export const GIT_SERVICE_SUFFIXES = Object.freeze([
  // GitHub (including `ssh.github.com` over 443 and `gist.github.com`)
  'github.com',
  // GitLab (including `altssh.gitlab.com`)
  'gitlab.com',
  // Bitbucket
  'bitbucket.org',
  // Codeberg / Gitea's public instance
  'codeberg.org',
  // Gitee
  'gitee.com',
  // Sourcehut (Git and Mercurial)
  'git.sr.ht',
  'hg.sr.ht',
  // Azure DevOps (its SSH endpoint is a Git-only service)
  'ssh.dev.azure.com',
  'vs-ssh.visualstudio.com',
])

/**
 * AWS CodeCommit's per-region endpoint is not a fixed suffix, so it is a shape.
 *
 * Kept separate from the suffix list rather than matching `amazonaws.com` (which
 * would hide real EC2 machines).
 */
const GIT_SERVICE_SHAPE = /^git-codecommit\.[a-z0-9-]+\.amazonaws\.com$/u

/** The account Git services use. There is no shell behind it. */
export const GIT_SERVICE_USER = 'git'

/** Environment switch that turns the whole filter off. */
export const SHOW_GIT_HOSTS_ENV = 'DSH_SSH_WORKSPACE_SHOW_GIT_HOSTS'

/**
 * Normalize a hostname for matching: lowercase, no trailing root dot, no
 * brackets around an IPv6 literal, no `user@` prefix.
 *
 * @param {string} value - a hostname as written in the config.
 * @returns {string} the comparable form.
 */
function normalizeHost (value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
}

/**
 * Is this hostname a public Git service endpoint?
 *
 * @param {string} host - the effective `HostName` (or the alias when none).
 * @returns {boolean} true when the host is a Git service.
 */
export function isGitServiceHost (host) {
  const name = normalizeHost(host)
  if (name === '') return false
  if (GIT_SERVICE_SHAPE.test(name)) return true
  return GIT_SERVICE_SUFFIXES.some(suffix => name === suffix || name.endsWith(`.${suffix}`))
}

/**
 * Should this host be left out of host DISCOVERY, and why?
 *
 * The caller passes the identity the plugin would actually connect with (the
 * resolved `host` / `user`), not the raw block: a `Host gh` block with
 * `HostName github.com` is the same Git binding under another name, and the
 * alias alone would not say so.
 *
 * `user` is compared to `git` exactly (SSH usernames are case-sensitive, and
 * `Git` is not the account these services use).
 *
 * @param {{host?: string, user?: string}} identity - the resolved target.
 * @returns {string | undefined} a sentence explaining the exclusion, or
 *   undefined when the host is an ordinary machine.
 */
export function gitOnlyReason (identity) {
  const host = normalizeHost(identity?.host)
  const user = String(identity?.user ?? '')
  if (isGitServiceHost(host)) {
    return `${host} is a Git service endpoint (git over SSH), not a machine you can log into or mount a workspace on — its ssh-config block only binds a key for git; the host list leaves it out. Set ${SHOW_GIT_HOSTS_ENV}=1 to list it anyway`
  }
  if (user === GIT_SERVICE_USER) {
    return `this ssh-config block authenticates as "${GIT_SERVICE_USER}", the account Git services use (there is no login shell behind it), so it is not a machine you can open a workspace on; the host list leaves it out. Set ${SHOW_GIT_HOSTS_ENV}=1 to list it anyway`
  }
  return undefined
}

/**
 * Has the operator asked for Git-only blocks to be listed anyway?
 *
 * Read at call time (not cached) because a listing is cheap and the switch is
 * meant to be a debugging aid: `DSH_SSH_WORKSPACE_SHOW_GIT_HOSTS=1 dsh web`.
 * Any value other than `1` / `true` / `yes` is off, so a typo fails open to the
 * default rather than hiding hosts the user meant to see.
 *
 * @param {Record<string, string | undefined>} [env] - environment map.
 * @returns {boolean} true when the filter is disabled.
 */
export function showGitHosts (env = process.env) {
  const value = String(env?.[SHOW_GIT_HOSTS_ENV] ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}
