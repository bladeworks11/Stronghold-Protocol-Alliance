// server/sim/content/bonds/plugin.js — battle side of *authored* (plugin) bonds.
//
// The 23 official bonds have hand-written battle code (bonds/core.js, bonds/addon.js) that reads their
// `env_gbuff_new` blackboard. An authored bond (`bond_x_<ns>_<local>`, docs/PLUGINS.md §bonds) is **data only**: a
// pack's workshop battle module (`server/battle/*.mjs` + its `@battle` / `@sim` import map) needs the upstream
// workshop API, which this engine does not expose yet — tools/forge-import records that in the import report.
//
// This part gives such a bond a *declarative* reading of the blackboard fields the official bonds share, so enabling
// an alliance-content pack no longer means "盟约效果实际不生效": the bond's stat bonuses apply to its members.
//
//   base_atk / atk_per_stack                    members ATK   +(base + per·L)
//   base_max_hp / max_hp_per_stack              members max HP  +(base + per·L)
//   base_def / def_per_stack                    members DEF   +(base + per·L)
//   base_attack_speed / attack_speed_per_stack  members ASPD  +(base + per·L)
//   base_damage_scale / damage_scale_per_stack  members damage dealt ×(1 + base + per·L)
//   damage_resistance                           members damage taken ×(1 − r)   (phys + arts, like 独行)
//
// Everything else — proc chances (base_prob/prob_per_stack), extra attacks, timers, summons, 棋盘外 token counts — is
// behaviour the pack would implement in code, so those keys are ignored here ([ASSUMED], DESIGN §7). `install` writes
// one log line per authored bond that carries them, so the gap is visible in the server log instead of silent.
//
// Buffs are keyed `bond:x:<bondId>` (persist + allowDead via support `passiveBuff`) and refreshed on battle start,
// (re)deploy and live layer gain, so they follow the current layer count without leaking between 部署.

import {
  num, buffParams, battleRecord, bondLayers, activeBondIds, isMember, itemsOf, playerOps, passiveBuff, directMods,
} from '../support/index.js';

const AUTHORED = /^bond_x_/;
const BB_KEY = 'env_gbuff_new';
const buffKey = (id) => `bond:x:${id}`;

/** Stat fields an authored blackboard may drive, as [base key, per-layer key, directMods field]. */
const STATS = Object.freeze([
  ['base_atk', 'atk_per_stack', 'atk'],
  ['base_max_hp', 'max_hp_per_stack', 'hp'],
  ['base_def', 'def_per_stack', 'def'],
]);

/** Keys this part reads (anything else in the blackboard is ignored, see the header). */
const READ = new Set([
  ...STATS.flatMap(([base, per]) => [base, per]),
  'base_attack_speed', 'attack_speed_per_stack', 'base_damage_scale', 'damage_scale_per_stack', 'damage_resistance',
  // items: granted at activation / at the higher member threshold (prep side), and the carry bonus feeding the ATK term
  'item_id', 'power_bond_char_cnt', 'ex_bond_char_cnt', 'golden_item_max_tier', 'atk_per_item', 'atk_per_item_per',
  'extra_carry', 'extra_carry_per_layer',
]);


/** Blackboard of a bond record (`env_gbuff_new` buff, else the record's own `bb`). */
function blackboard(rec) {
  const bb = buffParams(rec, BB_KEY) ?? (rec && typeof rec.bb === 'object' ? rec.bb : null);
  return bb && typeof bb === 'object' ? bb : null;
}

/**
 * Engine buff mods for one authored bond at `layers` live layers (null when the blackboard drives no stat).
 * Pure: exported for the tests and for the studio preview.
 */
export function bondMods(rec, layers = 0) {
  const bb = blackboard(rec);
  if (!bb) return null;
  const L = Math.max(0, num(layers, 0));
  const pct = {};
  for (const [base, per, field] of STATS) {
    const v = num(bb[base], 0) + num(bb[per], 0) * L;
    if (v) pct[field] = v;
  }
  const extra = {};
  const aspd = num(bb.base_attack_speed, 0) + num(bb.attack_speed_per_stack, 0) * L;
  if (aspd) extra.aspd = aspd;
  const scale = num(bb.base_damage_scale, 0) + num(bb.damage_scale_per_stack, 0) * L;
  if (scale) extra.dmgDealtMul = 1 + scale;
  const resist = num(bb.damage_resistance, 0);
  if (resist) {
    const taken = Math.max(0, 1 - resist);
    extra.physTakenMul = taken;
    extra.artsTakenMul = taken;
  }
  const mods = directMods(pct, extra);
  return mods && Object.keys(mods).length ? mods : null;
}

