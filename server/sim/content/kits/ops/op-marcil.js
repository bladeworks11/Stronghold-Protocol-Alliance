// server/sim/content/kits/ops/op-marcil.js — 玛露西尔 (char_4141_marcil) 自选 operator kit: 5★ 扩散术师 (术师), a 联动
// operator of the tier-5 and tier-6 自选 slots; all three skills, both talents and the module at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// 本机自用：玛露西尔是上游因版权排除的 7 名联动干员之一（tools/build-data.mjs DIY_INCLUDED_COLLABS、NOTICE.md §2）。
// 仅供本机个人非商业使用；不要公开分发，也不要向上游提 PR。
//
// Sources: the official skill / talent texts and blackboards as built into backups.json, plus PRTS 玛露西尔 (raw), which
// carries what the data does not — above all the 魔力 rule, which is the whole character:
//   「玛露西尔的技能技力自然回复速度为0，但不需要满技力即可开启技能（仍具有最低技力需求）；技能中的初始技力为对应的初始
//     魔力，技力需求为携带技能时对应的魔力上限，其不受技力需求变化的影响」
// i.e. MANA IS THE SKILL'S SP POOL: `initSp` is the starting 魔力, `spCost` the 魔力 cap, and `skill_cost_min_sp` the
// floor a cast needs. The kit therefore spends 魔力 by writing `skill.sp` directly and lets the engine's own
// "a running skill with SP below its cost ends" rule close a skill whose 魔力 ran out.
//
// Forms: normal = E2 Lv1 rank 4 no module; elite = E2 Lv60 rank 7, SPC-Y at stage 1 (tier 5) / 3 (tier 6).
// 攻击间隔 2.9 s; 攻击范围 3-6.
// - Trait (扩散术师) "攻击造成群体法术伤害": the profession's splash; T1 widens it to 1.5 while she holds 魔力.
// - T1 建校以来第一才女: 技能消耗魔力且可随时开启 / 魔力不自然回复 / 不在场时每秒回复1点; 有魔力时攻击力 +atk and the
//   splash widens to 1.5 (PRTS 备注 "技力不小于1时第一天赋生效，此时溅射半径扩大至1.5"). At full potential `atk` is 0.25
//   (精英1; the 潜能3 「天赋效果增强」 step is already in the data).
// - T2 可靠的同伴: 初始魔力 +`mana_init` (25; SPC-Y stage 2+ 35 / stage 3 40, read from the module's talent change). The
//   「编队中有4名【莱欧斯小队】干员时」 aura needs the squad count, which a 自选 piece's roster does not carry here
//   [ASSUMED: not implemented — it is a team-composition effect outside the battle's own data].
// - SPC-Y “才女的藏书”: 部署费用减少 (a cost effect the mode's free deployment makes moot) + ATK / ASPD in the stats.
// - S1 才女的实力 (MANUAL → played as a toggle): a `chant_duration` chant, then +atk and every attack costs `sp_cost` 魔力;
//   with no target in range she heals an ally instead (also for `sp_cost` 魔力). 可随时主动关闭; PRTS 备注 "最低技力需求：
//   2；吟唱时间：1.5s；不能在部署动画期间开启，技力不足最低需求时自动关闭技能".
// - S2 召唤使魔 (AUTO → played as a toggle): an `chant_duration` chant (11 s), then −`sp_cost` 魔力 and +atk; every attack
//   停顿 `attack@sluggish` s. The SECOND use upgrades the familiar: range +1, ASPD +`attack_speed`, and 晕眩 `attack@stun`
//   s on the main target [ASSUMED: the range +1 is not modelled — the sim has no per-summon range growth here].
// - S3 爆破魔法 (MANUAL): a `chant_duration` chant (5 s) then −`sp_cost` 魔力 and one explosion centred 2 tiles ahead
//   (PRTS 备注 "以自身正前方2格（因靠近地图边界而距离不足时相应缩进）为中心"), `atk_scale` × ATK arts around it and a
//   `stun` s 晕眩 of the 高台 it hit — the sim has no destructible 高台, so the stun lands on the enemies around the point
//   [ASSUMED]. The extra chant (每额外消耗8点魔力追加1次爆炸, every `interval` s) is implemented as repeated explosions
//   for as long as the 魔力 lasts.

import { num, talentBb, moduleBb, skillRec, up } from '../shared/tier1.js';
import { hasHp } from '../../../attack.js';

const S1 = 'skchr_marcil_1';
const S2 = 'skchr_marcil_2';
const S3 = 'skchr_marcil_3';
/** T1: the splash radius while she holds 魔力 [PRTS 备注 "溅射半径扩大至1.5"]. */
const MANA_SPLASH = 1.5;
/** S3: the explosion is centred this many tiles ahead [PRTS 备注 "自身正前方2格"]. */
const S3_AHEAD = 2;
/** S3's extra-chant explosions around the point. */
const S3_RADIUS = 1.5;
const MANA_REGEN_IV = 1;

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};

