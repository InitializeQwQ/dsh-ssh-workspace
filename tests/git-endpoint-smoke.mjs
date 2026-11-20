/**
 * Git transport bindings are not machines.
 *
 * `~/.ssh/config` is shared with every other SSH client, and the block people
 * put there most often is not a host they log into: `Host github.com` whose job
 * is to bind a key (or port 443) for `git push`. Those blocks are valid, they
 * connect, and they are useless as remote workspaces — GitHub accepts the `git`
 * account and never starts a shell. Reading the config as a fallback therefore
 * imported rows nobody could use, into every screen that lists hosts.
 *
 * What this suite pins:
 *
 *  1. the classifier itself, especially the cases it must NOT match — hiding a
 *     real machine is the one failure mode this feature cannot have;
 *  2. `HostStore.listing()` leaving such a block out, reporting it in `ignored`
 *     (not `skipped`: a non-candidate is not a fault, and `skipped` turns the
 *     status dot red), while `resolve()` keeps working for an explicit alias;
 *  3. a STORE entry being exempt: the user typed that alias into the panel, so
 *     discovery does not second-guess it;
 *  4. the `DSH_SSH_WORKSPACE_SHOW_GIT_HOSTS` escape hatch;
 *  5. the wiring — the route and the agent tool must carry `ignored` out, or the
 *     panel note and the tool note would have nothing to say.
 *
 * Run: node tests/git-endpoint-smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts.js')).href)
const { SHOW_GIT_HOSTS_ENV, gitOnlyReason, isGitServiceHost, showGitHosts } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib/git-endpoint.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * A HostStore over a throwaway config file and a store double.
 *
 * The constructor is the real one so the real ssh-config parsing runs; only the
 * editable store is replaced. `find` is what makes a store entry SHADOW the
 * config block of the same alias, so it has to answer like the real one.
 */
