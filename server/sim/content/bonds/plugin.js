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
  num, buffParams, battleRecord, bondLayers, activeBondIds, isMember, playerOps, passiveBuff, directMods,
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
    const mods = bondMods(rec, bondLayers(battle, pid, id));
    if (!mods) continue;
    for (const u of ops) if (isMember(battle, u, id)) passiveBuff(battle, u, buffKey(id), mods);
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
