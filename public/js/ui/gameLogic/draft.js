// ui/gameLogic/draft.js — 机变 and band-draft normalisation. Re-exported from ../gameLogic.js.

import { isObj } from './shared.js';
import { PHASE } from '../../../../shared/constants.js';
import { t } from '../../../../shared/i18n.js';


// ---- 机变 / band draft normalisation ----------------------------------------------------------------------

/**
 * Normalise m.public.draft ({order, turn, picks, skips?}) — tolerant of index/playerId turns and
 * object/array picks.
 * @param {any} draft
 * @param {any[]} [players]
 * @returns {{ order: string[], turnPid: string|null, picks: Map<string,string>, skipsLeft: Map<string, number>, done: boolean }}
 */
export function normalizeDraft(draft, players = []) {
  const ids = (Array.isArray(players) ? players : []).filter(isObj).map((p) => p.playerId);
  const order = Array.isArray(draft?.order) && draft.order.length ? draft.order.filter((x) => typeof x === 'string') : ids;
  let turnPid = null;
  if (typeof draft?.turn === 'string') turnPid = draft.turn;
  else if (Number.isInteger(draft?.turn) && draft.turn >= 0 && draft.turn < order.length) turnPid = order[draft.turn];
  const picks = new Map();
  const src = draft?.picks;
  if (Array.isArray(src)) {
    src.forEach((v, i) => {
      if (typeof v === 'string' && order[i]) picks.set(order[i], v);
      else if (isObj(v) && typeof v.playerId === 'string' && typeof v.bandId === 'string') picks.set(v.playerId, v.bandId);
    });
  } else if (isObj(src)) {
    for (const [k, v] of Object.entries(src)) if (typeof v === 'string' && v) picks.set(k, v);
  }
  const skipsLeft = new Map();
  const sk = draft?.skipsLeft ?? draft?.skips;
  if (isObj(sk)) for (const [k, v] of Object.entries(sk)) if (Number.isFinite(v)) skipsLeft.set(k, v);
  const done = order.length > 0 && order.every((pid) => picks.has(pid));
  return { order, turnPid, picks, skipsLeft, done };
}

/**
 * Normalise m.public.sp ({family, cards, turn, picks, order?}).
 * Cards: string ids or objects; picks: {playerId: cardIdx} | [{playerId, idx}] | card.takenBy.
 *
 * A room of six or more runs one 机变 page per fixed card-pool group (server/match/match/spDraft.js _initSpGroups):
 * m.public.sp then carries `groups`, each with its own six cards, its own `taken` and its OWN `turn` (the groups pick
 * in parallel — server spTurnOf), and the flat `cards` / `taken` / `turn` are the first group's. `opts.group` (the
 * viewer's own `m.private.spGroup`, i.e. { id, members, taken }) selects the page the viewer actually chooses from, so
 * the cards shown, the indices sent back and the turn the overlay names all belong to the viewer's own group.
 * @param {any} sp
 * @param {any[]} [players]
 * @param {{ group?: { id?: number, members?: string[], taken?: Record<string, string> } | null }} [opts]
 */
