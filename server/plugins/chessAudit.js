// server/plugins/chessAudit.js — what a content set's new chess pieces can actually do, in one line for the log.
//
// Forge packs add chess records in three shapes (docs/PLUGINS.md §13):
//   * a 借用 official operator (`kitRef` / `skillSpec` / `dsl`): that kit runs the piece and its numbers come from the
//     record's skill `bb`;
//   * a new body (`char_x_…`) a script plugin kitted (`ContentSet.kitted`): its own kit runs it;
//   * anything else resolves to the generic kit, which can only play what a blackboard says — a piece whose skills carry
//     text but no `bb` is bought and placed, but its skill does nothing (the source server kept that logic in its code).
// The audit is diagnostic only: it never changes the set, its cs or the data, and it is not part of the protocol.

import { genericSkillSpec } from '../sim/content/generic.js';

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Skill objects of a chess record (`skills`, or the single `skill`). */
function skillsOf(c) {
  const list = Array.isArray(c?.skills) ? c.skills.filter(isRecord) : [];
  if (list.length) return list;
  return isRecord(c?.skill) ? [c.skill] : [];
}

/** True when a skill carries blackboard numbers for a kit to read. */
const hasSkillNumbers = (c) => skillsOf(c).some((s) => isRecord(s.bb) && Object.keys(s.bb).length > 0);

/**
 * The blackboard keys a generic kit drops, measured by making it read the blackboard through a recording Proxy instead
 * of duplicating the kit's vocabulary here (`server/sim/content/generic.js` reads its keys by name). A piece run by an
 * official kit is not measured: that kit's own vocabulary applies, and a plugin cannot know it.
 * @param {object} chess a chess record
 * @returns {string[]} sorted keys, [] when nothing is dropped
 */
export function ignoredNumbers(chess) {
  const dropped = new Set();
  for (const sk of skillsOf(chess)) {
    const bb = isRecord(sk.bb) ? sk.bb : {};
    const keys = Object.keys(bb);
    if (!keys.length) continue;
    const read = new Set();
    const seen = new Proxy(bb, {
      get(target, key) { if (typeof key === 'string') read.add(key); return target[key]; },
      has(target, key) { if (typeof key === 'string') read.add(key); return key in target; },
    });
    try {
      genericSkillSpec({ ...sk, bb: seen }, seen, null);
    } catch {
      // a kit that throws reads nothing: report every number as dropped rather than hide the piece's problem
    }
    for (const key of keys) if (!read.has(key)) dropped.add(key);
  }
  return [...dropped].sort();
}

/**
 * The kit ids a room script registers, read from its sources (`sp.kits.register("char_x_…", …)` in kits-<id>). The
 * audit runs no script, so this static scan is its only way to tell a scripted piece from a generic one; a pack that
 * builds its kit table at run time (a loop, a computed id) is audited as generic — say so rather than guess.
 * @param {Array<{script?: {sources?: Record<string, string>}}>} plugins the plugins of the set
 * @returns {string[]} sorted kit ids
 */
export function scriptKitIds(plugins) {
  const ids = new Set();
  for (const p of Array.isArray(plugins) ? plugins : []) {
    for (const text of Object.values(p?.script?.sources ?? {})) {
      for (const m of String(text).matchAll(/sp\.kits\.register\(\s*["'`]([^"'`]+)["'`]/g)) ids.add(m[1]);
    }
  }
  return [...ids].sort();
}

/** Shop eligibility, mirroring server/match/gamedata.js `visibleChess`. */
function shopEligible(c) {
  return !!c && c.visible !== false && !c.isHidden && !c.isGolden && !c.isDiy && Number.isInteger(c.tier);
}

/**
 * @param {Record<string, object>} chess   the set's chess table
 * @param {Record<string, object>} base    the vanilla chess table (the set's base data)
 * @param {{ kitted?: string[] }} [opts]   char ids a script plugin kitted (ContentSet.kitted)
 * @returns {{ added: number, golden: number, shop: number, hidden: number, borrowed: number, shells: number,
 *            generic: number, dropped: number, sample: string[] }} `hidden` counts pieces that can never be bought,
 *            `dropped` how many numbers of the generic-kit pieces no kit reads, `sample` a few of their names
 */
export function chessAudit(chess, base, { kitted = [] } = {}) {
  const kittedSet = new Set(Array.isArray(kitted) ? kitted : []);
  let added = 0, golden = 0, shop = 0, hidden = 0, borrowed = 0, shells = 0, generic = 0, dropped = 0;
  const sample = new Set();
  for (const [id, c] of Object.entries(isRecord(chess) ? chess : {})) {
    if (!isRecord(c) || Object.hasOwn(base ?? {}, id)) continue;
    if (/_b$/.test(id)) { golden++; continue; }
    if (!Number.isInteger(c.tier)) continue;
    added++;
    const buyable = shopEligible(c);
    if (buyable) shop++;
    else hidden++;
    const borrowedKit = c.kitRef != null || c.skillSpec != null || c.dsl != null;
    const ownKit = String(c.charId ?? '').startsWith('char_x_') && kittedSet.has(c.charId);
    if (borrowedKit) { borrowed++; continue; }
    if (ownKit) continue;
    if (!hasSkillNumbers(c)) { shells++; continue; }
    generic++;
    const ignored = ignoredNumbers(c);
    if (ignored.length) {
      dropped++;
      for (const key of ignored) sample.add(key);
    }
  }
  return { added, golden, shop, hidden, borrowed, shells, generic, dropped, sample: [...sample].sort().slice(0, 8) };
}

/** One log line, or null when the set adds no piece. */
export function chessAuditLine(audit) {
  if (!audit || !audit.added) return null;
  const bits = [`${audit.added} new piece(s)`, `${audit.shop} in the shop`];
  if (audit.borrowed) bits.push(`${audit.borrowed} run an official kit`);
  if (audit.generic) bits.push(`${audit.generic} the generic kit`);
  if (audit.shells) bits.push(`${audit.shells} carry no skill numbers (data-only)`);
  if (audit.golden) bits.push(`${audit.golden} 进阶`);
  if (audit.hidden) bits.push(`${audit.hidden} can never be bought`);
  if (audit.dropped) {
    const keys = audit.sample?.length ? `: ${audit.sample.join(', ')}` : '';
    bits.push(`${audit.dropped} drop numbers no kit reads${keys}`);
  }
  return `[plugins] ${bits.join(', ')}`;
}
