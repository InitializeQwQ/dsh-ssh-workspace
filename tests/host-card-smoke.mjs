/** Exercise the SSH row and its overflow actions using the shipped component. */
import { readFileSync } from 'node:fs'
import { endOfBlock } from './support/toast-dom.mjs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('function HostCard (')
const bodyStart = source.indexOf(') {', start) + 2
const cardSource = source.slice(start, endOfBlock(source, bodyStart))

let passed = 0
let failures = 0
function check (name, ok) {
  if (ok) passed += 1
  else failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

const jsx = (type, props) => ({ type, props })
const icon = () => null

function render (conn, { host, expanded = false, confirming = null } = {}) {
  const calls = []
  const states = [expanded, confirming]
  const React = {
    useState: initial => [states.length > 0 ? states.shift() : initial, next => calls.push(['state', next])],
    useRef: () => ({ current: null }),
    useId: () => 'details-id',
  }
  const card = new Function('React', 'jsx', 'jsxs', 'Fragment', 'ServerIcon', 'FolderIcon', 'relativeTimeText',
    `${cardSource}; return HostCard`)(React, jsx, jsx, Symbol('Fragment'), icon, icon, () => 'now')
  const row = card({
    conn,
    host: { alias: 'alpha', user: 'deploy', host: 'example.test', port: 2222, auth: 'agent', source: 'store', ...host },
    t: key => key,
    onDisconnect: alias => calls.push(['disconnect', alias]),
    onReconnect: (alias, retry) => calls.push(['connect', alias, retry]),
    onBrowse: alias => calls.push(['browse', alias]),
    onDelete: row => calls.push(['delete', row.alias, row.source]),
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
check('secondary actions are hidden until expanded', !button(idle.row, 'test') && button(idle.row, 'more')['aria-expanded'] === false)

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
check('existing stored hosts keep their management actions', ['test', 'edit', 'delete', 'forget', 'toggle-workspace'].every(key => button(actions.row, key)))
const workspaceToggle = button(actions.row, 'toggle-workspace')
workspaceToggle.onClick()
check('workspace eligibility is controlled separately inside the overflow',
  workspaceToggle.children === 'hosts.allowWorkspace' && actions.calls.some(call => call.join() === 'toggle-workspace,alpha'))

const config = { source: 'ssh-config' }
const configRow = render(undefined, { expanded: true, host: config }).row
check('an imported host can be connected and removed, with its source config read-only',
  !button(configRow, 'connection').disabled && !button(configRow, 'edit') && !button(configRow, 'toggle-workspace') &&
  button(configRow, 'delete').children === 'hosts.removeImport')
const confirming = render(undefined, { expanded: true, confirming: 'delete', host: config })
button(confirming.row, 'confirm').onClick()
check('confirmed removal identifies the config reference instead of a stored host',
  hasText(confirming.row, 'hosts.removeImportDesc') && confirming.calls.some(call => call.join() === 'delete,alpha,ssh-config'))
const stale = render(undefined, { expanded: true, host: { ...config, unavailable: true } }).row
check('a stale import can be removed, with unavailable actions disabled',
  hasText(stale, 'hosts.importMissing') && button(stale, 'connection').disabled && button(stale, 'browse').disabled &&
  !button(stale, 'test') && !!button(stale, 'delete'))

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exitCode = failures === 0 ? 0 : 1