/**
 * Carried-item terms of an authored blackboard: the ATK share per carried item and the extra carry the bond grants.
 * 「场上的【哥伦比亚】干员视为额外携带了1件装备（…每50层+1）」 and 「获得携带装备数量×20%的攻击力（每层+0.1%）」 are
 * one formula in the official text: carrier = own items + extra_carry(层数), ATK% = carrier × (atk_per_item + per·L).
 * Pure: exported for the tests.
 */
export function carriedTerms(rec, layers = 0) {
  const bb = blackboard(rec);
  if (!bb) return null;
  const L = Math.max(0, num(layers, 0));
  const extra = num(bb.extra_carry, 0) + (num(bb.extra_carry_per_layer, 0) > 0 ? Math.floor(L / num(bb.extra_carry_per_layer, 1)) : 0);
  const perItem = num(bb.atk_per_item, 0) + num(bb.atk_per_item_per, 0) * L;
  if (!extra && !perItem) return null;
  return { extra, perItem };
}

/** Blackboard keys of `rec` this part cannot act on (the behavioural half the pack's code would implement). */
export function unreadKeys(rec) {
  const bb = blackboard(rec);
  if (!bb) return [];
  return Object.keys(bb).filter((k) => !READ.has(k));
}

function playersOf(battle) {
  const out = [];
  for (const p of Array.isArray(battle.players) ? battle.players : []) if (p && p.id != null) out.push(p.id);
  return out;
}

function applyPlayer(battle, pid) {
  const ops = playerOps(battle, pid);
  if (!ops.length) return;
  for (const id of activeBondIds(battle, pid)) {
    if (!AUTHORED.test(id)) continue;
    const rec = battleRecord(battle, 'bonds', id);
    if (!rec) continue;
    const layers = bondLayers(battle, pid, id);
    const mods = bondMods(rec, layers);
    const carried = carriedTerms(rec, layers);
    if (!mods && !carried) continue;
    for (const u of ops) {
      if (!isMember(battle, u, id)) continue;
      const own = mods ? { ...mods } : {};
      if (carried) {
        const atk = (itemsOf(u).length + carried.extra) * carried.perItem;
        if (atk) own.atkPct = (num(own.atkPct, 0) || 0) + atk;
      }
      if (Object.keys(own).length) passiveBuff(battle, u, buffKey(id), own);
    }
  }
}

/** One line per authored bond whose blackboard asks for behaviour this engine cannot run. */
function report(battle, log) {
  const seen = new Set();
  for (const pid of playersOf(battle)) {
    for (const id of activeBondIds(battle, pid)) {
      if (!AUTHORED.test(id) || seen.has(id)) continue;
      seen.add(id);
      const keys = unreadKeys(battleRecord(battle, 'bonds', id));
      if (keys.length) log(`[sim] bond ${id} uses ${keys.slice(0, 6).join(', ')} — only stat fields apply (plugin bond)`);
    }
  }
}

export function install(battle) {
  const log = typeof battle.log === 'function' ? (m) => battle.log(m) : () => {};
  const refreshAll = () => { for (const pid of playersOf(battle)) applyPlayer(battle, pid); };
  battle.on('battleStart', refreshAll);
  battle.on('deploy', ({ unit }) => { if (unit && unit.kind === 'op' && unit.ownerId != null) applyPlayer(battle, unit.ownerId); });
  battle.on('layerGain', () => refreshAll());
  report(battle, log);
}

/**
 * Item plan of an authored bond: the item its 「获得1件…」 pays, the member counts that pay it once, and the tier cap of
 * the per-休整期 gift (「进入休整期时获得1件随机阶级的进阶装备」). `golden_item_max_tier: 'shop'` means "up to the highest
 * shop tier" — this engine's shop tops out at tier 6 ([ASSUMED], the official 进阶装备 ladder runs 1..6).
 * Pure: exported for the tests.
 */
export function itemPlan(rec) {
  const bb = blackboard(rec);
  if (!bb) return null;
  const itemId = typeof bb.item_id === 'string' && bb.item_id ? bb.item_id : null;
  if (!itemId) return null;
  const tierRaw = num(bb.golden_item_max_tier, 0);
  const maxTier = bb.golden_item_max_tier === 'shop' || !(tierRaw > 0) ? 6 : Math.min(6, Math.floor(tierRaw));
  return {
    itemId,
    firstAt: Math.max(0, Math.floor(num(bb.power_bond_char_cnt, 0))),
    highAt: Math.max(0, Math.floor(num(bb.ex_bond_char_cnt, 0))),
    maxTier,
  };
}