export function normalizeSp(sp, players = [], opts = {}) {
  if (!isObj(sp)) return null;
  const ids = (Array.isArray(players) ? players : []).filter(isObj).map((p) => p.playerId);
  const order = Array.isArray(sp.order) && sp.order.length ? sp.order.filter((x) => typeof x === 'string') : ids;
  // the viewer's own group page, when the room has any (fall back to the flat, first-group fields)
  const gid = opts.group && Number.isInteger(opts.group.id) ? opts.group.id : null;
  const page = gid != null && Array.isArray(sp.groups) ? (sp.groups.find((g) => g && g.id === gid) || null) : null;
  const srcCards = Array.isArray(page?.cards) ? page.cards : sp.cards;
  const srcTaken = page ? page.taken : sp.taken;
  const cards = (Array.isArray(srcCards) ? srcCards : []).slice(0, 6).map((c, idx) => {
    const card = typeof c === 'string' ? { id: c } : isObj(c) ? { ...c } : {};
    return { ...card, idx, takenBy: typeof card.takenBy === 'string' ? card.takenBy : null };
  });
  const takenBy = new Map(); // idx → playerId
  const pickOf = new Map(); // playerId → idx
  const add = (pid, idx) => {
    if (typeof pid !== 'string' || !Number.isInteger(idx) || idx < 0 || idx >= cards.length) return;
    takenBy.set(idx, pid);
    pickOf.set(pid, idx);
  };
  const src = sp.picks;
  // m.public.sp.picks is the ROOM-WIDE map (playerId → position on that seat's OWN page). On a grouped room a
  // position of another group says nothing about this page — index 2 is taken on the other page, free here — so
  // only the page's own members are read from it; the page's own `taken` map (below) is the truth about positions.
  // Without a page (a single-page room, an older server) every seat of the room picks on the same six cards.
  const picksWholeRoom = !page || !Array.isArray(page.members);
  if (Array.isArray(src)) src.forEach((v, i) => { if (isObj(v)) add(v.playerId, v.idx); else if (Number.isInteger(v) && order[i]) add(order[i], v); });
  else if (isObj(src)) for (const [k, v] of Object.entries(src)) { if (picksWholeRoom || page.members.includes(k)) add(k, v); }
  // the taken positions of the SELECTED page; without a group page the flat (first-group) map applies
  if (isObj(srcTaken)) for (const [k, v] of Object.entries(srcTaken)) add(v, Number(k));
  for (const c of cards) if (c.takenBy) add(c.takenBy, c.idx);
  for (const c of cards) c.takenBy = takenBy.get(c.idx) ?? null;
  // whose turn it is ON THE SELECTED PAGE: a grouped room names it per page (`groups[].turn` — the server's spTurnOf;
  // its `ahead` list, the seats the page still waits for, is the same answer), the pageless room through the flat turn.
  // A page that names neither (an older server) falls back to the page's own members in the room order.
  const pageTurn = page
    ? (turnOf(page, order) ?? (Array.isArray(page.members)
      ? order.find((pid) => page.members.includes(pid) && !pickOf.has(pid)) ?? null
      : null))
    : null;
  const turnPid = page ? pageTurn : turnOf(sp, order);
  return {
    family: typeof sp.family === 'string' ? sp.family : null,
    name: typeof sp.name === 'string' && sp.name ? sp.name : null,
    desc: typeof sp.desc === 'string' && sp.desc ? sp.desc : null,
    untimed: !!sp.untimed,
    cards, order, turnPid, pickOf, takenBy, pickedCount: pickOf.size,
    /** the id of the group page these cards belong to (null when the room runs one page for everybody) */
    groupId: page ? page.id : null,
  };
}

/**
 * A turn record as a playerId: `turn` (a playerId or an index into the room order), else `ahead[0]` (the seats the
 * page still waits for — the picker first). Null when the record names nobody.
 * @param {any} rec m.public.sp, one of its `groups`, or a bare { turn } object
 * @param {string[]} order the room order an index turn counts in
 */
function turnOf(rec, order = []) {
  if (!isObj(rec)) return null;
  if (typeof rec.turn === 'string' && rec.turn) return rec.turn;
  if (Number.isInteger(rec.turn) && rec.turn >= 0 && rec.turn < order.length) return order[rec.turn];
  if (Array.isArray(rec.ahead) && typeof rec.ahead[0] === 'string') return rec.ahead[0];
  return null;
}

/** Adapt only the recipient's current PREP choice; never write it into the public draft. */
export function normalizePersonalChoice(pub, priv, myId) {
  const choice = priv?.personalChoice;
  if (pub?.phase !== PHASE.PREP || !priv || priv.playerId !== myId || priv.alive === false
    || !choice || choice.round !== pub.round) return null;
  return {
    ...normalizeSp({ family: 'bounty', name: t('教鞭 · 战术特训'), desc: t('请选择一项战术特训'),
      cards: choice.cards, turn: myId, order: [myId], picks: {} }),
    id: choice.id,
  };
}
