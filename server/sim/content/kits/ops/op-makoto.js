// server/sim/content/kits/ops/op-makoto.js — 结城理 (char_4217_makoto) 自选 operator kit: 5★ 傀儡师 (特种), a 联动 operator
// of the tier-5 and tier-6 自选 slots; all three skills, both talents and the module at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// 本机自用：结城理是上游因版权排除的 7 名联动干员之一（tools/build-data.mjs DIY_INCLUDED_COLLABS、NOTICE.md §2）。
// 仅供本机个人非商业使用；不要公开分发，也不要向上游提 PR。
//
// Sources: PRTS 结城理 (raw) — the character's rules live almost entirely in its prose, because the trait's 替身 switching
// is engine behaviour (professions.js installDollkeeper) and each skill REPLACES what the 替身 does. Key lines:
//   * 特性备注 「切换期间额外持有静默和无法行动免疫」
//   * T1 不羁之力 「<替身>状态下结城理召唤人格面具作战，攻击间隔增大(+0.4)，攻击力+atk，生命值+hp；作战能力随技能选择而改变」
//     and at 精英1+ 「切换为<替身>状态时停顿周围一定范围内敌人sluggish秒」
//   * T2 S.E.E.S.队长 「<替身>状态结束后，带领【S.E.E.S.】小队发动总攻击，对【S.E.E.S.】小队队员周围一定范围内的所有敌人造成
//     相当于结城理攻击力total%的真实伤害（可叠加）」 + 备注 「会先切换为<总攻击>形态发起总攻击（不享受<替身>形态的天赋/技能加成），
//     随后再切换回<本体>形态」「<总攻击>期间持有无敌、静默」「每个队员发动的总攻击均可对空，其伤害范围 x-1」
//   * S1 俄耳甫斯 / S2 塔纳托斯 / S3 先塔纳托斯·改再俄耳甫斯·改, each with its own rules
// The engine's doll switching, its 20 s duration, the switch animation and the 沉默/无法行动 immunity during it are all
// professions.js; this kit drives WHICH persona is out and what it does.
//
// 攻击间隔 1.2 s; 攻击范围 1-1; 阻挡 2.
// - T1 不羁之力: the 替身's ATK +`atk` and HP +`hp` (the engine applies `dollDuration`; the stats are this kit's, below),
//   and — 精英1+ — a 停顿 `sluggish` s on every enemy in the 替身's own range when the switch happens (PRTS 备注
//   「仅有从<本体>形态切换为任意<替身>形态时才会触发」, and its range 与<替身>的攻击范围相同).
// - T2 S.E.E.S.队长: when the 替身 ends, the 【S.E.E.S.】 members each fire a 总攻击 — `atk` × 结城理's ATK as TRUE damage on
//   every enemy within x-1 of that member [the member's own reach is read from their tile; 结城理 himself does not answer
//   his own call, PRTS 备注 「结城理不会响应其他结城理带领发动的总攻击」].
// - S1 俄耳甫斯的竖琴: the 替身 becomes 俄耳甫斯 — attacks deal `atk_scale` × ATK ARTS, and while a treatable ally at or
//   below 50 % HP stands in range it heals the lowest-HP one for `heal_scale` × ATK instead. PRTS 备注: 阻回 + 静默,
//   no air targets, and the switch ENDS the skill (so the cast is instantaneous).
// - S2 塔纳托斯的囚锁: the 替身 becomes 塔纳托斯 — attacks hit up to `max_target` enemies for `atk_scale` × ATK arts with a
//   `prob` chance of 恐惧 `fear` s, and a 恐惧 enemy in range whose HP is at or below `exec_hp_scale` × 结城理's ATK is
//   executed (PRTS: 9999999 无来源真实斩杀伤害, at most once per entry into the range).
// - S3 开辟明日的剑刃: the 替身 先 becomes 塔纳托斯·改 — ASPD +`attack_speed`, attacks up to `max_target` enemies for
//   `atk_scale` × ATK 弱点伤害, can hit air; then 俄耳甫斯·改 — no attack, 阻挡 back to normal, +`block_cnt` block, and
//   every second a delayed heal of `heal_scale` × ATK on up to `heal_target` allies, plus `dodge` physical/arts dodge for
//   the allies in range while it lasts.

