// shared/statsRecord.js — the contract of a 对局统计 record between the browser and the server. A record's `id` is derived
// from the settlement payload alone (seed, duration, mode, rounds, victory, and whose row it is), so the same finished
// match produces the same id on both sides: the server writes its record at settlement (server/statsRecord.js), the
// browser writes its own copy for the history it shows (public/js/ui/stats.js buildRecord), and the account store merges
// them by id — neither duplicates the other (server/profiles.js mergeStatEnvelopes, public/js/ui/stats.js mergeStats).

/** Envelope version of `sp.pref.stats` (public/js/ui/stats.js kept this; the server writes envelopes with it). */
export const STATS_VERSION = 2;

/** Match records kept in one envelope (the browser trims to it, the server merge caps at it). */
export const MAX_RECORDS = 1000;

/**
 * FNV-1a 32-bit, hex — a content hash needs no crypto, only stability across sessions.
 * @param {string} s
 * @returns {string}
 */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The record's dedupe id, from match facts the server replays byte-identically on reconnect / reload
 * (server/lobby.js result replay): seed + duration + mode + rounds + outcome + who I was. Two distinct
 * matches colliding on all of these is not a real scenario; a replayed m.result hits the same id and is
 * dropped, which is the point (recording happens on every m.result arrival, replays included).
 * @param {any} res raw m.result payload
 * @param {string|null|undefined} myId the local player's id at that moment
 * @returns {string}
 */
export function recordId(res, myId) {
  const r = res && typeof res === 'object' ? res : {};
  const parts = [r.seed ?? '-', r.durationMs ?? '-', r.modeId ?? '-', r.roundsPassed ?? '-', r.victory ? 1 : 0, myId ?? '-'];
  // A test result must not collide with a real match of the same seed (upstream 0.3.1): the suffix is absent otherwise.
  if (r.test === true) parts.push('test');
  return `r1.${fnv1a(parts.join('|'))}`;
}

/** A plain object (not null, not an array). @param {any} v */
export const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A visual hash (64 lowercase hex digits: shared/plugins/visual.js), else null. @param {any} v */
export const vsOf = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null);

/**
 * The content set a record names: `{ cs, plugins: ['<id>@<version>' …] }` of a room with gameplay plugins —
 * room.state.content with `vanilla: false`, or a record's own — else null (the original game).
 * @param {any} c
 */
export function contentOf(c) {
  if (!isObj(c) || c.vanilla === true || !vsOf(c.cs)) return null;
  const list = (Array.isArray(c.plugins) ? c.plugins : [])
    .map((p) => (typeof p === 'string' ? p : isObj(p) && typeof p.id === 'string' ? `${p.id}@${typeof p.version === 'string' ? p.version : '?'}` : null))
    .filter((x) => typeof x === 'string' && x.length <= 80).slice(0, 32);
  return { cs: c.cs, plugins: list };
}

/** Did the record's match play gameplay plugins (unofficial)? @param {any} rec */
export const isModdedRecord = (rec) => !!(isObj(rec) && rec.content);

/**
 * The room shape ('solo' | 'coop') the way constants.js modeIdFor builds modeIds.
 * @param {string|null|undefined} modeId
 * @param {string|null|undefined} roomMode room.state `mode` when known
 * @returns {'solo'|'coop'|null}
 */
export function roomModeOf(modeId, roomMode) {
  if (roomMode === 'solo' || roomMode === 'coop') return roomMode;
  if (typeof modeId !== 'string') return null;
  if (modeId.includes('_single_')) return 'solo';
  if (modeId.includes('_multi_')) return 'coop';
  return null;
}
