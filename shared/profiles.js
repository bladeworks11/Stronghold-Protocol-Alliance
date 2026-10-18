// shared/profiles.js — what the browser and the server agree on about 账号同步 (account sync): one nickname is one
// account, without a password; the server keeps that account's preferences (`sp.pref.*` of the browser) in `profiles/`.
//
// This file holds only the contract — the URL, the limits and what a preference key may be — so that the two sides and the
// tests cannot drift: server/profiles.js stores and serves it, public/js/profile.js syncs it.
//
// The server never interprets a preference: every value is the JSON the browser keeps in `sp.pref.<key>`, except `stats`,
// where the server merges the records of both sides by id (mergeStatEnvelopes) so two devices cannot overwrite each
// other's matches.

import { NAME_MAX_LEN } from './constants.js';

/** Where the accounts live (`GET` / `PUT` / `DELETE` `<PROFILE_API>/<name>`; server/profiles.js). */
export const PROFILE_API = '/api/profile';

/** Format version of a stored account (a future change bumps it; server/profiles.js writes it, the client ignores it). */
export const PROFILE_VERSION = 1;

/** Bounds of an account and of the requests that touch it [ASSUMED: a settings blob, not a data store]. */
export const PROFILE_LIMITS = Object.freeze({
  /** A nickname is at most NAME_MAX_LEN code points (the protocol's hello.name, shared/constants.js). */
  nameChars: NAME_MAX_LEN,
  /** Preference keys in one account. */
  keys: 64,
  /** Characters of one preference key. */
  keyChars: 64,
  /** Bytes of one preference value (the stats envelope alone may reach ~1.6 MB). */
  keyBytes: 2 * 1024 * 1024,
  /** Bytes of a request body (the sum of the values a client uploads). */
  bodyBytes: 4 * 1024 * 1024 + 4096,
  /** Match records kept in the `stats` envelope (public/js/ui/stats.js MAX_RECORDS; a test keeps them equal). */
  records: 1000,
  /** Accounts on one server (further writes answer 503). */
  profiles: 2000,
  /** Reads / writes per client address and minute (429 beyond). */
  readsPerMin: 240,
  writesPerMin: 120,
});

/** A preference key: the part after `sp.pref.` — letters, digits, `.`, `_`, `-` (settings, lobby.mode, ui-plugins …). */
export const PROFILE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Whether a string may be a preference key of an account.
 * @param {unknown} key
 * @returns {boolean}
 */
export const isProfileKey = (key) => typeof key === 'string' && PROFILE_KEY_RE.test(key);

/**
 * The URL of one account.
 * @param {string} name a nickname (the server normalises it again: server/net.js sanitizeName)
 * @returns {string}
 */
export const profileUrl = (name) => `${PROFILE_API}/${encodeURIComponent(String(name))}`;
