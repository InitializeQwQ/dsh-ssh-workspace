/** Exercise the SSH row and its overflow actions using the shipped component. */
import { readFileSync } from 'node:fs'
import { endOfBlock } from './support/toast-dom.mjs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function componentSource (name) {
  const start = source.indexOf(`function ${name} (`)
  const bodyStart = source.indexOf(') {', start) + 2
  return source.slice(start, endOfBlock(source, bodyStart))
}

let passed = 0
let failures = 0
function check (name, ok) {
  if (ok) passed += 1
  else failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

const jsx = (type, props) => ({ type, props })
const icon = () => null
const menu = Symbol('HostActionMenu')
const dialog = Symbol('HostActionDialog')
const details = Symbol('HostDetailsDialog')

function render (conn, { host, expanded = false, action = null, autoConnect, connecting, failure } = {}) {
  const calls = []
  const states = [expanded, action]
  const React = {
    useState: initial => [states.length > 0 ? states.shift() : initial, next => calls.push(['state', next])],
    useRef: () => ({ current: null }),
    useId: () => 'details-id',
    useCallback: callback => callback,
  }
  const card = new Function('React', 'jsx', 'jsxs', 'Fragment', 'ServerIcon', 'FolderIcon', 'FileIcon', 'RefreshIcon',
    'CloseIcon', 'TrashIcon', 'HostActionMenu', 'HostActionDialog', 'HostDetailsDialog',
    `${componentSource('HostCard')}; return HostCard`)(
    React, jsx, jsx, Symbol('Fragment'), icon, icon, icon, icon, icon, icon, menu, dialog, details)
  const row = card({
    conn,
    autoConnect,
    connecting,
    failure,
    host: { alias: 'alpha', user: 'deploy', host: 'example.test', port: 2222, auth: 'agent', source: 'store', ...host },
    t: key => key,
    onDisconnect: alias => calls.push(['disconnect', alias]),
    onReconnect: (alias, retry) => calls.push(['connect', alias, retry]),
    onBrowse: alias => calls.push(['browse', alias]),
    onEdit: host => calls.push(['edit', host.alias]),
    onDelete: async row => { calls.push(['delete', row.alias, row.source]); return true },
  })
  return { row, calls }
}

function * elements (node) {
  if (Array.isArray(node)) {
    for (const child of node) yield * elements(child)
  } else if (node?.props) {
    yield node
    yield * elements(node.props.children)
  }
}
const button = (row, key) => [...elements(row)].find(node => node.type === 'button' && node.props.key === key)?.props
const menuOf = row => [...elements(row)].find(node => node.type === menu)?.props
const menuItem = (row, key) => menuOf(row)?.rows.find(item => item.key === key)
const dialogOf = row => [...elements(row)].find(node => node.type === dialog)?.props
const detailsOf = row => [...elements(row)].find(node => node.type === details)?.props
const hasText = (row, text) => [...elements(row)].some(node => node.props.children === text)
const hasDot = (row, state) => [...elements(row)].some(node => node.props.className === `sshwsp-dot sshwsp-dot-${state}`)

console.log('\n=== host card smoke ===\n')

const idle = render()
const connection = button(idle.row, 'connection')
check('an idle host is shown as disconnected with a neutral dot', hasText(idle.row, 'connections.idle') && hasDot(idle.row, 'idle'))
check('the switch reflects a live connection, independent of workspace eligibility', connection.role === 'switch' && connection['aria-checked'] === false && !connection.disabled)
await connection.onClick()
check('switching on requests a real connection', idle.calls.some(call => call.join() === 'connect,alpha,false'))
button(idle.row, 'browse').onClick()
check('the folder shortcut passes the selected alias', idle.calls.some(call => call.join() === 'browse,alpha'))
check('secondary actions are hidden until expanded', !menuOf(idle.row) && button(idle.row, 'more')['aria-expanded'] === false)

const connected = { state: 'connected', inFlight: 0 }
const live = render(connected, { host: { enabled: false } })
const liveSwitch = button(live.row, 'connection')
check('a live connection has a green dot and an on switch even when workspace creation is disabled',
  liveSwitch['aria-checked'] === true && hasText(live.row, 'connections.connected') && hasDot(live.row, 'ok'))
await liveSwitch.onClick()
check('switching off disconnects the live host', live.calls.some(call => call.join() === 'disconnect,alpha'))
const busy = render({ ...connected, inFlight: 3 })
check('a connection with work in flight cannot be disconnected and explains why',
  button(busy.row, 'connection').disabled && button(busy.row, 'connection').title === 'hosts.disconnectBusy' &&
  hasText(busy.row, 'connections.inFlight'))

// A host the user has NOT enabled reports the plain fact, whatever it remembers:
// no red dot, no "connection failed", no leftover retry countdown. The switch is
// the statement "this host should be connected", and an off host is simply not.
const broken = render({ state: 'broken' })
check('a broken connection on a switched-off host reads as not connected',
  hasText(broken.row, 'connections.idle') && hasDot(broken.row, 'idle') &&
  button(broken.row, 'connection').title === 'hosts.connect' && !hasText(broken.row, 'connections.failed'))
const disabledFailure = render(undefined, { failure: 'host key refused' })
check('a remembered failure is hidden while the switch is off',
  hasText(disabledFailure.row, 'connections.idle') && hasDot(disabledFailure.row, 'idle') &&
  !hasText(disabledFailure.row, 'host key refused'))
const disabledRetry = render(
  { state: 'broken', retry: { phase: 'waiting', attempts: 2, nextAt: Date.now() + 1000, lastError: 'failed to connect' } })
check('a leftover retry is hidden too while the switch is off',
  hasText(disabledRetry.row, 'connections.idle') && hasDot(disabledRetry.row, 'idle') &&
  !hasText(disabledRetry.row, 'connections.reconnecting') && !hasText(disabledRetry.row, 'connections.failed'))

// Enabled, a failure is its own state: red dot + "连接失败". The engine's
// message is the only evidence of a fatal attempt (it arms no retry), so it
// travels under the row.
const brokenWanted = render({ state: 'broken' }, { autoConnect: true })
check('an enabled host with a broken connection says the connection failed, with an error dot',
  hasText(brokenWanted.row, 'connections.failed') && hasDot(brokenWanted.row, 'err') &&
  button(brokenWanted.row, 'connection').title === 'hosts.disconnectAuto')
const failedHost = render(undefined, { autoConnect: true, failure: 'host key refused' })
check('a failed connection keeps the switch on and says it failed',
  hasText(failedHost.row, 'connections.failed') && hasDot(failedHost.row, 'err') &&
  button(failedHost.row, 'connection')['aria-checked'] === true)
check('...and the engine message is shown under the row', hasText(failedHost.row, 'host key refused'))

// A switched-off host that still has a retry row can be dialed with its switch.
const offRetry = render({ state: 'broken', retry: { phase: 'waiting', attempts: 2, nextAt: Date.now() + 60000, lastError: 'failed to connect' } })
check('a switched-off host with a leftover retry reads as not connected and still offers a manual retry',
  hasText(offRetry.row, 'connections.idle') && hasDot(offRetry.row, 'idle') &&
  button(offRetry.row, 'connection').title === 'connections.retry')
await button(offRetry.row, 'connection').onClick()
check('...and the switch asks for an immediate retry', offRetry.calls.some(call => call.join() === 'connect,alpha,true'))

// A retrying ENABLED host has also failed — the countdown is what is being done
// about it, so it renders beside the failure sentence instead of replacing it.
for (const [phase, detail] of [['waiting', 'reconnecting'], ['connecting', 'reconnectingNow'], ['gave-up', null]]) {
  const retry = render(
    { state: 'broken', retry: { phase, attempts: 2, nextAt: Date.now() + 60000, lastError: 'failed to connect' } },
    { autoConnect: true })
  const retrySwitch = button(retry.row, 'connection')
  check(`an enabled host with a ${phase} retry is reported as a failed connection, not a live one`,
    hasText(retry.row, 'connections.failed') && hasDot(retry.row, 'err') && retrySwitch['aria-checked'] === true &&
    retrySwitch.title === 'hosts.disconnectAuto' && hasText(retry.row, 'failed to connect'))
  check(`...with the ${phase} retry sentence ${detail === null ? 'suppressed once it gave up' : 'beside the failure'}`,
    detail === null
      ? !hasText(retry.row, 'connections.reconnecting') && !hasText(retry.row, 'connections.reconnectingNow')
      : hasText(retry.row, `connections.${detail}`))
}

// A switched-on host (the stored intent, see lib/host-intent.js) is shown ON
// while the activation restore is still connecting it — the switch is the
// desired state, and the status line is the actual one. Reading "off" for the
// whole handshake after a restart is what made the setting look lost.
const starting = render(undefined, { autoConnect: true, connecting: true })
const startingSwitch = button(starting.row, 'connection')
check('a switched-on host starts out on and says it is connecting',
  startingSwitch['aria-checked'] === true && hasText(starting.row, 'connections.autoConnecting') &&
  hasDot(starting.row, 'warn') && startingSwitch.title === 'hosts.disconnectAuto')
await startingSwitch.onClick()
check('switching it off while connecting asks for a disconnect (which clears the intent)',
  starting.calls.some(call => call.join() === 'disconnect,alpha'))

// The pending list belongs to the restore, not to a promise about a host the
// user just switched off: without the intent the card must not claim to be
// connecting (the pass may still be holding the alias for a moment).
const switchedOffMidPass = render(undefined, { autoConnect: false, connecting: true })
check('a host switched off mid-restore does not keep saying connecting',
  !hasText(switchedOffMidPass.row, 'connections.autoConnecting') &&
  button(switchedOffMidPass.row, 'connection')['aria-checked'] === false &&
  hasText(switchedOffMidPass.row, 'connections.idle'))

const startedLive = render({ state: 'connected', inFlight: 0 }, { autoConnect: true })
check('a switched-on host that finished connecting reports connected and stays on',
  button(startedLive.row, 'connection')['aria-checked'] === true && hasText(startedLive.row, 'connections.connected'))
check('a live host that is not switched on still offers a plain disconnect',
  button(live.row, 'connection').title === 'hosts.disconnect')

const wantedRetry = render(
  { state: 'broken', retry: { phase: 'waiting', attempts: 1, nextAt: Date.now() + 1000, lastError: 'failed to connect' } },
  { autoConnect: true })
check('a switched-on host that is retrying stays on and reports the retry',
  button(wantedRetry.row, 'connection')['aria-checked'] === true &&
  hasText(wantedRetry.row, 'connections.reconnecting') &&
  button(wantedRetry.row, 'connection').title === 'hosts.disconnectAuto')
await button(wantedRetry.row, 'connection').onClick()
check('...and its switch turns the intent off instead of retrying',
  wantedRetry.calls.some(call => call.join() === 'disconnect,alpha') &&
  !wantedRetry.calls.some(call => call.join() === 'connect,alpha,true'))

// The card can only show the intent if the panel actually feeds it; asserted on
// the source because the call site is inside the page component, which this
// suite does not render.
check('the panel feeds the card the stored intent, the restore pending list and the failure',
  /autoConnect: \(status\.autoConnect \?\? \[\]\)\.includes\(host\.alias\)/u.test(source) &&
  /connecting: \(status\.connecting \?\? \[\]\)\.includes\(host\.alias\)/u.test(source) &&
  /failure: failureMap\.get\(host\.alias\)/u.test(source) &&
  /for \(const row of status\.failures \?\? \[\]\)/u.test(source))

const actions = render(undefined, { expanded: true })
check('the more button identifies its menu while open',
  button(actions.row, 'more')['aria-haspopup'] === 'menu' && button(actions.row, 'more')['aria-controls'] === menuOf(actions.row).id)
// ONE menu for every host type: the stored/manual host does not grow extra
// entries. Editing lives in the details dialog's pencil, and there is no
// separate "allow new workspaces" switch (the connection switch decides).
check('a manually added host keeps exactly the four management actions',
  ['details', 'reconnect', 'forget', 'delete'].every(key => menuItem(actions.row, key)) &&
  !menuItem(actions.row, 'edit') && !menuItem(actions.row, 'toggle-workspace') &&
  menuOf(actions.row).rows.length === 4)
const failedMenu = render(undefined, { expanded: true, autoConnect: true, failure: 'host key refused' })
const reconnect = menuItem(failedMenu.row, 'reconnect')
await reconnect.onClick()
check('the menu reconnects an enabled host after a failed attempt',
  reconnect.label === 'hosts.reconnect' && !reconnect.disabled &&
  failedMenu.calls.some(call => call.join() === 'connect,alpha,true') &&
  !failedMenu.calls.some(call => call[0] === 'disconnect'))
menuItem(actions.row, 'details').onClick()
check('host details open only after choosing that menu item',
  !detailsOf(actions.row) && actions.calls.some(call => call.join() === 'state,details'))

const renderDetails = new Function('jsx', 'jsxs', 'useDialogA11y', 'backdropDismiss', 'modalLayer', 'GlobeIcon',
  'CloseIcon', 'MENU_GLYPH_PATHS', `${componentSource('HostDetailsDialog')}; return HostDetailsDialog`)(
  jsx, jsx, () => ({ props: { role: 'dialog' }, titleId: 'host-name' }),
  () => ({}), child => child, icon, icon, { rename: [] })
const detailHost = render(undefined, { action: 'details', host: { auth: 'key', keyPath: '~/.ssh/test', keyReady: false } })
const detailTree = renderDetails(detailsOf(detailHost.row))
const fieldsOf = tree => [...elements(tree)].filter(node => node.type === 'dd').map(node => node.props.children)
const fieldLabels = [...elements(detailTree)].filter(node => node.type === 'dt').map(node => node.props.children)
check('details show the five requested fields in order',
  fieldLabels.join() === 'editor.alias,editor.host,editor.port,editor.user,hosts.details.identity' &&
  fieldsOf(detailTree).join() === 'alpha,example.test,2222,deploy,~/.ssh/test')
button(detailTree, 'edit').onClick()
check('the pencil opens the host editor and connection actions stay in the list',
  detailHost.calls.some(call => call.join() === 'edit,alpha') && !button(detailTree, 'connection'))

const importedDetails = { action: 'details', host: { source: 'ssh-config', identityFile: '~/.ssh/id_rsa' } }
const importedInspector = render(undefined, importedDetails)
const idleTree = renderDetails(detailsOf(importedInspector.row))
const liveTree = renderDetails(detailsOf(render({ ...connected, identityFile: '/different/runtime/key' }, importedDetails).row))
check('the imported identity field is the same before and after connecting',
  fieldsOf(idleTree).join() === fieldsOf(liveTree).join() && fieldsOf(liveTree)[4] === '~/.ssh/id_rsa' &&
  hasDot(idleTree, 'idle') && hasDot(liveTree, 'ok'))
button(idleTree, 'edit').onClick()
check('the pencil opens the editor for an imported host both offline and online',
  importedInspector.calls.some(call => call.join() === 'edit,alpha') && !!button(liveTree, 'edit'))
const disabledIdentityTree = renderDetails(detailsOf(render(undefined, {
  action: 'details', host: { source: 'ssh-config', identityFile: null, keyPath: 'none' },
}).row))
check('a host configured without an identity file still displays the field',
  fieldsOf(disabledIdentityTree)[4] === '—')

const config = { source: 'ssh-config' }
const imported = render(undefined, { expanded: true, host: config })
const configRow = imported.row
check('an imported host can be connected and removed, with its source config read-only',
  !button(configRow, 'connection').disabled &&
  menuItem(configRow, 'delete').label === 'hosts.removeImport')
check('a stored host and an imported host expose the same menu actions',
  menuOf(configRow).rows.map(item => item.key).join() === menuOf(actions.row).rows.map(item => item.key).join(),
  `${menuOf(actions.row).rows.map(item => item.key)} vs ${menuOf(configRow).rows.map(item => item.key)}`)
menuItem(configRow, 'delete').onClick()
check('choosing removal opens confirmation without removing the host',
  imported.calls.some(call => call.join() === 'state,delete') && !imported.calls.some(call => call[0] === 'delete'))
const confirming = render(undefined, { action: 'delete', host: config })
await dialogOf(confirming.row).onConfirm()
check('confirmed removal identifies the config reference instead of a stored host',
  hasText(confirming.row, 'hosts.removeImportDesc') && confirming.calls.some(call => call.join() === 'delete,alpha,ssh-config'))
const stale = render(undefined, { expanded: true, host: { ...config, unavailable: true } }).row
const staleDetails = renderDetails(detailsOf(render(undefined, { action: 'details', host: { ...config, unavailable: true } }).row))
const statusTitle = row => [...elements(row)].find(node => node.props.className === 'sshwsp-host-status')?.props.title
check('a disabled stale import reads as not connected, with unavailable actions disabled',
  hasText(stale, 'connections.idle') && hasDot(stale, 'idle') && statusTitle(stale) === 'hosts.importMissing' &&
  button(stale, 'connection').disabled && button(stale, 'browse').disabled &&
  !menuItem(stale, 'reconnect') && !!menuItem(stale, 'delete') && !button(staleDetails, 'edit'))
// A host whose config vanished can still carry a stored intent. Turning it OFF
// must stay possible (that is how the intent is dropped); turning it ON has
// nowhere to dial, so only the on-direction is disabled.
const staleWanted = render(undefined, { host: { ...config, unavailable: true }, autoConnect: true })
check('a vanished host that is still switched on explains itself and can be switched off',
  hasText(staleWanted.row, 'hosts.importMissing') && hasDot(staleWanted.row, 'err') &&
  button(staleWanted.row, 'connection')['aria-checked'] === true &&
  !button(staleWanted.row, 'connection').disabled)
await button(staleWanted.row, 'connection').onClick()
check('...and doing so is a disconnect request', staleWanted.calls.some(call => call.join() === 'disconnect,alpha'))

function renderMenuAt (trigger) {
  const node = { style: {}, getBoundingClientRect: () => ({ width: 220, height: 130 }) }
  const anchorRef = { current: { getBoundingClientRect: () => trigger } }
  const React = { useLayoutEffect: effect => effect(), useEffect: () => {} }
  const window = { innerWidth: 400, innerHeight: 320, addEventListener: () => {} }
  const component = new Function('React', 'jsx', 'jsxs', 'Fragment', 'modalLayer', 'useMenuKeyboard', 'window',
    `${componentSource('HostActionMenu')}; return HostActionMenu`)(
    React, jsx, jsx, Symbol('Fragment'), child => ({ type: 'portal', props: { children: child } }),
    () => ({ current: node }), window)
  const tree = component({ anchorRef, rows: [{ key: 'test', icon, label: 'Test' }] })
  return { tree, style: node.style }
}

const placed = renderMenuAt({ right: 370, top: 24, bottom: 56 })
check('the list is portalled outside the host layout and aligns under the trigger',
  placed.tree.type === 'portal' && placed.tree.props.children.props.role === 'menu' &&
  placed.style.left === '150px' && placed.style.top === '62px')
const flipped = renderMenuAt({ right: 95, top: 280, bottom: 312 })
check('the list flips above the trigger and stays inside narrow viewports',
  flipped.style.left === '8px' && flipped.style.top === '144px')

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exitCode = failures === 0 ? 0 : 1