import { num, talentBb, skillRec, up } from '../shared/tier1.js';
import { hasHp } from '../../../attack.js';

const S1 = 'skchr_makoto_1';
const S2 = 'skchr_makoto_2';
const S3 = 'skchr_makoto_3';
/** T2's 总攻击 reach around each 【S.E.E.S.】 member [PRTS 备注 "其伤害范围 x-1"]. */
const TEAM_ATTACK_RADIUS = 1.5;
/** T2's 总攻击: the members answer at most this often per call [PRTS 备注 "每隔1.6秒处理一次总攻击效果"]. */
const TEAM_ATTACK_GAP = 1.6;
/** S1: the heal's threshold [PRTS "生命值不高于50%的友方干员"]. */
const S1_HEAL_AT = 0.5;
/** S2's execution radius: its own attack range, and the 0.1 s re-check of PRTS 备注. */
const S2_EXEC_IV = 0.1;
const MAKOTO_KEY = 'makoto';
/** The three 替身 forms this kit drives (the engine only knows 'doll'). */
const FORM_ORPHEUS = 'orpheus';
const FORM_THANATOS = 'thanatos';
const FORM_ORPHEUS_KAI = 'orpheusKai';

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};

export default {
  char_4217_makoto: (bb, chess) => {
    const t0 = talentBb(chess, 0);   // 不羁之力: atk / hp / sluggish
    const t1 = talentBb(chess, 1);   // S.E.E.S.队长: total
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const dollAtk = num(t0.atk);
    const dollHp = num(t0.hp);
    const slowOnSwitch = num(t0.sluggish);
    const teamScale = num(t1.total);

    return {
      skills: {
        // S1 俄耳甫斯的竖琴: the 替身 becomes 俄耳甫斯 (arts attacks, or heals a hurt ally).
        [S1]: {
          kind: 'instant',
          onStart({ battle, unit }) { switchTo(battle, unit, FORM_ORPHEUS); },
        },
        // S2 塔纳托斯的囚锁: the 替身 becomes 塔纳托斯 (multi-target arts, 恐惧, and an execution).
        [S2]: {
          kind: 'instant',
          onStart({ battle, unit }) { switchTo(battle, unit, FORM_THANATOS); },
        },
        // S3 开辟明日的剑刃: 塔纳托斯·改, then 俄耳甫斯·改 on the next cast while it stands.
        [S3]: {
          kind: 'instant',
          onStart({ battle, unit }) {
            const cur = unit.mem[`${MAKOTO_KEY}:form`];
            switchTo(battle, unit, cur === FORM_THANATOS ? FORM_ORPHEUS_KAI : FORM_THANATOS);
          },
        },
      },
      talents: [
        { install(battle, unit) { // 不羁之力: the 替身's stat line and the switch's 停顿
          if (!(dollAtk > 0 || dollHp > 0)) return;
          battle.on('dollSwap', (c) => {
            if (c.unit !== unit || c.form !== 'doll') return;
            // 「切换为<替身>状态时停顿周围一定范围内敌人」; its range is the 替身's own attack range (x-1)
            for (const e of battle.foesInRadius(unit.x, unit.y, TEAM_ATTACK_RADIUS, true)) {
              if (slowOnSwitch > 0 && hasHp(e)) battle.applyStatus(e, 'sluggish', { duration: slowOnSwitch, source: unit });
            }
            battle.addBuff(unit, {
              key: `${MAKOTO_KEY}:doll`, refresh: 'replace', tags: ['talent'],
              mods: { atkPct: dollAtk, hpPct: dollHp },
            });
          }, { owner: unit });
          battle.on('dollSwap', (c) => {
            if (c.unit === unit && c.form === null) battle.removeBuff(unit, `${MAKOTO_KEY}:doll`);
          }, { owner: unit });
        } },
        { install(battle, unit) { // S.E.E.S.队长: the 总攻击 when the 替身 ends
          if (!(teamScale > 0)) return;
          battle.on('dollSwap', (c) => {
            if (c.unit !== unit || c.form !== null) return;   // the 替身 ended
            teamAttack(battle, unit, teamScale);
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        /** The 本体's own damage type, restored when the 替身 leaves. */
        const baseDmgType = unit.profile?.dmgType ?? 'phys';
        battle.on('dollSwap', (c) => {
          if (c.unit === unit && c.form === null && unit.profile) unit.profile.dmgType = baseDmgType;
        }, { owner: unit });
        // S1's ranged rule: 俄耳甫斯 talks to the ally that needs it most, and cannot hit air.
        battle.on('attack', (c) => {
          if (c.attacker !== unit) return;
          const form = unit.mem[`${MAKOTO_KEY}:form`];
          if (form !== FORM_ORPHEUS && form !== FORM_ORPHEUS_KAI) return;
          if (form === FORM_ORPHEUS_KAI) { c.targets = []; return; }   // 俄耳甫斯·改 does not attack
        }, { owner: unit, priority: -60 });
        // S1 俄耳甫斯: with a treatable ally at or below `S1_HEAL_AT` in range, its attack heals instead.
        battle.on('beforeAttack', (c) => {
          if (c.attacker !== unit) return;
          if (unit.mem[`${MAKOTO_KEY}:form`] !== FORM_ORPHEUS) return;
          const hurt = alliesIn(battle, unit).filter((a) => a.hpRatio <= S1_HEAL_AT);
          if (!hurt.length) return;
          hurt.sort((a, b) => a.hpRatio - b.hpRatio);
          unit.mem[`${MAKOTO_KEY}:healTarget`] = hurt[0];
        }, { owner: unit, priority: -60 });
        battle.on('attack', (c) => {
          if (c.attacker !== unit) return;
          const t = unit.mem[`${MAKOTO_KEY}:healTarget`];
          unit.mem[`${MAKOTO_KEY}:healTarget`] = null;
          if (!t || !t.alive) return;
          const scale = num(b1.heal_scale);
          if (scale > 0) battle.heal(unit, t, { amount: unit.s.atk * scale, isSkill: true });
          c.targets = [];   // the attack became the heal
        }, { owner: unit, priority: -80 });
        // S2 塔纳托斯: the 恐惧 execution aura (PRTS: checked every 0.1 s, once per entry into the range).
        battle.every(S2_EXEC_IV, () => {
          if (!up(unit) || unit.mem[`${MAKOTO_KEY}:form`] !== FORM_THANATOS) return;
          const threshold = num(b2.exec_hp_scale) * unit.s.atk;
          if (!(threshold > 0)) return;
          const done = (unit.mem[`${MAKOTO_KEY}:executed`] = unit.mem[`${MAKOTO_KEY}:executed`] ?? new Set());
          for (const e of battle.foesInRadius(unit.x, unit.y, 1.5, true)) {
            if (!hasHp(e) || !e.findBuff('fear') || done.has(e)) continue;
            if (e.hp > threshold) continue;
            done.add(e);
            battle.dealDamage(unit, e, { amount: 9999999, type: 'true', isSkill: true, tags: ['skill', 'makoto:exec'] });
          }
        }, { owner: unit });
        // S2's attacks: up to `max_target` enemies, `atk_scale` × ATK arts, `prob` to 恐惧.
        battle.on('attack', (c) => {
          if (c.attacker !== unit || unit.mem[`${MAKOTO_KEY}:form`] !== FORM_THANATOS) return;
          const t = (c.targets ?? [])[0];
          if (!t) return;
          const extra = battle.foesInRadius(t.x, t.y, 1.5, true).filter((e) => hasHp(e) && e !== t)
            .slice(0, Math.max(0, Math.round(num(b2.max_target, 3)) - 1));
          const prob = num(b2.prob), fear = num(b2.fear);
          for (const e of [t, ...extra]) {
            if (prob > 0 && fear > 0 && e.alive && battle.rng.chance(prob)) {
              battle.applyStatus(e, 'fear', { duration: fear, source: unit });
            }
          }
        }, { owner: unit, priority: -70 });
        // S3 俄耳甫斯·改: a delayed heal on up to `heal_target` allies every second, and the dodge aura.
        battle.every(1, () => {
          if (!up(unit) || unit.mem[`${MAKOTO_KEY}:form`] !== FORM_ORPHEUS_KAI) return;
          const scale = num(b3.heal_scale);
          const n = Math.max(1, Math.round(num(b3.heal_target, 3)));
          const hurt = alliesIn(battle, unit).filter((a) => a.hp < a.s.maxHp).slice(0, n);
          for (const a of hurt) {
            if (scale > 0) battle.after(0.5, () => { if (a.alive) battle.heal(unit, a, { amount: unit.s.atk * scale, isSkill: true }); }, { owner: unit });
          }
        }, { owner: unit });
        battle.every(0.5, () => {
          if (!up(unit) || unit.mem[`${MAKOTO_KEY}:form`] !== FORM_ORPHEUS_KAI) return;
          const dodge = num(b3.dodge);
          if (!(dodge > 0)) return;
          for (const a of alliesIn(battle, unit)) {
            battle.addBuff(a, { key: `${MAKOTO_KEY}:guard`, refresh: 'replace', duration: 1, tags: ['skill'],
              mods: { dodgePhys: dodge, dodgeArts: dodge } });
          }
        }, { owner: unit });
      },
    };

    // -------------------------------------------------------------------------------------------------------------
    // helpers

    /** The 替身's switch, and which persona's rules apply while it is out (the switch itself is `professions.js`). */
    function switchTo(battle, unit, form) {
      unit.mem[`${MAKOTO_KEY}:form`] = form;
      unit.mem[`${MAKOTO_KEY}:executed`] = null;
      // A persona's normal attack is ARTS (PRTS 「普通攻击造成法术普通伤害」 for 俄耳甫斯 and 塔纳托斯 alike). The unit's
      // PROFILE is patched directly — the attack hook's `c.profile` is resolved before the damage is built, so mutating
      // it there does not land. The 本体's own type is restored when the 替身 ends.
      if (unit.profile) unit.profile.dmgType = 'arts';
      battle.emit('dollSwitch', { unit, reason: 'skill', done: false });
      battle.fx('summon', { x: unit.x, y: unit.y, id: unit.id, kind: `makoto:${form}` });
    }

    /** The deployed allies (operators and summons a heal may touch) within the 替身's reach. */
    function alliesIn(battle, unit) {
      return battle.allyUnits.filter((a) => a !== unit && a.alive && a.deployed && a.kind !== 'device'
        && Math.max(Math.abs(a.tileR - unit.tileR), Math.abs(a.tileC - unit.tileC)) <= 1);
    }

    /**
     * T2's 总攻击: every 【S.E.E.S.】 member on the field strikes `scale` × 结城理's ATK as TRUE damage on the enemies
     * within x-1 of that member. 结城理 himself leads rather than answering (PRTS 备注), and the members are spaced
     * `TEAM_ATTACK_GAP` apart.
     */
    function teamAttack(battle, unit, scale) {
      const members = battle.allyUnits.filter((a) => a.alive && a.deployed && isSees(a));
      const others = members.filter((a) => a !== unit);
      const list = others.length ? others : [];
      list.forEach((m, i) => {
        battle.after(i * TEAM_ATTACK_GAP, () => {
          if (!unit.alive || !m.alive) return;
          battle.fx('aoe', { x: m.x, y: m.y, radius: TEAM_ATTACK_RADIUS, id: unit.id, skill: 'makoto:team' });
          for (const e of battle.foesInRadius(m.x, m.y, TEAM_ATTACK_RADIUS, true)) {
            if (hasHp(e)) {
              battle.dealDamage(unit, e, {
                amount: unit.s.atk * scale, type: 'true', isSkill: true, tags: ['skill', 'makoto:team'],
              });
            }
          }
        }, { owner: unit });
      });
      // 结城理's own 总攻击 形态 (无敌 + 静默 while it plays out)
      battle.addBuff(unit, {
        key: `${MAKOTO_KEY}:allout`, duration: 0.6, tags: ['talent'],
        flags: { invulnerable: true, silence: true },
      });
    }

    /** Whether `a` belongs to 【S.E.E.S.】 (the data gives 结城理 the `sees` power). */
    function isSees(a) {
      const powers = a?.def?.raw?.powers ?? a?.def?.powers ?? [];
      return Array.isArray(powers) && powers.includes('sees');
    }
  },
};
