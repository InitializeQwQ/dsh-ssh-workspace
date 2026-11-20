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

function render (conn, { host, expanded = false, action = null } = {}) {
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
    host: { alias: 'alpha', user: 'deploy', host: 'example.test', port: 2222, auth: 'agent', source: 'store', ...host },
    t: key => key,
    onDisconnect: alias => calls.push(['disconnect', alias]),
    onReconnect: (alias, retry) => calls.push(['connect', alias, retry]),
    onBrowse: alias => calls.push(['browse', alias]),
    onEdit: host => calls.push(['edit', host.alias]),
    onDelete: async row => { calls.push(['delete', row.alias, row.source]); return true },
    onToggle: alias => calls.push(['toggle-workspace', alias]),
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

const broken = render({ state: 'broken' })
check('a broken connection displays an error dot and offers connection on the switch',
  hasText(broken.row, 'connections.broken') && hasDot(broken.row, 'err') && button(broken.row, 'connection').title === 'hosts.connect')
for (const [phase, label] of [['waiting', 'reconnecting'], ['connecting', 'reconnectingNow'], ['gave-up', 'gaveUp']]) {
  const retry = render({ state: 'broken', retry: { phase, attempts: 2, nextAt: Date.now() + 60000, lastError: 'failed to connect' } })
  const retrySwitch = button(retry.row, 'connection')
  check(`a ${phase} retry is reported without claiming an active connection`,
    hasText(retry.row, `connections.${label}`) && hasDot(retry.row, 'warn') && !retrySwitch['aria-checked'] &&
    retrySwitch.title === 'connections.retry' && hasText(retry.row, 'failed to connect'))
  await retrySwitch.onClick()
  check(`a ${phase} retry can be requested immediately`, retry.calls.some(call => call.join() === 'connect,alpha,true'))
}

const actions = render(undefined, { expanded: true, host: { enabled: false } })
check('the more button identifies its menu while open',
  button(actions.row, 'more')['aria-haspopup'] === 'menu' && button(actions.row, 'more')['aria-controls'] === menuOf(actions.row).id)
check('existing stored hosts keep their management actions in the menu',
  ['details', 'test', 'edit', 'delete', 'forget', 'toggle-workspace'].every(key => menuItem(actions.row, key)))
const workspaceToggle = menuItem(actions.row, 'toggle-workspace')
workspaceToggle.onClick()
check('workspace eligibility is controlled separately inside the overflow',
  workspaceToggle.label === 'hosts.allowWorkspace' && actions.calls.some(call => call.join() === 'toggle-workspace,alpha'))
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
  !button(configRow, 'connection').disabled && !menuItem(configRow, 'edit') && !menuItem(configRow, 'toggle-workspace') &&
  menuItem(configRow, 'delete').label === 'hosts.removeImport')
menuItem(configRow, 'delete').onClick()
check('choosing removal opens confirmation without removing the host',
  imported.calls.some(call => call.join() === 'state,delete') && !imported.calls.some(call => call[0] === 'delete'))
const confirming = render(undefined, { action: 'delete', host: config })
await dialogOf(confirming.row).onConfirm()
check('confirmed removal identifies the config reference instead of a stored host',
  hasText(confirming.row, 'hosts.removeImportDesc') && confirming.calls.some(call => call.join() === 'delete,alpha,ssh-config'))
const stale = render(undefined, { expanded: true, host: { ...config, unavailable: true } }).row
const staleDetails = renderDetails(detailsOf(render(undefined, { action: 'details', host: { ...config, unavailable: true } }).row))
check('a stale import can be removed, with unavailable actions disabled',
  hasText(stale, 'hosts.importMissing') && button(stale, 'connection').disabled && button(stale, 'browse').disabled &&
  !menuItem(stale, 'test') && !!menuItem(stale, 'delete') && !button(staleDetails, 'edit'))

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