export default {
  char_4141_marcil: (bb, chess, def) => {
    const t0 = talentBb(chess, 0);            // 建校以来第一才女: atk / mana_init / mana_max / interval
    const t1 = talentBb(chess, 1);            // 可靠的同伴: mana_init (SPC-Y raises it)
    const mod = chess?.module?.id ? (chess.modules ?? []).find((m) => m.uniEquipId === chess.module.id) : null;
    const t1mod = (mod?.talentChanges ?? []).find((t) => t && t.talentIndex === 1)?.bb ?? {};
    const manaInit = num(t1mod.mana_init, num(t1.mana_init, num(t0.mana_init, 0)));
    const manaAtk = num(t0.atk);
    const manaMax = num(t0.mana_max, 80);
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    /**
     * The skill the pick selected. `def.skill` is the resolved record of THAT skill (`id`, `bb`, `spCost`, `initSp`), and
     * the `bb` this builder receives is its blackboard — so `def.skill.id` names it and `bb` already carries the numbers.
     */
    const selected = def?.skill?.id ?? null;
    const bbSel = selected === S2 ? b2 : selected === S3 ? b3 : b1;
    const chantOf = num(bb.chant_duration, num(bbSel.chant_duration));
    const minSp = num(bb.skill_cost_min_sp, num(bbSel.skill_cost_min_sp, 1));
    /** The skill's own 魔力 cost (S1 / S2 pay it per attack; S3 pays it for its first blast). */
    const costOf = num(bb.sp_cost, num(bbSel.sp_cost, 2));
    /**
     * What OPENING the skill needs. S3 pays `sp_cost` for its first blast, so opening it below that would end in an
     * instant cast with nothing to show — and an instant skill re-arms every tick, so the gate has to cover the cost.
     */
    const openAt = selected === S3 ? Math.max(minSp, costOf) : Math.max(minSp, 1);

    /**
     * 魔力 lives in the skill's SP pool, so it must survive a cast: the engine empties the pool when a skill ends, so
     * the value is parked in `unit.mem` for the next cast. `mana()` reads it back.
     */
    const mana = (unit) => Math.max(0, Math.round(unit.skill?.sp ?? 0));
    const spend = (unit, n) => {
      const s = unit.skill;
      if (!s || !(n > 0)) return;
      s.sp = Math.max(0, s.sp - n);
    };

    return {
      skills: {
        // S1 才女的实力: a chant, then ATK +atk and `sp_cost` 魔力 per attack (a heal when there is no target).
        [S1]: {
          kind: 'toggle',
          mods: { atkPct: num(b1.atk) },
          attack: { afterHit: (battle, unit) => spend(unit, num(b1.sp_cost, 2)) },
          onStart({ battle, unit }) { chant(battle, unit, chantOf); },
        },
        // S2 召唤使魔: a longer chant, then ATK +atk and 停顿 on every hit; the second use upgrades the familiar.
        [S2]: {
          kind: 'toggle',
          mods: { atkPct: num(b2.atk) },
          attack: {
            afterHit: (battle, unit) => spend(unit, num(b2.sp_cost, 35)),
            // `attack.onHit` fires once per attack with the MAIN target (ai.js), so no extra main-target test is needed.
            onHit({ battle, unit, target }) {
              const slug = num(b2['attack@sluggish']);
              if (slug > 0 && target && hasHp(target)) battle.applyStatus(target, 'sluggish', { duration: slug, source: unit });
              const stun = num(b2['attack@stun']);   // the upgraded familiar's 主目标 stun
              if (familiarUpgraded(unit) && stun > 0 && target && hasHp(target)) {
                battle.applyStatus(target, 'stun', { duration: stun, source: unit });
              }
            },
          },
          onStart({ battle, unit }) {
            chant(battle, unit, chantOf);
            unit.mem.marcilUses = (unit.mem.marcilUses ?? 0) + 1;   // the 2nd use upgrades the familiar
            if (familiarUpgraded(unit)) {
              unit.mem.marcilFamiliar = { aspd: num(b2.attack_speed), stun: num(b2['attack@stun']) };
            }
          },
        },
        // S3 爆破魔法: a chant, then explosions 2 tiles ahead for as long as the 魔力 lasts. A toggle like S1 / S2 —
        // an `instant` spec ends the moment it opens and re-arms every tick, which looped the cast.
        [S3]: {
          kind: 'toggle',
          onStart({ battle, unit }) {
            chant(battle, unit, chantOf);
            unit.mem.marcilBlasts = 0;
            unit.mem.marcilNext = battle.time + Math.max(0, chantOf);
          },
          onTick({ battle, unit }) {
            if (battle.time + 1e-9 < (unit.mem.marcilNext ?? 0)) return;   // still chanting
            if (blast(battle, unit)) unit.mem.marcilNext = battle.time + Math.max(0.05, num(b3.interval, 0.45));
          },
        },
      },
      talents: [
        { install(battle, unit) { // 建校以来第一才女: +atk and a wider splash while she holds 魔力
          if (manaAtk > 0) {
            battle.on('tick', () => {
              if (!up(unit)) return;
              const on = mana(unit) >= 1;
              const has = unit.findBuff('marcil:mana');
              if (on && !has) {
                battle.addBuff(unit, { key: 'marcil:mana', mods: { atkPct: manaAtk }, refresh: 'keep', tags: ['talent'], data: { splash: MANA_SPLASH } });
              } else if (!on && has) battle.removeBuff(unit, 'marcil:mana');
            }, { owner: unit });
          }
        } },
        { install(battle, unit) { // 可靠的同伴: 初始魔力 +mana_init; 不在场时每秒回复1点
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move) return;
            // a fresh deployment starts from the initial 魔力 (the pool is filled on activation, below)
            unit.mem.marcilMana = manaInit;
            unit.mem.marcilInit = true;
          }, { owner: unit });
          battle.every(MANA_REGEN_IV, () => {
            if (!unit.alive || unit.deployed || battle.finished) return;
            unit.mem.marcilMana = Math.min(manaMax, (unit.mem.marcilMana ?? manaInit) + 1);
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        // 魔力 is the skill's SP pool: fill it from the parked value when a cast begins, and park it back when one ends.
        battle.on('skillStart', (c) => {
          if (c.unit !== unit || !unit.skill) return;
          const m = unit.mem.marcilMana;
          if (m != null && Number.isFinite(m)) unit.skill.sp = Math.max(0, Math.min(manaMax, m));
        }, { owner: unit, priority: -20 });
        battle.on('skillEnd', (c) => {
          if (c.unit !== unit || !unit.skill) return;
          unit.mem.marcilMana = Math.round(unit.skill.sp);
        }, { owner: unit, priority: -20 });
        // The skill closes itself once the 魔力 falls under the cast's floor (the engine's own SP rule does this).
        battle.on('tick', () => {
          if (!up(unit) || !unit.skill?.active) return;
          if (mana(unit) < minSp && unit.skill.activations > 0) unit.skill.end('noMana');
        }, { owner: unit });
        // "玛露西尔的技能技力自然回复速度为0" — the pool IS her 魔力, so nothing may refill it on a timer. `spGain`
        // fires before the engine writes, and zeroing the amount cancels the gain (skills.js `gainSp` reads it back).
        battle.on('spGain', (c) => {
          if (c.unit !== unit) return;
          if (c.reason === 'time' || c.reason === 'attack' || c.reason === 'hurt') c.amount = 0;
        }, { owner: unit, priority: -100 });
        // MANUAL skills are never auto-cast, and this mode has no manual control: the kit opens the skill itself once
        // the 魔力 covers the cast's floor and there is something to do (PRTS: 「不需要满技力即可开启技能」).
        battle.on('tick', () => {
          const s = unit.skill;
          if (!s || s.active || !up(unit) || !unit.canAct) return;
          if (mana(unit) + 1e-9 < openAt) return;
          if (battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true }).length === 0) return;
          // `free` because she does not need a full pool — the engine's own readiness gate wants `charges >= 1`,
          // which a 魔力 pool that is spent by the cast itself never satisfies (PRTS 「不需要满技力即可开启技能」).
          s.activate('kit', { free: true });
        }, { owner: unit, priority: 10 });
      },
    };

    /** The chant: a disarm + invulnerable window before the skill does anything (PRTS "吟唱期间…"). */
    function chant(battle, unit, seconds) {
      if (!(seconds > 0)) return;
      battle.addBuff(unit, { key: 'marcil:chant', duration: seconds, flags: { disarm: true, invulnerable: true }, tags: ['skill'] });
      battle.fx('charge', { x: unit.x, y: unit.y, id: unit.id, skill: 'marcil:chant' });
    }

    /** S2's familiar upgrade per deployment (PRTS "每次部署时，重新计算该技能的使用次数"). */
    function familiarUpgraded(unit) { return (unit?.mem?.marcilUses ?? 0) >= 2; }

    /** One 爆破魔法 explosion: `atk_scale` × ATK arts around a point 2 tiles ahead, plus its `stun`. */
    function blast(battle, unit) {
      const first = (unit.mem.marcilBlasts ?? 0) === 0;
      const cost = first ? num(b3.sp_cost, 8) : num(b3.sp_cost_extra, 8);
      if (!unit.skill || unit.skill.sp + 1e-9 < cost) return false;
      unit.skill.sp = Math.max(0, unit.skill.sp - cost);
      unit.mem.marcilBlasts = (unit.mem.marcilBlasts ?? 0) + 1;
      const [fr, fc] = unit.fwd;
      const r = unit.tileR + fr * S3_AHEAD, c = unit.tileC + fc * S3_AHEAD;
      const stun = num(b3.stun);
      battle.fx('aoe', { x: c, y: r, radius: S3_RADIUS, id: unit.id, skill: 'marcil:blast' });
      for (const e of battle.foesInRadius(c, r, S3_RADIUS, true)) {
        if (!hasHp(e)) continue;
        battle.dealDamage(unit, e, { amount: unit.s.atk * num(b3.atk_scale, 1), type: 'arts', isSkill: true, tags: ['skill', 'marcil:blast'] });
        if (stun > 0 && e.alive) battle.applyStatus(e, 'stun', { duration: stun, source: unit });
      }
      return true;
    }
  },
};
