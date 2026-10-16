// server/sim/content/kits/ops/op-orchd2.js — 焰狐龙梓兰 (char_1048_orchd2) 自选 operator kit: 5★ 重射手 (狙击), a 联动
// operator of the tier-5 and tier-6 自选 slots; all three skills, both talents and the module at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// 本机自用：焰狐龙梓兰是上游因版权排除的 7 名联动干员之一（tools/build-data.mjs DIY_INCLUDED_COLLABS、NOTICE.md §2）。
// 仅供本机个人非商业使用；不要公开分发，也不要向上游提 PR。
//
// Sources: the official skill / talent texts and blackboards as built into backups.json, plus PRTS 焰狐龙梓兰 (raw).
// The trait 高精度的近距离射击 reads as six words in `trait.desc`, but the mechanic itself IS in the data: the hidden
// talent (index 2) carries `attack@atk_scale` 1 / `attack@damage_scale` 0.333 — PRTS 特性备注 spells it out:
//   「普通攻击为三连击，每击造成攻击力100%的物理伤害。在每次输出伤害时会对其进行检测，若为普通攻击的伤害，
//     则使该伤害降低至33.3%（也即计算防御/法抗后，伤害×33.3%）」
// so a normal attack is THREE hits of `attack@atk_scale` × ATK physical, each scaled by `attack@damage_scale` [ASSUMED:
// the data's own multiplier is used as-is, applied to the normal attack's damage instances].
//
// 再部署 66 s (70 − 15 翔虫机动 + 72→66 with the module's respawn attr) — the respawn rules are the match's.
// - T1 强击瓶专家 "部署后首次开启技能时，接下来50次攻击的攻击力提升至120%" (`power_attack_count` / `power_attack_scale`;
//   PRTS 备注: EVERY round of normal attacks, every round of a skill's 三/四/五连击, each 降落攻击 of S2 and each 龙之箭 of S3
//   burns ONE stack; the boost is an attack multiplier applied to all the volleys of that round): a stack counter armed by
//   the first cast of each deployment, consumed by one attack round / volley.
// - T2 翔虫机动 "再部署时间-15秒且不提高部署费用；部署至上次部署位置周围时，30秒内攻击力+15%" (`atk` / `atk_duration`;
//   ARC-X stage 2+ raises `atk` to 0.2 and widens the area to x-2): the respawn part is the match's; the ATK bonus is granted
//   when she deploys on or beside her previous tile, for `atk_duration` s [the "last tile" is tracked by this kit].
// - Module ARC-X 「梓兰特制箭靶」 "再部署时间减少": a respawn effect (match side); its ATK / DEF are in the stats, and its
//   talent change is read above.
// - S1 刚射 (MANUAL, 可充能 3 次): 4 arrows of `atk_scale_1` × ATK; with a charge left, `atk_scale_2` × ATK arrows whose
//   every arrow has `stun_prob` to 晕眩 `stun` s (PRTS "发射4支…发射5支…每支箭矢有20%概率使目标晕眩2秒").
// - S2 飞翔瞪射 (MANUAL, 4.2 s, 可充能 3 次, range 4-4): takes off (PRTS 「立刻起飞」 — 丢失全部视野 while it runs) and fires
//   three volleys of 3 / 4 / 5 arrows at `attack@atk_scale_loop`, then lands with `attack@atk_scale_end` × ATK physical
//   around her (PRTS 备注 "降落时伤害范围为 1-3").
// - S3 龙之箭 (MANUAL, 可充能 2 次): after a chant (PRTS 备注 "从技能开启动画播放完毕后开始1.5秒蓄力计时" — the data's
//   `wait_duration` 1.5) a piercing arrow flies along her facing without a range limit, pushing every enemy it passes with
//   `force` and dealing `atk_scale` × ATK physical then `atk_scale_magic` × ATK arts every `dist_interval` tiles
//   (PRTS 备注 "先造成物理伤害，后造成法术伤害").

import { num, talentBb, moduleBb, traitBb, skillRec, up, enemiesInGrid } from '../shared/tier1.js';
import { hasHp } from '../../../damage.js';

const S1 = 'skchr_orchd2_1';
const S2 = 'skchr_orchd2_2';
const S3 = 'skchr_orchd2_3';
/** The hidden talent's index that carries the trait's triple-strike (「普通攻击为三连击」). */
const TRIPLE_INDEX = 2;
/**
 * The trait's hit count per attack round — 「普通攻击为三连击」, i.e. THREE. The hidden talent carries only the SCALES
 * (`attack@atk_scale` 1 = each hit deals 100 % ATK, `attack@damage_scale` 0.333 = the round is then × 33.3 %); the count
 * itself is in the text and in no blackboard [the same shape as 灰烬's 31-bullet magazine].
 */
