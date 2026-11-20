/**
 * Host connection intent: "the switches I turned on come back after a restart".
 *
 * The panel's connection switch reflects the LIVE pool, and a socket does not
 * survive the process — so a restart used to begin with every host disconnected
 * no matter what the user had switched on. The intent is now stored in the
 * shared host store (`autoConnect: [...]`), written by the connect route, cleared
 * by the disconnect route, and restored on activation.
 *
 * What these checks pin:
 *
 * 1. the store section round-trips, de-duplicates, and follows a rename /
 *    delete of its host instead of pointing at a dead alias;
 * 2. a failed intent write is a failure the caller sees — never a connect that
 *    silently will not survive the next start;
 * 3. the engine's keep-alive check is what makes the restored connection
 *    survive BOTH the idle sweeper and a drop (intent → wanted, no dialing a
 *    host nobody wants);
 * 4. `restore()` is serial, single-flight, and never throws: one unreachable
 *    host must not stop the rest or fail the plugin's activation.
 *
 * Run: node tests/host-intent-smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// routes.js transitively imports remote-fs.js, which resolves the DSH peer
// packages; the runner's stub root (or an assembled tree) has to be named
// before that import. The store / engine halves do not need it.
const coreRoot = process.env.DSH_CORE_ROOT
if (coreRoot) process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)
const { HostConfigStore, autoConnectOf } = await import(pathToFileURL(path.join(pluginRoot, 'lib/store.js')).href)
const { HostIntent } = await import(pathToFileURL(path.join(pluginRoot, 'lib/host-intent.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
const { makeRoutes, ROUTES } = coreRoot
  ? await import(pathToFileURL(path.join(pluginRoot, 'lib/routes.js')).href)
  : { makeRoutes: undefined, ROUTES: {} }

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Temporary store files; cleaned up by the caller. */
const cleanups = []
function makeStore (document) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-host-intent-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'dsh-ssh.json')
  if (document !== undefined) writeFileSync(file, JSON.stringify(document, null, 2))
  return { file, store: new HostConfigStore(file) }
}

