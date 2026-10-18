// server/statsRecord.js — the server's own copy of a finished match (账号同步: 对局统计, one record per human player).
//
// The browser has always built these records from the m.result it receives (public/js/ui/stats.js buildRecord) and the
// account store only kept what it uploaded. Now the server writes the record itself, at the moment of settlement, for
// every player whose nickname has an account:
//
//   * the record's `id` comes from shared/statsRecord.js — the same function the browser uses — so the two copies of one
//     match collapse on merge (server/profiles.js mergeStatEnvelopes, public/js/ui/stats.js mergeStats) instead of
//     doubling it;
//   * a client therefore does not have to upload finished matches at all: it writes its own copy for the history it shows
//     and uploads only what the server cannot know (a match left early, buildQuitRecord) — that is the traffic saving of
//     this design (public/js/profile.js upload);
//   * nothing here ever blocks a settlement: createSettlementSink returns a function the lobby calls after the frame was
//     sent, and the write runs fire-and-forget (a failing disk is a warning in the log, never a broken game).
//
// What is written is the settlement payload the server itself built (server/match/results.js buildResult), so the numbers
// are as trustworthy as the match: under SP_COMBAT=client the battle figures are still what the clients reported (that is
// SP_VERIFY's job); what the server adds is that the match, its players, its outcome and the row of the player in question
// are the ones the server saw, not ones a browser wrote into localStorage.
//
// `msg.stub === true` (server/match/StubMatch.js: a room abandoned before its match began) is not recorded: no match was
// played. A player without an account is skipped — sync is opt-in, and profiles.has() is one stat call.

import { STATS_VERSION, recordId, vsOf, contentOf, roomModeOf } from '../shared/statsRecord.js';
import { sanitizeName } from './net.js';

/** A number or null (the record schema's numeric fields). @param {unknown} v */
const num = (v) => (Number.isFinite(v) ? /** @type {number} */ (v) : null);
/** A string or null. @param {unknown} v */
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * The record one player's copy of a settlement payload becomes. Null when the payload cannot make one: no players, or
 * no row of `myId` in it (a spectator seat receives the settlement too, with no row of its own).
 * @param {any} res the raw `m.result` payload
 * @param {{ myId?: string|null, roomMode?: 'solo'|'coop'|null, vs?: string|null, content?: any, now?: number }} [ctx]
 *   vs / content: the room's visual and content set (room.state.content), so a match with plugins is recorded as such
 * @returns {any|null}
 */
export function buildSettlementRecord(res, ctx = {}) {
  const r = res && typeof res === 'object' ? res : {};
  const players = Array.isArray(r.players) ? r.players : [];
  const myId = typeof ctx.myId === 'string' && ctx.myId ? ctx.myId : '';
  if (!myId || !players.length) return null;
  if (!players.some((p) => p && p.playerId === myId)) return null;
  return {
    id: recordId(r, myId),
    v: STATS_VERSION,
    t: Number.isFinite(ctx.now) ? Math.round(/** @type {number} */ (ctx.now)) : 0,
    end: 'settled',
    victory: !!r.victory,
    roundsPassed: Number.isFinite(r.roundsPassed) ? Math.round(r.roundsPassed) : 0,
    lastRound: num(r.lastRound),
    hiddenReached: !!r.hiddenReached,
    hiddenCleared: !!r.hiddenCleared,
    reason: str(r.reason),
    modeId: str(r.modeId),
    difficulty: str(r.difficulty),
    stageId: str(r.stageId),
    bossId: str(r.bossId),
    hiddenBossId: str(r.hiddenBossId),
    seed: num(r.seed),
    durationMs: num(r.durationMs),
    teamLp: num(r.teamLp),
    roomMode: roomModeOf(str(r.modeId), ctx.roomMode ?? null),
    selfId: myId,
    vs: vsOf(ctx.vs),
    content: contentOf(ctx.content),
    // the rows as the settlement built them: the page normalizes a record when it reads one (ui/stats.js normalizeRecord)
    players,
  };
}

/**
 * The lobby's settlement hook: `statsSink(room, playerId, msg)`.
 * @param {{ profiles: { has: (name: string) => Promise<boolean>, write: (name: string, values: object, append: any) => Promise<any> },
 *           log?: object, now?: () => number }} opts
 * @returns {((room: any, playerId: string|null, msg: any) => void) | null}
 */
export function createSettlementSink({ profiles, log = null, now = () => Date.now() }) {
  if (!profiles) return null;
  /**
   * @param {any} room the room the match belonged to (its mode and plugin sets)
   * @param {string|null} playerId the recipient of a unicast m.result, or null for a broadcast one
   * @param {any} msg the m.result frame
   */
  return function recordSettlement(room, playerId, msg) {
    if (!msg || msg.t !== 'm.result' || msg.stub === true) return;
    const players = Array.isArray(msg.players) ? msg.players : [];
    if (!players.length) return;
    const rows = playerId == null ? players : players.filter((p) => p && p.playerId === playerId);
    if (!rows.length) return;
    void (async () => {
      for (const row of rows) {
        if (!row || row.isBot) continue;
        const name = sanitizeName(row.name);
        if (!name) continue;
        try {
          if (!await profiles.has(name)) continue; // sync is off for this nickname: nothing to write
          const record = buildSettlementRecord(msg, {
            myId: row.playerId,
            roomMode: room?.mode ?? null,
            vs: room?.content?.vs ?? null,
            content: room?.content ?? null,
            now: now(),
          });
          if (!record) continue;
          await profiles.write(name, {}, { stats: { v: STATS_VERSION, records: [record] } });
        } catch (e) {
          log?.warn?.(`[profiles] ${name}: settlement record not saved (${e?.code || e?.message || e})`);
        }
      }
    })();
  };
}
