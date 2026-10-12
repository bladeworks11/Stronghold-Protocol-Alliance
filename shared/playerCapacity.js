// Capacity rules shared by the server and browser: seat groups, card-pool scaling and the co-op phase limits that
// grow with the number of players. Ported from LongQianChen/Stronghold-Protocol feat/IncreasePlayerCapacity.
//
// The model, in one place so the server and the client can never disagree:
//   * A co-op match with fewer than GROUPED_POOL_MIN_PLAYERS players shares ONE card pool, exactly like the original
//     1–4 player game.
//   * From six players on, the occupied seats are split into FIXED groups of three, four or five (seat order). Each
//     group gets its own shared chess pool and its own equipment stock, so a twenty-player room is five independent
//     four-player shops rather than one pool twenty players fight over.
//   * Groups are assigned once at match start and NEVER reshuffled: elimination, leaving or a reconnect keeps a seat
//     in the group it started in. Copies returned by selling / merging / elimination go back to the owner's group only.
//   * A three- or four-player group keeps the complete original pool (scale 1); only a FIVE-player group expands
//     (scale 1.25) — the earlier "scale every group by its size" rule was withdrawn.
//   * The opening group count also sets how many 联防 waves a round may run (1–5), so a big room gets more cooperative
//     waves instead of one wave with a queue of idle helpers.

import { BASE_SEATS, MAX_SEATS, MAX_DRAFT_CARDS } from './constants.js';

export const MIN_COOP_DRAFT_CARDS = MAX_DRAFT_CARDS;
export const GROUPED_POOL_MIN_PLAYERS = 6;
export const MAX_UNITE_ROUNDS = 5;
export const MAX_UNITE_HELPERS = MAX_UNITE_ROUNDS * 2;

/** Each fixed co-op group has its own six-card page, independent of room or living-player count. */
export function coopDraftCardCount() { return MIN_COOP_DRAFT_CARDS; }

// Seat-ordered group layouts, chosen so most groups are four players and no group is smaller than three.
const POOL_GROUP_LAYOUTS = {
  6: [3, 3],
  7: [4, 3],
  8: [4, 4],
  9: [4, 5],
  10: [4, 3, 3],
  11: [4, 4, 3],
  12: [4, 4, 4],
  13: [5, 4, 4],
  14: [4, 4, 3, 3],
  15: [4, 4, 4, 3],
  16: [4, 4, 4, 4],
  17: [5, 4, 4, 4],
  18: [4, 4, 4, 3, 3],
  19: [4, 4, 4, 4, 3],
  20: [4, 4, 4, 4, 4],
};

/**
 * Group sizes for a match, in seat order. One shared pool for up to five; six or more use fixed groups of three,
 * four or five. Returns a copy so callers cannot alter later matches.
 * @param {number} players occupied seats at match start (humans + AI)
 * @returns {number[]}
 */
export function poolGroupSizes(players) {
  if (!Number.isInteger(players) || players < 1 || players > MAX_SEATS) throw new RangeError('invalid player count');
  if (players < GROUPED_POOL_MIN_PLAYERS) return [players];
  return POOL_GROUP_LAYOUTS[players].slice();
}

/** A three- or four-player group keeps the complete original pool; only a five-player group expands. */
export const poolCopyScale = (groupSize) => Math.max(1, groupSize / BASE_SEATS);

/** The opening pool-group count sets the Unite wave limit; later departures never lower it. */
export const uniteRoundLimit = (poolGroupCount) => Number.isInteger(poolGroupCount)
  ? Math.max(1, Math.min(MAX_UNITE_ROUNDS, poolGroupCount)) : 1;

/** Keep the original <=4 player unlock requirement; larger teams need proportionally more covenant layers. */
export const coopHiddenLayerThreshold = (baseline, players) =>
  Math.ceil(baseline * Math.max(1, players / BASE_SEATS));
