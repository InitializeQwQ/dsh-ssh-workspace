/**
 * Persisted per-host connection intent: the hosts the user switched on.
 *
 * ## Why the panel switch alone is not enough
 *
 * The switch on a host card reflects the LIVE pool, and a socket does not
 * survive the process. Without a stored intent every DSH start begins with all
 * hosts disconnected even though the user had turned several on — the panel is
 * then the only place the intent exists, and it is gone. The intent is written
 * when the switch goes on (`POST /hosts/reconnect` → `autoConnect` in the host
 * store), cleared when it goes off (`POST /hosts/disconnect`), and read back on
 * activation by {@link HostIntent#restore}.
 *
 * ## Why it is a separate section, not the entry's `enabled` flag
 *
 * `enabled` answers "may this host be picked for a NEW workspace?"; this answers
 * "keep this host connected". They are independent on purpose: a host can be
 * useful as a live target for forwards and exec without being offered for new
 * workspaces, and disabling a host for workspace creation must not silently
 * tear down its connection. It is also the only shape that can cover a
 * `~/.ssh/config` host, which has no editable record to carry a flag.
 *
 * ## No cache
 *
 * `has()` reads the store on every call instead of keeping a copy. The same
 * predicate is registered as the engine's keep-alive check, so it decides
 * whether the idle sweeper may close a connection and whether the reconnect
 * loop redials after a drop; a stale in-memory copy would keep alive exactly the
 * host the user just switched off. A tiny synchronous read per minute is the
 * cheap half of that trade.
 *
 * @module @initializeqwq/dsh-ssh-workspace/host-intent
 */

import { KINDS } from './diagnostics.js'

export class HostIntent {
  /**
   * @param {object} options - wiring.
   * @param {import('./store.js').HostConfigStore} options.store - the editable host store.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - the connection engine.
   * @param {object} [options.logger] - a Cordis logger, when available.
   */
  constructor ({ store, engine, logger } = {}) {
    this.store = store
    this.engine = engine
    this.logger = logger
    /** Single-flight guard: two activations must not dial every host twice. */
    this.restoring = false
    /**
     * Aliases the CURRENT restore pass has not dialed yet (or is dialing now).
     *
     * Read by the panel through `/status` so a switched-on host can say
     * "connecting" from the first poll instead of "not connected" while the
     * handshake is still in flight.
     *
     * @type {Set<string>}
     */
    this.pending = new Set()
  }

  /**
   * The aliases the current restore pass is still working on.
   *
   * Empty outside an activation restore, so this is "connecting right now"
   * rather than "wanted": a host that already failed (or gave up) must not keep
   * claiming to be connecting.
   *
   * @returns {string[]} aliases in flight or queued for this pass.
   */
  pendingAliases () {
    return [...this.pending]
  }

  /** The aliases the user switched on, in store order. */
  list () {
    try {
      return this.store?.autoConnectHosts?.() ?? []
    } catch {
      // An unreadable store is reported by the host listing; restoring nothing
      // is the safe half of a damaged file.
      return []
    }
  }

  /**
   * Whether one host's connection was switched on.
   *
   * Registered as the engine's keep-alive check (see `engine.addKeepAliveCheck`),
   * which makes this answer do double duty: the idle sweeper leaves the
   * connection alone, and the reconnect loop treats the host as wanted after a
   * drop. Both are what "keep this host connected" means once the panel is
   * closed.
   *
   * @param {string} alias - host alias.
   * @returns {boolean} true when the connection should stay up.
   */
  has (alias) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return false
    return this.list().includes(target)
  }

  /**
   * Reconnect every host the user switched on.
   *
   * Runs serially and never throws: a boot that failed because one host is
   * unreachable would be worse than a host that did not come back. A failed
   * attempt is handed to the reconnect loop by `acquire`'s own foreground-failure
   * path (`noteLost`, skipped for fatal descriptor errors), where the stored
   * intent is what makes the host "wanted" — so a machine whose network is not
   * up yet at boot keeps being retried instead of ending up silently off.
   *
   * Deliberately `acquire`, not the scheduler's manual `retryNow`: the latter
   * runs the restore hook on success, which re-opens saved port forwards and
   * would make a switched-on host open its tunnels at startup even when the
   * panel's own "open saved tunnels on startup" preference is off. A host being
   * connected and a tunnel being restored are two separate choices.
   *
   * Called on a later tick from `lib/index.js`, exactly like the saved-tunnel
   * auto-start: an unreachable host must not delay the plugin's own activation.
   *
   * @returns {Promise<{connected: number, failed: Array<{alias: string, error: string}>}>} the outcome.
   */
  async restore () {
    if (this.restoring) return { connected: 0, failed: [] }
    const aliases = this.list()
    if (aliases.length === 0) return { connected: 0, failed: [] }
    this.restoring = true
    // The aliases this pass still has to dial. Served through `pendingAliases()`
    // so the panel can show "connecting" from the first poll, including for the
    // hosts queued behind a slow handshake — the switch is already on (stored
    // intent), and "not connected" would be the only other thing it could say.
    this.pending = new Set(aliases)
    let connected = 0
    const failed = []
    try {
      // Serial on purpose: several hosts would otherwise open their handshakes
      // at once, competing with DSH's own boot work, and a burst of failures is
      // harder to attribute than one.
      for (const alias of aliases) {
        // The list was captured when the pass began. A host switched off while
        // an earlier (possibly slow) attempt was running must not be dialed by
        // this pass — the switch going off is the user's statement, and the
        // disconnect route already cleared the stored intent.
        if (!this.has(alias)) {
          this.pending.delete(alias)
          continue
        }
        try {
          await this.engine.acquire(alias)
          connected += 1
        } catch (error) {
          // A disposed engine (the plugin was unloaded mid-restore), a broken
          // descriptor, or a host that is simply offline: record it for this
          // host and keep going with the rest.
          const message = error instanceof Error ? error.message : String(error)
          failed.push({ alias, error: message })
          // The diagnostics ring is the ONLY channel a user can read in this
          // deployment (ctx.logger has no exporter). A retryable failure also
          // shows up as `reconnecting` in the status, but a fatal one (unknown
          // alias, refused host key) arms no loop at all — without this event
          // the host would just quietly never come back.
          try {
            this.engine?.diagnostics?.record(KINDS.reconnect, `could not reconnect ${alias} on startup: ${message}`, { alias })
          } catch { /* diagnostics must never fail the restore */ }
        } finally {
          this.pending.delete(alias)
        }
      }
    } finally {
      this.pending.clear()
      this.restoring = false
    }
    if (connected > 0) this.logger?.info?.(`ssh-workspace: reconnected ${connected} host(s) the user had switched on`)
    for (const failure of failed) {
      this.logger?.warn?.(`ssh-workspace: could not reconnect ${failure.alias} on startup: ${failure.error}`)
    }
    return { connected, failed }
  }
}