const metaKey = (id, k) => `pluginbond:${id}:${k}`;

/**
 * Prep-side handler of one authored bond (registered by registerAuthoredMeta): the items its text pays, and nothing
 * else. Counters make each milestone once-per-match, so the handler may run from every relevant hook; it only acts
 * while the bond is active (`bondActive`) and reads the bond's own member count (`bondCount`, countMode BOARD).
 */
function metaHandler(id, plan, resolveItem) {
  const source = `bond:${id}`;
  // 里程碑：只在真的发出去之后才记账，免得 id 在本版本不存在时把名额永久用掉
  const payOnce = (ctx, key, itemId) => {
    if (ctx.counter(key) >= 1) return 0;
    const granted = ctx.grantItem(itemId, { source }) ? 1 : 0;
    if (granted) ctx.setCounter(key, 1);
    return granted;
  };
  /** 本次里程碑该发的东西：包里的具体装备；本版本没有这件装备时按同阶随机（进阶装备池）发一件。 */
  const payMilestone = (ctx, key) => {
    if (resolveItem(plan.itemId)) return payOnce(ctx, key, plan.itemId);
    if (ctx.counter(metaKey(id, 'fallback')) < 1) {
      ctx.setCounter(metaKey(id, 'fallback'), 1);
      ctx.log?.(`[sim] bond ${id} pays ${plan.itemId}, which this build does not have — falling back to a random tier ${plan.maxTier} item`);
    }
    if (ctx.counter(key) >= 1) return 0;
    const itemId = ctx.rollItem({ maxTier: plan.maxTier });
    const granted = itemId && ctx.grantItem(itemId, { source }) ? 1 : 0;
    if (granted) ctx.setCounter(key, 1);
    return granted;
  };
  const milestones = (ctx) => {
    if (!ctx.bondActive(id)) return 0;
    const n = ctx.bondCount(id);
    let paid = 0;
    if (plan.firstAt > 0 && n >= plan.firstAt) paid += payMilestone(ctx, metaKey(id, 'first'));
    if (plan.highAt > 0 && n >= plan.highAt) {
      paid += payMilestone(ctx, metaKey(id, 'high'));
      ctx.setCounter(metaKey(id, 'ready'), 1);
    }
    return paid;
  };
  const perPrep = (ctx) => {
    if (!ctx.bondActive(id) || ctx.counter(metaKey(id, 'ready')) < 1) return 0;
    const itemId = ctx.rollItem({ maxTier: plan.maxTier });
    return itemId && ctx.grantItem(itemId, { source }) ? 1 : 0;
  };
  return {
    onActiveBonds: (ctx) => { milestones(ctx); },
    onLayers: (ctx) => { milestones(ctx); },
    onRoundStart: (ctx) => { milestones(ctx); },
    onPrepStart: (ctx) => { milestones(ctx); perPrep(ctx); },
    onPrepEnd: (ctx) => { milestones(ctx); },
  };
}

/**
 * Register the prep-side handler of every authored bond of this match's data. The registry is process-wide but keyed
 * by bond id, so re-registering the same id for every match that carries the pack is idempotent; a match without the
 * pack simply never dispatches those keys (effectsMeta walks this.gd.bondIds).
 */
export function registerAuthoredMeta(registry, gd) {
  if (!registry || typeof registry.bond !== 'function' || !gd) return 0;
  const ids = Array.isArray(gd.bondIds) ? gd.bondIds : null;
  const list = ids || Object.keys(gd.bonds && typeof gd.bonds === 'object' ? gd.bonds : {});
  const resolveItem = (itemId) => (typeof gd.item === 'function' ? gd.item(itemId) : gd.items?.[itemId] ?? null);
  let n = 0;
  for (const id of list) {
    if (typeof id !== 'string' || !AUTHORED.test(id)) continue;
    const rec = typeof gd.bond === 'function' ? gd.bond(id) : gd.bonds?.[id] ?? null;
    const plan = itemPlan(rec);
    if (!plan) continue;
    registry.bond(id, metaHandler(id, plan, (itemId) => Boolean(resolveItem(itemId))));
    n++;
  }
  return n;
}
