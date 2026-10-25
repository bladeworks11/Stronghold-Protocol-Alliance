// server/sim/content/kits/ops/op-yato2.js — 麒麟R夜刀 (char_1029_yato2) 自选 operator kit: 5★ 处决者 (特种), a 联动 operator
// of the tier-5 and tier-6 自选 slots; all three skills, both talents and both modules at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// 本机自用：麒麟R夜刀是上游因版权排除的 7 名联动干员之一（tools/build-data.mjs DIY_INCLUDED_COLLABS、NOTICE.md §2）。
// 仅供本机个人非商业使用；不要公开分发，也不要向上游提 PR。
//
// Sources: the official skill / talent texts and blackboards as built into backups.json, plus PRTS 麒麟R夜刀 (raw), which
// carries what the data does not — the three skills' trigger 「部署瞬间即进入技能状态」 (all three are PASSIVE in the
// data: no SP, entered at deployment — the engine's `activateOnDeploy`), the 六连击 timing, the 乱舞 slash count, and
// 空中回旋乱舞's dash projectile.
//
// Forms (data/backups.json units.char_1029_yato2): normal = E2 Lv1 rank 4 no module; elite = E2 Lv60 rank 7, EXE-X at
// stage 1 (tier 5) / 3 (tier 6). 再部署 18 s; 攻击间隔 0.93 s; 攻击范围 1-1; 阻挡 1.
// - Trait (处决者) "再部署时间大幅度减少": the profession default (professions.js executor).
// - T1 双雷剑麒麟 "攻击额外造成攻击力20%的法术伤害" (`attack@atk_scale_1`; PRTS 备注 "本天赋的伤害不触发敌人的受击回复"):
//   every attack deals an extra `attack@atk_scale_1` × ATK arts hit on the same target — a skill hit, so no 受击回复.
//   EXE-Y stage 2+ raises the scale (talent change) and adds 术法充盈 plus a free first retreat — the retreat rules are
//   the match's, the stat part is read below.
// - T2 鬼人强化状态 "技能期间及技能结束后的10秒内攻击力+16%" (`atk` / `duration`): ATK +`atk` while one of her skills runs
//   and for `duration` s after it ends; EXE-X stage 2+ adds the module's hidden `atk` on top, in-skill only.
// - EXE-Y “罗德岛制式双刀” "周围四格没有友方干员时攻击力+10%" (trait bb `atk`): ATK +`atk` while no ally stands within
//   Chebyshev 1 of her — a conditional buff (toggleBuff). EXE-X “训练用木桩” adds "撤退时返还大量(80%)该次部署费用",
//   which this mode has no use for (the deployment is free) [ASSUMED, as 推进之王's SOL-Y].
// - S1 鬼人化 (PASSIVE → entered at deployment, 20 s): ASPD +`attack_speed`, every attack becomes two hits, and — per
//   target — every THIRD attack becomes six hits (PRTS 备注 "技能期间对每个目标的每第三次攻击变为六连击；六连击占用2个攻击
//   间隔（前4连击+后2连击）").
// - S2 乱舞 (PASSIVE → entered at deployment): T1 ×`talent_scale`, ATK ×`atk_scale`, and 16 slashes on every enemy of the
//   tile ahead; 期间更容易受到敌人的攻击 = 嘲讽 `taunt_level`; PRTS 备注 "固定攻击动画不受攻击速度影响" (the slashes run on
//   their own clock) and the skill carries 晕眩 / 冻结 / 沉睡 immunity while it runs.
// - S3 空中回旋乱舞 (PASSIVE → entered at deployment): a dash forward, a slash of `atk_scale` × ATK on every enemy around
//   each step (air units too), the dash extended by `dist_unit` tiles per enemy hit up to `max_dist`; PRTS 备注 gives
//   无敌 / 不可阻挡 / 晕眩·冻结·沉睡免疫 while it runs and a projectile of 8 tiles/s with a 0.51 radius judging every frame.
//   The dash radius is not in any source [ASSUMED: the 溅射 1.0 convention].

import { num, talentBb, traitBb, moduleBb, skillRec, up, toggleBuff } from '../shared/tier1.js';
import { hasHp } from '../../../attack.js';

const S1 = 'skchr_yato2_1';
const S2 = 'skchr_yato2_2';
const S3 = 'skchr_yato2_3';
/** S1 鬼人化's length: the data carries dur = −1 for a PASSIVE; PRTS's 持续 column gives 20 in every level. */
const S1_DURATION = 20;
/** S2 乱舞: the slashes [PRTS "对前方一格的所有敌人发动16次斩击"]. */
const S2_SLASHES = 16;
/** S2's slashes run on the animation's own clock ("固定攻击动画不受攻击速度影响"), spread over this many seconds. */
const S2_SPAN = 2;
/** S2 / S3's slash radius around their point [ASSUMED: no source gives a number — the 溅射 1.0 convention]. */
const SLASH_RADIUS = 1.0;
/** S3's dash: one step per tick. */
const S3_STEP = 0.05;
/** S3's dash cap: the skill's own schedule [ASSUMED: the dash ends by distance, this only bounds the loop]. */
const S3_MAX_STEPS = 40;
const YATO2_KEY = 'yato2';
const IMMUNE_STATUSES = new Set(['stun', 'freeze', 'sleep']);

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};

