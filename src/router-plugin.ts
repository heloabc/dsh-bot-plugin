/**
 * Host half of the Web router plugin.
 *
 * The whole feature lives in the browser: `client.js` mirrors the active
 * Session and the open main panel into `location.hash` and restores them on
 * `popstate`. Nothing is needed on the Host, so this entry only declares the
 * plugin identity for the Loader.
 */

/** Plugin display name used by the Loader. */
export const name = 'dsh-bot-router'

/** No Host services are required. */
export const inject = []

/** Host half is intentionally empty: routing is client-only. */
export function apply() {}