/** The raw on-disk document, so a check can assert what was actually written. */
function readDocument (file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

console.log('\n=== host intent smoke ===\n')

// ============================================================== [1] the store
console.log('[1] the store section round-trips and follows its host')
{
  const { file, store } = makeStore()
  check('a store that was never written to has nothing to restore',
    store.autoConnectHosts().length === 0, JSON.stringify(store.autoConnectHosts()))

  store.setHostAutoConnect('Yotta', true)
  check('switching a host on is stored', store.autoConnectHosts().includes('Yotta'), JSON.stringify(store.autoConnectHosts()))
  check('the section is a top-level alias array, not a per-entry flag',
    Array.isArray(readDocument(file).autoConnect) && readDocument(file).autoConnect[0] === 'Yotta',
    JSON.stringify(readDocument(file)))

  store.setHostAutoConnect('Yotta', true)
  check('a repeated switch-on does not duplicate the alias',
    store.autoConnectHosts().filter(alias => alias === 'Yotta').length === 1,
    JSON.stringify(store.autoConnectHosts()))

  // A ~/.ssh/config alias has no editable record, and that is exactly why the
  // list is top-level: the switch exists for those hosts too.
  store.setHostAutoConnect('Yotta-Dev-1', true)
  check('a config-only alias can be switched on as well',
    store.autoConnectHosts().join(',') === 'Yotta,Yotta-Dev-1', JSON.stringify(store.autoConnectHosts()))

  store.setHostAutoConnect('Yotta', false)
  check('switching a host off removes it',
    !store.autoConnectHosts().includes('Yotta') && store.autoConnectHosts().includes('Yotta-Dev-1'),
    JSON.stringify(store.autoConnectHosts()))
  store.setHostAutoConnect('Yotta', false)
  check('a repeated switch-off is a no-op', store.autoConnectHosts().length === 1)

  // A `~/.ssh/config` alias is only REFERENCED here, so the store-entry rules
  // (64 characters, no leading dash, …) must not apply: those describe a new
  // editable entry. A long config alias has to stay switchable-on.
  const longAlias = 'long-' + 'x'.repeat(80)
  store.setHostAutoConnect(longAlias, true)
  check('a long config alias can be switched on', store.autoConnectHosts().includes(longAlias), JSON.stringify(store.autoConnectHosts()))
  let refused
  try { store.setHostAutoConnect('bad alias', true) } catch (error) { refused = error }
  check('a name that could never be an alias is refused', refused?.code === 'STORE_INVALID', String(refused))
}

{
  // Foreign/hand-written content must survive, exactly like every other section
  // in this shared file.
  const { file, store } = makeStore({
    version: 1,
    hosts: [],
    autoConnect: ['kept'],
    somethingElse: { untouched: true },
  })
  store.setHostAutoConnect('added', true)
  const document = readDocument(file)
  check('an unrelated section survives the write', document.somethingElse?.untouched === true, JSON.stringify(document))
  check('an existing intent entry survives too', document.autoConnect.includes('kept'), JSON.stringify(document.autoConnect))
  check('the new entry is appended', document.autoConnect.includes('added'), JSON.stringify(document.autoConnect))
}

{
  const { file, store } = makeStore()
  store.create({ alias: 'alpha', host: 'a.example', port: 22, user: 'u', auth: { kind: 'agent' } })
  store.setHostAutoConnect('alpha', true)
  store.update('alpha', { alias: 'beta', host: 'a.example', port: 22, user: 'u', auth: { kind: 'agent' } })
  check('renaming a host moves its intent to the new alias',
    store.autoConnectHosts().join(',') === 'beta', JSON.stringify(store.autoConnectHosts()))
  check('the old alias is not left behind',
    !readDocument(file).autoConnect.includes('alpha'), JSON.stringify(readDocument(file).autoConnect))
  store.delete('beta')
  check('deleting the host drops its intent',
    store.autoConnectHosts().length === 0 && readDocument(file).autoConnect.length === 0,
    JSON.stringify(readDocument(file).autoConnect))
}

{
  // An ordinary edit must not invent the section: silence is the honest
  // encoding of "no host was switched on".
  const { file, store } = makeStore()
  store.create({ alias: 'gamma', host: 'g.example', port: 22, user: 'u', auth: { kind: 'agent' } })
  store.update('gamma', { alias: 'delta', host: 'g.example', port: 22, user: 'u', auth: { kind: 'agent' } })
  check('a rename with no intent writes no autoConnect section',
    Object.hasOwn(readDocument(file), 'autoConnect') === false, JSON.stringify(readDocument(file)))
}

{
  const { store } = makeStore()
  writeFileSync(store.path, '{ not json')
  check('an unreadable store degrades to nothing to restore instead of throwing',
    store.autoConnectHosts().length === 0)
  let refused
  try { store.setHostAutoConnect('x', true) } catch (error) { refused = error }
  check('writing into an unreadable store fails loudly', refused?.code === 'STORE_UNREADABLE', String(refused))
}

{
  check('a malformed section degrades to an empty list',
    autoConnectOf({ autoConnect: 'nope' }).length === 0 &&
    autoConnectOf({ autoConnect: [42, '', '  ', 'ok', 'ok'] }).join(',') === 'ok',
    JSON.stringify(autoConnectOf({ autoConnect: [42, '', '  ', 'ok', 'ok'] })))
}

// ======================================================== [2] engine keep-alive
console.log('\n[2] a keep-alive host survives the idle sweep and stays wanted')
{
  // The engine only needs a store for resolving; neither the sweep nor the
  // reconnect policy resolves anything, so a stub is enough here.
  const engine = new SshWorkspaceEngine({
    store: { resolve () { throw new Error('the store must not be consulted by this check') }, configStamp: () => 'absent' },
    sweepIntervalMs: 3_600_000,
  })
  cleanups.push(() => engine.dispose())
  engine.tuning.idleTimeoutMs = 5_000
  const idle = (alias) => ({ alias, client: { end () {} }, idleAt: Date.now() - 10_000, inFlight: 0, holds: 0, broken: false })
  engine.pool.set('pinned', idle('pinned'))
  engine.pool.set('other', idle('other'))
  // A broken check must not decide "no" for every host, and must not throw out
  // of the sweep.
  engine.addKeepAliveCheck(() => { throw new Error('this predicate is broken') })
  engine.addKeepAliveCheck(alias => alias === 'pinned')
  engine.sweep()
  check('the switched-on host is not reaped while idle',
    engine.pool.get('pinned') !== undefined, JSON.stringify([...engine.pool.keys()]))
  check('a host nobody asked for is still reaped',
    engine.pool.get('other') === undefined, JSON.stringify([...engine.pool.keys()]))

  // The same predicate is what the reconnect loop asks before every attempt: an
  // idle pooled socket is normally "not wanted", but a keep-alive host is.
  engine.reconnector.attempt = async () => { throw new Error('network down') }
  const pinned = await engine.reconnector.retryNow('pinned')
  check('a failed manual attempt reports the real error', pinned.ok === false && String(pinned.error).includes('network'), JSON.stringify(pinned))
  check('a keep-alive host is re-armed instead of given up',
    engine.reconnector.stateOf('pinned')?.phase === 'waiting', JSON.stringify(engine.reconnector.stateOf('pinned')))
  const other = await engine.reconnector.retryNow('unwanted')
  check('a host with no consumer is allowed to give up',
    other.ok === false && engine.reconnector.stateOf('unwanted')?.phase === 'gave-up',
    JSON.stringify(engine.reconnector.stateOf('unwanted')))

  // A deliberate drop that is NOT a disconnect (an edit, a re-pinned key, a
  // released probe) must not leave a switched-on host off: `forget` hands it
  // back to the loop. The disconnect route clears the intent first, so this
  // cannot resurrect a host the user switched off.
  engine.pool.set('pinned', idle('pinned'))
  engine.forget('pinned')
  check('forgetting a switched-on host re-arms the loop',
    engine.pool.get('pinned') === undefined && engine.reconnector.stateOf('pinned')?.phase === 'waiting',
    JSON.stringify(engine.reconnector.stateOf('pinned')))
  engine.reconnector.cancel('pinned', 'the check is done')
  engine.pool.set('unwanted', idle('unwanted'))
  engine.forget('unwanted')
  check('forgetting a host nobody asked for does not arm anything',
    engine.reconnector.stateOf('unwanted') === undefined, JSON.stringify(engine.reconnector.stateOf('unwanted')))
}

// ========================================================== [3] startup restore
console.log('\n[3] restore is serial, single-flight, and never throws')
{
  const { store } = makeStore()
  let calls = []
  const engine = {
    calls,
    async acquire (alias) { calls.push(alias); return { alias } },
  }
  const intent = new HostIntent({ store, engine })
  let outcome = await intent.restore()
  check('nothing to restore dials nothing',
    outcome.connected === 0 && outcome.failed.length === 0 && calls.length === 0, JSON.stringify(outcome))

  store.setHostAutoConnect('one', true)
  store.setHostAutoConnect('two', true)
  store.setHostAutoConnect('three', true)
  outcome = await intent.restore()
  check('every switched-on host is dialed in store order',
    calls.join(',') === 'one,two,three', JSON.stringify(calls))
  check('the outcome counts the connections', outcome.connected === 3 && outcome.failed.length === 0, JSON.stringify(outcome))
}

{
  const { store } = makeStore()
  store.setHostAutoConnect('reachable', true)
  store.setHostAutoConnect('offline', true)
  store.setHostAutoConnect('also-reachable', true)
  const calls = []
  const events = []
  const engine = {
    calls,
    diagnostics: { record (kind, message, options) { events.push({ kind, message, alias: options?.alias }) } },
    async acquire (alias) {
      calls.push(alias)
      if (alias === 'offline') throw new Error('EHOSTUNREACH')
      return { alias }
    },
  }
  const intent = new HostIntent({ store, engine })
  let outcome
  let threw = false
  try { outcome = await intent.restore() } catch { threw = true }
  check('a failing host does not make restore throw', threw === false)
  check('the failure is reported per alias',
    outcome.failed.length === 1 && outcome.failed[0].alias === 'offline' && outcome.failed[0].error.includes('EHOSTUNREACH'),
    JSON.stringify(outcome))
  check('the hosts after the failure are still attempted',
    calls.join(',') === 'reachable,offline,also-reachable' && outcome.connected === 2, JSON.stringify({ calls, outcome }))
  // A fatal failure arms no reconnect loop, so the diagnostics ring is the only
  // channel that can carry it.
  check('a startup failure reaches the diagnostics ring',
    events.length === 1 && events[0].kind === 'reconnect' && events[0].alias === 'offline' && events[0].message.includes('EHOSTUNREACH'),
    JSON.stringify(events))
  check('a successful restore records no failure event',
    events.every(event => !event.message.includes('reachable')), JSON.stringify(events))
}

{
  // Even with a scheduler present, restore dials through `acquire`. The
  // scheduler's manual retry runs the restore hook on success, and that hook
  // re-opens saved port forwards — which would make a switched-on host open its
  // tunnels at startup even when the panel's own auto-start preference is off.
  // A host being connected and a tunnel being restored are two choices.
  const { store } = makeStore()
  store.setHostAutoConnect('up', true)
  let acquired = 0
  let retried = 0
  const engine = {
    async acquire () { acquired += 1; return {} },
    reconnector: { async retryNow () { retried += 1; return { ok: true } } },
  }
  const outcome = await new HostIntent({ store, engine }).restore()
  check('restore dials through acquire, not the scheduler',
    acquired === 1 && retried === 0, JSON.stringify({ acquired, retried }))
  check('a successful restore is counted', outcome.connected === 1 && outcome.failed.length === 0, JSON.stringify(outcome))
}

{
  // Two activations (a reload, or two injections racing) must not dial the same
  // hosts twice.
  const { store } = makeStore()
  store.setHostAutoConnect('a', true)
  store.setHostAutoConnect('b', true)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = []
  const engine = {
    calls,
    async acquire (alias) {
      calls.push(alias)
      if (calls.length === 1) await gate
      return { alias }
    },
  }
  const intent = new HostIntent({ store, engine })
  const first = intent.restore()
  const second = await intent.restore()
  check('a second restore while the first is running does nothing',
    second.connected === 0 && second.failed.length === 0, JSON.stringify(second))
  release()
  const outcome = await first
  check('the in-flight pass still completes every host',
    outcome.connected === 2 && calls.join(',') === 'a,b', JSON.stringify({ calls, outcome }))
}

{
  const { store } = makeStore()
  store.setHostAutoConnect('known', true)
  const intent = new HostIntent({ store, engine: {} })
  check('has() reads the stored intent', intent.has('known') === true)
  check('has() is false for a host that was switched off', intent.has('Yotta') === false)
  check('blank aliases are never wanted', intent.has('') === false && intent.has('  ') === false)
  const broken = new HostIntent({ store: { autoConnectHosts () { throw new Error('store is gone') } }, engine: {} })
  check('an unreadable store means "nothing to restore", not a crash',
    broken.list().length === 0 && broken.has('known') === false)
}

// =============================================================== [4] the routes
console.log('\n[4] the switch routes persist the intent')
if (makeRoutes === undefined) {
  console.log('  SKIP  DSH_CORE_ROOT is not set (routes.js needs @deepseek-ai/dsh-fs)')
} else {
  /** A response double that records what the handler wrote. */
  function fakeRes () {
    const state = { status: undefined, body: '' }
    const res = {
      get headersSent () { return state.status !== undefined },
      writeHead (status) { state.status = status; return res },
      write (chunk) { state.body += String(chunk); return true },
      end (chunk) { if (chunk !== undefined) state.body += String(chunk); return res },
      on () {},
    }
    return { res, state }
  }
  /** A request double carrying what the access fence and JSON reader need. */
  function fakeReq (options = {}) {
    const handlers = new Map()
    return {
      method: options.method ?? 'POST',
      url: options.url ?? '/',
      headers: { host: 'localhost:4074', 'content-type': 'application/json', ...(options.headers ?? {}) },
      socket: { remoteAddress: '127.0.0.1', localPort: 4074 },
      on (event, handler) {
        handlers.set(event, handler)
        if (options.body !== undefined && event === 'end') {
          setImmediate(() => {
            const dataHandler = handlers.get('data')
            if (dataHandler !== undefined) dataHandler(Buffer.from(JSON.stringify(options.body)))
            handler()
          })
        }
      },
    }
  }
  const routeOf = (routes, routePath) => routes.find(route => route.path === routePath)

  const { store } = makeStore()
  const pool = new Map()
  const attempts = []
  let intentVisibleAtAttempt
  const engine = {
    pool,
    store: { entryStore: store, listing: () => ({ rows: [], skipped: [] }) },
    async acquire (alias) {
      attempts.push(alias)
      const record = { alias, holds: 0, inFlight: 0, idleAt: Date.now(), broken: false }
      pool.set(alias, record)
      return record
    },
    isKeepAlive (alias) { return store.autoConnectHosts().includes(alias) },
    forget (alias) { pool.delete(alias) },
    reconnector: {
      async retryNow (alias) {
        attempts.push(alias)
        intentVisibleAtAttempt = store.autoConnectHosts().includes(alias)
        return { ok: true }
      },
    },
  }
  const routes = makeRoutes({
    engine,
    router: { listRoots: () => [], listDisabled: () => [], assertEnabled () {} },
    forwards: { list: () => [], closeForAlias: () => 0 },
    shells: { list: () => [] },
    ctx: { get: () => undefined },
  })

  {
    const { res, state } = fakeRes()
    await routeOf(routes, ROUTES.hostReconnect).handler(fakeReq({ body: { alias: 'Yotta' } }), res)
    check('connect answers ok', state.status === 200 && JSON.parse(state.body).ok === true, state.body)
    check('connect stores the intent BEFORE dialing', intentVisibleAtAttempt === true)
    check('connect persists the intent', store.autoConnectHosts().includes('Yotta'), JSON.stringify(store.autoConnectHosts()))
  }

  {
    // The connect attempt failing must not throw the intent away: the host was
    // switched on, and the next start should still bring it back.
    engine.reconnector.retryNow = async (alias) => { attempts.push(alias); return { ok: false, error: 'still offline' } }
    const { res, state } = fakeRes()
    await routeOf(routes, ROUTES.hostReconnect).handler(fakeReq({ body: { alias: 'flaky' } }), res)
    check('a failed connect still reports the real error', JSON.parse(state.body).ok === false && JSON.parse(state.body).error === 'still offline', state.body)
    check('a failed connect keeps the host switched on', store.autoConnectHosts().includes('flaky'), JSON.stringify(store.autoConnectHosts()))
  }

  {
    // A store write that fails must fail the request: reporting "connected"
    // while the next start will not restore the host is the silent lie this
    // feature exists to avoid.
    const broken = makeStore()
    const brokenEngine = {
      pool: new Map(),
      store: { entryStore: Object.assign(Object.create(broken.store), { setHostAutoConnect () { throw Object.assign(new Error('store is read-only'), { code: 'STORE_UNREADABLE' }) } }) },
      async acquire () { throw new Error('must not dial') },
      reconnector: { async retryNow () { throw new Error('must not dial') } },
      forget () {},
    }
    const brokenRoutes = makeRoutes({
      engine: brokenEngine,
      router: { listRoots: () => [], listDisabled: () => [], assertEnabled () {} },
      forwards: { list: () => [], closeForAlias: () => 0 },
      shells: { list: () => [] },
      ctx: { get: () => undefined },
    })
    const { res, state } = fakeRes()
    await routeOf(brokenRoutes, ROUTES.hostReconnect).handler(fakeReq({ body: { alias: 'x' } }), res)
    check('a connect whose intent cannot be stored fails loudly',
      state.status === 500 && String(JSON.parse(state.body).error).includes('read-only'), `${state.status} ${state.body}`)
  }

  {
    // The live connection must be closed AND the intent cleared — either half
    // alone leaves the user with a host that comes back after a restart they
    // did not ask for.
    pool.set('busy', { alias: 'busy', inFlight: 2, holds: 0, idleAt: Date.now(), broken: false, client: { end () {} } })
    store.setHostAutoConnect('busy', true)
    const { res, state } = fakeRes()
    await routeOf(routes, ROUTES.hostDisconnect).handler(fakeReq({ body: { alias: 'busy' } }), res)
    check('a busy connection still refuses the disconnect', state.status === 409, `${state.status} ${state.body}`)
    check('a refused disconnect leaves the intent alone', store.autoConnectHosts().includes('busy'), JSON.stringify(store.autoConnectHosts()))
    pool.delete('busy')
  }

  {
    pool.set('live', { alias: 'live', inFlight: 0, holds: 0, idleAt: Date.now(), broken: false, client: { end () {} } })
    store.setHostAutoConnect('live', true)
    const { res, state } = fakeRes()
    await routeOf(routes, ROUTES.hostDisconnect).handler(fakeReq({ body: { alias: 'live' } }), res)
    check('disconnect answers ok', state.status === 200 && JSON.parse(state.body).disconnected === true, state.body)
    check('disconnect drops the pooled connection', pool.has('live') === false)
    check('disconnect clears the intent', store.autoConnectHosts().includes('live') === false, JSON.stringify(store.autoConnectHosts()))
  }

  {
    // Not connected, but switched on (a host that never came up). The switch
    // going off must still remove it from the restore list.
    store.setHostAutoConnect('never-up', true)
    const { res, state } = fakeRes()
    await routeOf(routes, ROUTES.hostDisconnect).handler(fakeReq({ body: { alias: 'never-up' } }), res)
    check('disconnect without a live connection still clears the intent',
      JSON.parse(state.body).disconnected === false && store.autoConnectHosts().includes('never-up') === false,
      state.body)
  }

  {
    // Removing a host from the list removes the row; a stale intent would dial
    // a host that is no longer shown anywhere.
    store.setHostAutoConnect('imported', true)
    const { res, state } = fakeRes()
    await routeOf(routes, ROUTES.hostImport).handler(fakeReq({ body: { alias: 'imported', imported: false } }), res)
    check('removing an import answers ok', state.status === 200 && JSON.parse(state.body).ok === true, state.body)
    check('removing an import clears its intent', store.autoConnectHosts().includes('imported') === false, JSON.stringify(store.autoConnectHosts()))
  }

  {
    // "Test connection" is a probe and releases the connection it opened — but
    // not a switched-on host, where connected IS the requested state; releasing
    // it would make the probe look like it switched the host off.
    store.setHostAutoConnect('probe-host', true)
    const { res, state } = fakeRes()
    await routeOf(routes, ROUTES.test).handler(fakeReq({ body: { alias: 'probe-host' } }), res)
    const body = JSON.parse(state.body)
    check('a probe on a switched-on host keeps the connection',
      body.ok === true && body.released === false && pool.has('probe-host'), state.body)
    check('...and explains why it stayed', String(body.heldBy).includes('switched on'), state.body)
    pool.clear()
    store.setHostAutoConnect('probe-host', false)

    // The ordinary case is unchanged: a probe on a host nobody switched on still
    // goes away, which is what keeps "test" from doubling as "connect".
    const { res: res2, state: state2 } = fakeRes()
    await routeOf(routes, ROUTES.test).handler(fakeReq({ body: { alias: 'not-switched-on' } }), res2)
    const body2 = JSON.parse(state2.body)
    check('a probe on any other host still releases its connection',
      body2.ok === true && body2.released === true && pool.has('not-switched-on') === false, state2.body)
  }
}

// =============================================================== [5] the wiring
console.log('\n[5] activation wiring')
{
  const indexSource = readFileSync(path.join(pluginRoot, 'lib', 'index.js'), 'utf8')
  check('the keep-alive check is registered from the stored intent',
    /addKeepAliveCheck\(alias => hostIntent\.has\(alias\)\)/u.test(indexSource))
  check('the intent is built over the editable host store',
    /new HostIntent\(\{ store: engine\.store\.entryStore, engine, logger: ctx\.logger \}\)/u.test(indexSource))
  check('the restore runs on a later tick, never blocking activation',
    /setTimeout\(\(\) => \{\s*hostIntent\.restore\(\)/u.test(indexSource))
  check('a restore failure is caught instead of escaping activation',
    /hostIntent\.restore\(\)\.catch\(/u.test(indexSource))
}

for (const cleanup of cleanups) cleanup()

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