export default {
  char_1029_yato2: (bb, chess) => {
    const t0 = talentBb(chess, 0);            // 双雷剑麒麟: attack@atk_scale_1
    const t1 = talentBb(chess, 1);            // 鬼人强化状态: atk / duration
    const tb = traitBb(chess);                // EXE-Y: atk while no ally on the four neighbours
    const hidden = moduleBb(chess);           // EXE-X stage 2+: the extra in-skill atk
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const extraArts = num(t0['attack@atk_scale_1']);
    const t2Atk = num(t1.atk);
    const t2Dur = num(t1.duration, 10);
    const loneAtk = num(tb.atk);
    const inSkillAtk = num(hidden.atk);
    const s2Scale = num(b2.atk_scale, 1);
    const s3Scale = num(b3.atk_scale, 1);

    return {
      skills: {
        // S1 鬼人化: ASPD +attack_speed; two hits a swing, and every third attack on ONE target six.
        [S1]: {
          kind: 'duration', duration: S1_DURATION, activateOnDeploy: true, trigger: 'NEVER',
          mods: { aspd: num(b1.attack_speed) },
          attack: { hits: 2, hitsFn: comboHits },
        },
        // S2 乱舞: the talent scaled up, ATK ×atk_scale, 16 slashes on the tile ahead, a raised taunt, and immunity.
        [S2]: {
          kind: 'duration', duration: S2_SPAN, activateOnDeploy: true, trigger: 'NEVER',
          mods: { atkPct: s2Scale - 1, taunt: num(b2.taunt_level) },
          attack: { noAttack: true },
          onStart({ battle, unit }) {
            unit.mem.yato2S2 = { n: 0 };
            immune(battle, unit);
            battle.fx('dance', { x: unit.x, y: unit.y, id: unit.id, skill: 'yato2:blade' });
          },
          onTick({ battle, unit, skill }) {
            const m = unit.mem.yato2S2;
            if (!m) return;
            const [fr, fc] = unit.fwd;
            const due = Math.min(S2_SLASHES, Math.floor((skill.duration - skill.timeLeft) / (S2_SPAN / S2_SLASHES)) + 1);
            while (m.n < due) { // loop-cap: S2_SLASHES (due is min() of it)
              m.n++;
              slash(battle, unit, unit.x + fc, unit.y + fr, SLASH_RADIUS, s2Scale, 'yato2:blade');
            }
          },
          onEnd({ unit }) { unit.mem.yato2S2 = null; },
        },
        // S3 空中回旋乱舞: the dash and its per-step slash; the skill ends when the dash does.
        [S3]: {
          kind: 'duration', duration: 4, activateOnDeploy: true, trigger: 'NEVER', attack: { noAttack: true },
          onStart({ battle, unit }) {
            unit.mem.yato2S3 = {
              left: Math.max(1, Math.round(num(b3.min_dist, 2))), max: num(b3.max_dist, 5),
              per: num(b3.dist_unit, 0.3), steps: 0, acc: 0, done: false,
            };
            battle.addBuff(unit, { key: `${YATO2_KEY}:dash`, flags: { invulnerable: true, unblockable: true, noBlock: true }, tags: ['skill'] });
            immune(battle, unit);
            battle.releaseBlocked(unit);
            battle.fx('dash', { x: unit.x, y: unit.y, id: unit.id, skill: 'yato2:spin' });
          },
          onTick({ battle, unit, skill, dt }) {
            const m = unit.mem.yato2S3;
            if (!m || m.done) return;
            // The dash runs on its own cadence, so the skill's clock is held open while it lasts. It MUST stay positive:
            // a timeLeft at or below 0 ends the skill on the next tick (skills.js `_tick`), which would cut the dash off.
            skill.timeLeft = Math.max(skill.timeLeft, dt + 1e-3);
            m.acc += dt;
            while (!m.done && m.acc + 1e-9 >= S3_STEP) { // loop-cap: dashStep sets m.done, one S3_STEP a pass
              m.acc -= S3_STEP;
              dashStep(battle, unit, m);
            }
            if (m.done) skill.timeLeft = 0;   // let the engine close it out
          },
          onEnd({ battle, unit }) {
            battle.removeBuff(unit, `${YATO2_KEY}:dash`);
            unit.mem.yato2S3 = null;
          },
        },
      },
      talents: [
        { install(battle, unit) { // 双雷剑麒麟: an extra arts hit on every attack
          if (!(extraArts > 0)) return;
          battle.on('hit', (c) => {
            if (c.source !== unit || !c.dmg || !c.dmg.isAttack || !c.target || !hasHp(c.target)) return;
            battle.dealDamage(unit, c.target, {
              amount: unit.s.atk * extraArts, type: 'arts', isSkill: true, tags: ['talent', 'yato2:thunder'],
            });
          }, { owner: unit });
        } },
        { install(battle, unit) { // S1's combo counter needs the attack's target (`hitsFn` gets none)
          battle.on('beforeAttack', (c) => {
            if (c.attacker !== unit) return;   // the ctx is { attacker, targets, isSkill, profile }
            unit.mem.yato2ComboTarget = (c.targets ?? [])[0] ?? null;
          }, { owner: unit, priority: -50 });
        } },
        { install(battle, unit) { // 鬼人强化状态: ATK +atk while a skill runs and for duration s after it ends
          if (!(t2Atk > 0)) return;
          let until = -Infinity;
          const want = () => t2Atk + (unit.skill?.active ? inSkillAtk : 0);
          const sync = () => {
            const has = unit.findBuff(`${YATO2_KEY}:demon`);
            const on = !!unit.skill?.active || (up(unit) && battle.time < until);
            if (!on) { if (has) battle.removeBuff(unit, `${YATO2_KEY}:demon`); return; }
            if (!has || Math.abs((has.mods?.atkPct ?? 0) - want()) > 1e-9) {
              battle.addBuff(unit, { key: `${YATO2_KEY}:demon`, mods: { atkPct: want() }, refresh: 'replace', tags: ['talent'] });
            }
          };
          battle.on('skillStart', (c) => { if (c.unit === unit) { until = Infinity; sync(); } }, { owner: unit });
          battle.on('skillEnd', (c) => { if (c.unit === unit) until = battle.time + t2Dur; sync(); }, { owner: unit });
          battle.on('tick', sync, { owner: unit });
          battle.on('deploy', (c) => { if (c.unit === unit) { until = -Infinity; sync(); } }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        // EXE-Y “罗德岛制式双刀”: ATK +atk while no ally stands on the eight tiles around her.
        if (loneAtk > 0) {
          toggleBuff(battle, unit, `${YATO2_KEY}:lone`, () => battle.allyUnits.every((a) => a === unit || !a.alive || !a.deployed
            || Math.abs(a.tileR - unit.tileR) > 1 || Math.abs(a.tileC - unit.tileC) > 1), { atkPct: loneAtk });
        }
      },
    };

    /** 晕眩 / 冻结 / 沉睡 immunity while the running skill lasts (the official line of 乱舞 and 空中回旋乱舞). */
    function immune(battle, unit) {
      const cancel = (c) => {
        if (c.target !== unit || !IMMUNE_STATUSES.has(c.status)) return;
        if (unit.skill?.active) c.cancel = true;
      };
      if (!unit.mem.yato2Immune) {
        unit.mem.yato2Immune = true;
        battle.on('beforeStatus', cancel, { owner: unit, priority: -100 });
      }
    }

    /** One slash: `scale` × ATK physical on every enemy within `radius` of (x, y), air units included. */
    function slash(battle, unit, x, y, radius, scale, tag) {
      battle.fx('aoe', { x, y, radius, id: unit.id, skill: tag });
      for (const e of battle.foesInRadius(x, y, radius, true)) {
        if (hasHp(e)) battle.dealDamage(unit, e, { amount: unit.s.atk * scale, type: 'phys', isSkill: true, tags: ['skill', tag] });
      }
    }

    /**
     * S1's per-target combo (PRTS 备注): every third attack against ONE target becomes six hits. The engine's `hitsFn`
     * gets `info = { isSkill, index, attackId, energy }` — no target — so the target is taken from the `beforeAttack`
     * hook, which fires just before the attack is resolved.
     */
    function comboHits(battle, unit) {
      const t = unit.mem.yato2ComboTarget;
      if (!t) return 2;
      const m = (unit.mem.yato2Combo = unit.mem.yato2Combo ?? new Map());
      const n = (m.get(t) ?? 0) + 1;
      m.set(t, n);
      return n % 3 === 0 ? 6 : 2;
    }

    /** One dash step: forward if the tile is free, a slash around the point, and reach extended by what it caught. */
    function dashStep(battle, unit, m) {
      if (!up(unit) || m.steps >= S3_MAX_STEPS) { m.done = true; return; }
      m.steps++;
      const [fr, fc] = unit.fwd;
      if (battle.relocate(unit, unit.tileR + fr, unit.tileC + fc)) m.left = Math.max(0, m.left - 1);
      const hits = battle.foesInRadius(unit.x, unit.y, SLASH_RADIUS, true).filter(hasHp).length;
      slash(battle, unit, unit.x, unit.y, SLASH_RADIUS, s3Scale, 'yato2:spin');
      // "期间每攻击到一个敌人都会使突进距离延长（最多延长至5格）"
      m.left = Math.min(num(b3.max_dist, 5), m.left + hits * m.per);
      if (m.left <= 0) m.done = true;
    }
  },
};