const ORCHD2_TRIPLE = 3;
/** T2's "上次部署位置周围" radius in tiles. */
const RETURN_RADIUS = 1;
/**
 * S1 刚射's arrow counts — 4 in its own volley and 5 in the 刚连射 follow-up (PRTS 「发射4支…发射5支…」). No blackboard key
 * carries either: every level's `bb` is `atk_scale_1` / `atk_scale_2` / `stun_prob` / `stun` and nothing else.
 */
const S1_ARROWS = 4;
const S1_ARROWS_2 = 5;
/** S2's landing blast radius [PRTS 备注 "降落时伤害范围为 1-3"]. */
const S2_LAND_RADIUS = 1.5;
/** S2's three volleys: 3, 4, 5 arrows [PRTS 「分别射出3、4、5支」]. */
const S2_VOLLEYS = [3, 4, 5];
/** S3's arrow speed in tiles/s [ASSUMED: the engine's arrow speed — PRTS gives none]. */
const S3_SPEED = 12;
/** S3's arrow reach before it is dropped [ASSUMED: "射程无限" is unbounded, bounded here by the field]. */
const S3_MAX_TILES = 21;
const ORCHD2_KEY = 'orchd2';

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};

export default {
  char_1048_orchd2: (bb, chess) => {
    const t0 = talentBb(chess, 0);            // 强击瓶专家: power_attack_count / power_attack_scale
    const t1 = talentBb(chess, 1);            // 翔虫机动: atk / atk_duration
    // The trait's triple strike lives on a HIDDEN talent (index 2). It is on the composed RECORD's `talentsBase`, and
    // the loader passes the normalised DEF to a kit (its `raw` keeps the record) — so both shapes are accepted.
    const rec = chess?.raw ?? chess;
    const hidden = (rec?.talentsBase ?? []).find((t) => t && t.index === TRIPLE_INDEX)?.bb
      ?? (rec?.talents ?? []).find((t) => t && t.index === TRIPLE_INDEX)?.bb ?? {};
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const tripleHits = ORCHD2_TRIPLE;                       // 「普通攻击为三连击」 — the count is in the text, not the bb
    const perHitScale = num(hidden['attack@atk_scale'], 1); // each hit deals attack@atk_scale × ATK ("每击造成攻击力100%")
    const tripleMul = num(hidden['attack@damage_scale'], 1) * perHitScale;   // then the whole round is × 0.333
    const powerCount = Math.max(0, Math.round(num(t0.power_attack_count)));
    const powerScale = num(t0.power_attack_scale, 1);
    const returnAtk = num(t1.atk);
    const returnDur = num(t1.atk_duration, 30);

    return {
      /**
       * The trait 高精度的近距离射击 (the hidden talent): a normal attack is `attack@atk_scale` hits, each ×
       * `attack@damage_scale` — while T1's boost is armed, the ROUND's multiplier is `power_attack_scale` instead.
       */
      trait: {
        hitsFn: () => tripleHits,
        // 「若为普通攻击的伤害，则使该伤害降低至33.3%」 — the round's own multiplier, always (PRTS also notes it applies to
        // the damage AFTER DEF/RES, which this final multiplier does). T1's boost is a separate 攻击力倍率 and is NOT
        // folded in here: `dmgMul` returning 1.2 as well double-counted it.
        dmgMul: () => tripleMul,
        afterHit(battle, unit) { spendBoost(unit); },
      },
      skills: {
        // S1 刚射 (charges): 4 arrows of `atk_scale_1` × ATK; with a charge left 5 more of `atk_scale_2` whose every
        // arrow has `stun_prob` to 晕眩 `stun` s (the second volley is the kit's — see `volley` below).
        [S1]: {
          kind: 'charges',
          attack: {
            hits: S1_ARROWS,
            atkScale: num(b1.atk_scale_1, 1),
            onHit({ battle, unit, target }) {
              const p = num(b1.stun_prob), st = num(b1.stun);
              if (p > 0 && st > 0 && target && hasHp(target) && battle.rng.chance(p)) {
                battle.applyStatus(target, 'stun', { duration: st, source: unit });
              }
            },
          },
          onStart({ battle, unit, skill }) {
            // 「若还有充能则额外消耗1层施展刚连射」 — a charge left after this cast pays for the follow-up volley.
            if (skill.charges > 0) battle.after(0.25, () => volley(battle, unit, skill), { owner: unit });
            spendBoost(unit);
          },
        },
        // S2 飞翔瞪射: three volleys in the air, then a landing blast.
        [S2]: {
          kind: 'duration', duration: Math.max(0.1, num(skillRec(chess, S2)?.duration, 4.2)),
          attack: { noAttack: true },
          onStart({ battle, unit }) { airborne(battle, unit); },
          onTick({ battle, unit, skill }) { volleys(battle, unit, skill); },
          onEnd({ battle, unit }) { land(battle, unit); },
        },
        // S3 龙之箭: a chant, then a piercing arrow along her facing.
        [S3]: {
          kind: 'instant',
          onStart({ battle, unit }) { pierce(battle, unit); },
        },
      },
      talents: [
        { install(battle, unit) { // 强击瓶专家: the first cast of each deployment arms `power_attack_count` rounds
          if (!(powerCount > 0)) return;
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move) return;
            unit.mem[`${ORCHD2_KEY}:armed`] = false;
            unit.mem[`${ORCHD2_KEY}:boost`] = 0;
          }, { owner: unit });
          battle.on('skillStart', (c) => {
            if (c.unit !== unit) return;
            if (unit.mem[`${ORCHD2_KEY}:armed`]) return;
            unit.mem[`${ORCHD2_KEY}:armed`] = true;
            unit.mem[`${ORCHD2_KEY}:boost`] = powerCount;
          }, { owner: unit });
        } },
        { install(battle, unit) { // 翔虫机动: +atk for atk_duration s when she lands beside her previous tile
          if (!(returnAtk > 0)) return;
          const place = (r, c) => { unit.mem[`${ORCHD2_KEY}:lastR`] = r; unit.mem[`${ORCHD2_KEY}:lastC`] = c; };
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move) return;
            const lr = unit.mem[`${ORCHD2_KEY}:lastR`], lc = unit.mem[`${ORCHD2_KEY}:lastC`];
            const near = lr != null && Math.max(Math.abs(lr - unit.tileR), Math.abs(lc - unit.tileC)) <= RETURN_RADIUS;
            if (near) {
              battle.addBuff(unit, {
                key: `${ORCHD2_KEY}:return`, duration: returnDur, mods: { atkPct: returnAtk }, refresh: 'replace', tags: ['talent'],
              });
            }
            place(unit.tileR, unit.tileC);
          }, { owner: unit });
          battle.on('retreat', (c) => { if (c.unit === unit) place(unit.tileR, unit.tileC); }, { owner: unit });
        } },
      ],
    };

    // -------------------------------------------------------------------------------------------------------------
    // helpers

    /** One round of attacks (or one volley) burns a stack of T1 (PRTS 备注's 「消耗一层」). */
    function spendBoost(unit) {
      const n = unit.mem?.[`${ORCHD2_KEY}:boost`] ?? 0;
      if (n > 0) unit.mem[`${ORCHD2_KEY}:boost`] = n - 1;
    }

    /** The T1 multiplier for this unit right now (the trait's `dmgMul` reads it). */
    function scaleOf(unit) { return (unit.mem?.[`${ORCHD2_KEY}:boost`] ?? 0) > 0 ? powerScale : 1; }

    /** S1's 刚连射 follow-up: `attack@times_2` arrows of `atk_scale_2`, `stun_prob` per arrow (「每支箭矢有20%概率」). */
    function volley(battle, unit, skill) {
      if (!up(unit) || !skill.active) return;
      const arrows = S1_ARROWS_2;
      const scale = num(b1.atk_scale_2, 1.5);
      const p = num(b1.stun_prob), st = num(b1.stun);
      const foes = battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true });
      for (const e of foes.slice(0, 1)) {
        if (!hasHp(e)) continue;
        for (let i = 0; i < arrows; i++) {
          if (!hasHp(e)) break;
          battle.dealDamage(unit, e, {
            amount: unit.s.atk * scale * scaleOf(unit), type: 'phys', isSkill: true, tags: ['skill', 'orchd2:rapid'],
          });
          if (p > 0 && st > 0 && e.alive && battle.rng.chance(p)) {
            battle.applyStatus(e, 'stun', { duration: st, source: unit });
          }
        }
      }
      battle.fx('volley', { x: unit.x, y: unit.y, id: unit.id, skill: 'orchd2:rapid' });
      skill.charges = Math.max(0, skill.charges - 1);   // 「额外消耗1层」
      skill.sp = 0;
      spendBoost(unit);
    }

    /** S2: 起飞 — no view of the field while the skill runs (PRTS 「技能持续期间，自身丢失全部视野」). */
    function airborne(battle, unit) {
      battle.addBuff(unit, {
        key: `${ORCHD2_KEY}:fly`, duration: 4.3, flags: { liftoff: true, unblockable: true }, tags: ['skill'],
      });
      battle.releaseBlocked(unit);
      battle.fx('takeoff', { x: unit.x, y: unit.y, id: unit.id });
    }

    /** S2: the three volleys, one per third of the skill (PRTS: the animation sets the cadence, not ASPD). */
    function volleys(battle, unit, skill) {
      const m = (unit.mem[`${ORCHD2_KEY}:s2`] = unit.mem[`${ORCHD2_KEY}:s2`] ?? { n: 0, total: 0 });
      const span = Math.max(0.1, num(skillRec(chess, S2)?.duration, 4.2));
      const due = Math.min(S2_VOLLEYS.length, Math.floor((span - skill.timeLeft) / (span / S2_VOLLEYS.length)) + 1);
      const [fr, fc] = unit.fwd;
      const grid = skillRec(chess, S2)?.rangeGrid ?? null;
      const foes = grid ? enemiesInGrid(battle, unit, grid) : battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true });
      while (m.n < due) { // loop-cap: S2_VOLLEYS.length (due is min() of it)
        m.n++;
        spendBoost(unit);   // 每轮技能三/四/五连击 burns one stack
        for (const e of foes) {
          if (!hasHp(e)) continue;
          for (let i = 0; i < S2_VOLLEYS[m.n - 1]; i++) {
            battle.dealDamage(unit, e, {
              amount: unit.s.atk * num(b2['attack@atk_scale_loop'], 1.5) * scaleOf(unit), type: 'phys', isSkill: true,
              tags: ['skill', 'orchd2:s2'],
            });
          }
        }
      }
      void fr; void fc;
    }

    /** S2: the landing blast (「之后降落并对前方小范围内的所有敌人造成攻击力270%的物理伤害」). */
    function land(battle, unit) {
      battle.removeBuff(unit, `${ORCHD2_KEY}:fly`);
      unit.mem[`${ORCHD2_KEY}:s2`] = null;
      spendBoost(unit);   // 每次二技能的降落攻击 burns one stack
      const [fr, fc] = unit.fwd;
      const r = unit.tileR + fr, c = unit.tileC + fc;
      battle.fx('aoe', { x: c, y: r, radius: S2_LAND_RADIUS, id: unit.id, skill: 'orchd2:land' });
      for (const e of battle.foesInRadius(c, r, S2_LAND_RADIUS, true)) {
        if (!hasHp(e)) continue;
        battle.dealDamage(unit, e, {
          amount: unit.s.atk * num(b2['attack@atk_scale_end'], 2.7) * scaleOf(unit), type: 'phys', isSkill: true,
          tags: ['skill', 'orchd2:land'],
        });
      }
    }

    /** S3 龙之箭: the chant, then the piercing arrow along her facing, pushing and damaging what it passes. */
    function pierce(battle, unit) {
      const wait = Math.max(0, num(b3.wait_duration, 1.5));
      const fire = () => {
        if (!up(unit)) return;
        spendBoost(unit);   // 每次三技能的龙之箭 burns one stack
        const [fr, fc] = unit.fwd;
        const step = Math.max(0.05, num(b3.dist_interval, 0.25));
        const scale = num(b3.atk_scale, 1), magic = num(b3.atk_scale_magic, 0);
        const force = num(b3.force);
        const hitAt = (d) => {
          const x = unit.x + fc * d, y = unit.y + fr * d;
          battle.fx('aoe', { x, y, radius: 0.5, id: unit.id, skill: 'orchd2:dragon' });
          for (const e of battle.foesInRadius(x, y, 0.5, true)) {
            if (!hasHp(e)) continue;
            if (force > 0) battle.push(e, force, { from: { x: unit.x, y: unit.y }, dir: unit.fwd });
            // "先造成物理伤害，后造成法术伤害"
            battle.dealDamage(unit, e, {
              amount: unit.s.atk * scale * scaleOf(unit), type: 'phys', isSkill: true, tags: ['skill', 'orchd2:dragon'],
            });
            if (magic > 0 && hasHp(e)) {
              battle.dealDamage(unit, e, {
                amount: unit.s.atk * magic * scaleOf(unit), type: 'arts', isSkill: true, tags: ['skill', 'orchd2:dragonMagic'],
              });
            }
          }
        };
        let d = 0;
        // `battle.every` returns the schedule handle; its callback gets no `cancel` argument (battle/hooks.js).
        const sched = battle.every(step / S3_SPEED, () => {
          if (!up(unit) || d > S3_MAX_TILES) { sched.cancel(); return; }
          hitAt(d);
          d += step;
        }, { owner: unit });
      };
      if (wait > 0) battle.after(wait, fire, { owner: unit });
      else fire();
    }
  },
};
