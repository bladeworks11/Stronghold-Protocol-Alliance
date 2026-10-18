// public/js/prefBus.js — who wants to know about a write to a persisted preference (`sp.pref.*`). Kept apart from
// store.js so that a pure-logic module can report a write of its own: ui/stats.js saves its match history to localStorage
// directly (it shrinks the envelope when the quota refuses it, store.js savePref cannot), and the account sync
// (public/js/profile.js) must still learn that `stats` changed. No imports, no DOM, no Preact.

/** @type {Set<(key: string, value: any) => void>} */
const listeners = new Set();

/**
 * Observe every preference write (store.js savePref, ui/stats.js saveStats).
 * @param {(key: string, value: any) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onPrefSaved(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Tell the listeners about a write that did not go through savePref.
 * @param {string} key the preference's key (the part after `sp.pref.`)
 * @param {any} value what was stored
 */
export function notePrefSaved(key, value) {
  for (const fn of [...listeners]) {
    try { fn(key, value); } catch (err) { console.error('[prefs] a listener failed', err); }
  }
}