function storeWith ({ configText = '', entries = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-git-endpoint-'))
  const configPath = path.join(dir, 'ssh_config')
  writeFileSync(configPath, configText)
  const store = new HostStore(configPath)
  store.entryStore = {
    load: () => entries,
    find: (alias) => entries.find(entry => entry.alias === alias),
    secretFor: () => undefined,
    knownHostKey: () => undefined,
    rememberHostKey: () => {},
    forgetHostKey: () => false,
    recentHosts: () => ({}),
    sshConfigAliases: () => [],
  }
  return { store, dir }
}

const cleanups = []
const track = (dir) => { cleanups.push(() => rmSync(dir, { recursive: true, force: true })) }
process.on('exit', () => { for (const cleanup of cleanups) cleanup() })

console.log('\n[1] a public Git service is recognised by its hostname')
{
  const services = [
    'github.com',
    'ssh.github.com',
    'gist.github.com',
    'gitlab.com',
    'altssh.gitlab.com',
    'bitbucket.org',
    'codeberg.org',
    'gitee.com',
    'git.sr.ht',
    'hg.sr.ht',
    'ssh.dev.azure.com',
    'vs-ssh.visualstudio.com',
    'git-codecommit.us-east-1.amazonaws.com',
  ]
  for (const host of services) {
    check(`${host} is a Git service`, isGitServiceHost(host), 'not recognised')
  }
  // Case and a trailing root dot are the two spellings a config really uses.
  check('matching is case-insensitive', isGitServiceHost('GitHub.COM'), 'case-sensitive')
  check('a trailing root dot still matches', isGitServiceHost('github.com.'), 'trailing dot')
}

console.log('\n[2] and nothing else is')
{
  // The failure mode that matters: hiding a REAL machine. Every one of these is
  // an ordinary host that merely looks adjacent to a Git service name.
  const machines = [
    'notgithub.com',
    'github.com.invalid',
    'my.gitee.company.com',
    'git.example.com',
    'gitlab.internal',
    '10.0.0.5',
    'box.lan',
    '',
  ]
  for (const host of machines) {
    check(`${JSON.stringify(host)} is not a Git service`, !isGitServiceHost(host), 'wrongly recognised')
  }
  check('a suffix boundary is respected', !isGitServiceHost('evilgithub.com'), 'substring matched')
  check('the Git service name as a SUBDOMAIN of someone else is not matched',
    !isGitServiceHost('github.com.example.org'), 'host of another domain matched')
}

console.log('\n[3] the reason distinguishes the two signals')
{
  const byHost = gitOnlyReason({ host: 'github.com', user: 'kechun' })
  check('a Git service is named in the reason', typeof byHost === 'string' && byHost.includes('github.com'),
    String(byHost))
  check('and the reason says it is not a machine', /not a machine/u.test(byHost ?? ''), String(byHost))
  check('and names the escape hatch', (byHost ?? '').includes(SHOW_GIT_HOSTS_ENV), String(byHost))

  const byUser = gitOnlyReason({ host: 'git.example.com', user: 'git' })
  check('a `git` account is reported even on an unknown host',
    typeof byUser === 'string' && /"git"/u.test(byUser), String(byUser))
  check('the `git`-account reason is not the Git-service one', !/Git service endpoint/u.test(byUser ?? ''),
    String(byUser))

  check('an ordinary host has no reason', gitOnlyReason({ host: 'box.example', user: 'root' }) === undefined)
  check('`Git` (capitalised) is a different account, so it is not filtered',
    gitOnlyReason({ host: 'box.example', user: 'Git' }) === undefined, 'case-folded')
  check('a missing identity does not throw', gitOnlyReason(undefined) === undefined)
}

console.log('\n[4] the escape hatch is off unless it is asked for')
{
  check('unset is off', showGitHosts({}) === false)
  check('"1" is on', showGitHosts({ [SHOW_GIT_HOSTS_ENV]: '1' }) === true)
  check('"true" is on', showGitHosts({ [SHOW_GIT_HOSTS_ENV]: 'true' }) === true)
  check('"yes" is on', showGitHosts({ [SHOW_GIT_HOSTS_ENV]: 'yes' }) === true)
  check('"0" is off', showGitHosts({ [SHOW_GIT_HOSTS_ENV]: '0' }) === false)
  check('a typo is off, so the safe default holds', showGitHosts({ [SHOW_GIT_HOSTS_ENV]: 'ture' }) === false)
}

const CONFIG = [
  'Host github.com',
  '  IdentityFile ~/.ssh/id_ed25519',
  '',
  'Host gh-work',
  '  HostName github.com',
  '  User git',
  '',
  'Host gitserver',
  '  HostName git.internal.example',
  '  User git',
  '',
  'Host nature',
  '  HostName nature.example',
  '  User kechun',
  '',
  'Host selfhosted',
  '  HostName git.example.com',
  '  User deploy',
  '',
].join('\n')

console.log('\n[5] the listing leaves them out — and keeps the machines')
{
  const { store, dir } = storeWith({ configText: CONFIG })
  track(dir)
  const listing = store.listing()
  const aliases = listing.rows.map(row => row.alias)
  check('the Git-service block is not a row', !aliases.includes('github.com'), JSON.stringify(aliases))
  check('a `HostName github.com` under another alias is not a row either',
    !aliases.includes('gh-work'), JSON.stringify(aliases))
  check('nor is any other `git`-account block', !aliases.includes('gitserver'), JSON.stringify(aliases))
  check('an ordinary host is still a row', aliases.includes('nature'), JSON.stringify(aliases))
  check('a self-hosted Git server addressed as its own hostname stays listed',
    aliases.includes('selfhosted'), JSON.stringify(aliases))
  check('the row count is the two machines', aliases.length === 2, JSON.stringify(aliases))

  check('they are reported in `ignored`, with their aliases',
    (listing.ignored ?? []).map(entry => entry.alias).sort().join(',') === 'gh-work,github.com,gitserver',
    JSON.stringify(listing.ignored))
  check('each ignored entry carries a reason',
    (listing.ignored ?? []).every(entry => typeof entry.reason === 'string' && entry.reason !== ''),
    JSON.stringify(listing.ignored))
  check('they are NOT in `skipped` — not being a candidate is not a fault',
    (listing.skipped ?? []).length === 0, JSON.stringify(listing.skipped))
  // The point of the split: `skipped` feeds the status dot, `ignored` must not.
  check('a Git-only block therefore cannot turn the status dot red',
    listing.skipped.length === 0 && listing.ignored.length === 3, 'the two buckets were merged')
}

console.log('\n[6] discovery is filtered; explicit use is not')
{
  const { store, dir } = storeWith({ configText: CONFIG })
  track(dir)
  // A user (or the agent) naming the alias explicitly must still get a
  // descriptor: the filter is about what the LIST shows, not about refusing.
  const resolved = store.resolve('github.com')
  check('resolve() still answers for an ignored alias', resolved.alias === 'github.com', JSON.stringify(resolved))
  check('with the block\'s own identity', resolved.host === 'github.com' && resolved.source === 'ssh-config',
    JSON.stringify(resolved))
  check('and a connection is still a connection, not an error', resolved.auth.kind === 'key',
    JSON.stringify(resolved.auth))
}

console.log('\n[7] a store entry is explicit, so it is never filtered')
{
  // The panel is a deliberate act: the user typed the alias. A Git service
  // added there is their business, and the config block of the same alias is
  // shadowed by it — the ordinary precedence rule, unchanged.
  const entry = {
    alias: 'github.com',
    host: 'github.com',
    port: 22,
    user: 'git',
    auth: { kind: 'agent' },
  }
  const { store, dir } = storeWith({ configText: CONFIG, entries: [entry] })
  track(dir)
  const listing = store.listing()
  check('the stored entry is a row', listing.rows.some(row => row.alias === 'github.com'),
    JSON.stringify(listing.rows.map(row => row.alias)))
  check('its source says store', listing.rows.find(row => row.alias === 'github.com')?.source === 'store',
    JSON.stringify(listing.rows))
  check('and the config block is not reported as ignored too (it never got that far)',
    !(listing.ignored ?? []).some(item => item.alias === 'github.com'), JSON.stringify(listing.ignored))
}

console.log('\n[8] DSH_SSH_WORKSPACE_SHOW_GIT_HOSTS brings them back')
{
  const { store, dir } = storeWith({ configText: CONFIG })
  track(dir)
  const previous = process.env[SHOW_GIT_HOSTS_ENV]
  process.env[SHOW_GIT_HOSTS_ENV] = '1'
  try {
    const listing = store.listing()
    const aliases = listing.rows.map(row => row.alias)
    check('the Git-service block is listed again', aliases.includes('github.com'), JSON.stringify(aliases))
    check('nothing is reported as ignored', (listing.ignored ?? []).length === 0, JSON.stringify(listing.ignored))
    check('and the machines are still there', aliases.includes('nature') && aliases.includes('selfhosted'),
      JSON.stringify(aliases))
  } finally {
    if (previous === undefined) delete process.env[SHOW_GIT_HOSTS_ENV]
    else process.env[SHOW_GIT_HOSTS_ENV] = previous
  }
}

console.log('\n[9] the wiring: the route and the tool carry `ignored` out')
{
  // A filtered list with no way to say WHY is the silent-drop bug this repo
  // keeps re-fixing. The third outcome has to survive the trip to the panel
  // and to the agent tool, so both call sites are pinned here.
  const routes = readFileSync(path.join(pluginRoot, 'lib/routes.js'), 'utf8')
  check('the hosts route returns `ignored`', /ignored: listing\.ignored \?\? \[\]/u.test(routes),
    'the route drops the third outcome')
  const tools = readFileSync(path.join(pluginRoot, 'lib/tools.js'), 'utf8')
  check('the hosts tool declares `ignored` in its output schema', /ignored: \{\n\s+type: 'array'/u.test(tools),
    'undeclared field under additionalProperties:false')
  check('the hosts tool returns it', /ignored: listing\.ignored\.map\(/u.test(tools), 'the tool drops it')
  check('the tool renders the reasons as notes', /renderHosts\(value\.hosts \?\? \[\], \{ ignored: value\.ignored \}\)/u.test(tools),
    'the rendered table omits the reason')
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) process.exitCode = 1
