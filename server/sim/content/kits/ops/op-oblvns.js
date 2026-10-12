// server/sim/content/kits/ops/op-oblvns.js — 丰川祥子 (char_4182_oblvns) 自选 operator kit: 5★ 领主 (近卫), a 联动 operator
// of the tier-5 and tier-6 自选 slots; all three skills, both talents and the module at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// 本机自用：丰川祥子是上游因版权排除的 7 名联动干员之一（tools/build-data.mjs DIY_INCLUDED_COLLABS、NOTICE.md §2）。
// 仅供本机个人非商业使用；不要公开分发，也不要向上游提 PR。
//
// Sources: the official skill / talent texts and blackboards as built into backups.json, plus two lookups the data alone
// did not settle:
//   * PRTS 丰川祥子 (raw) for the skill shapes (S2's two timbres, S3's dual notes);
//   * `.cache/gamedata/excel/gamedata_const.json` `termDescriptionDict['ba.fever']` for Fever itself:
//     「Fever 累计至450点时，任意一位【Ave Mujica】成员手动触发技能后，在场所有【Ave Mujica】成员20秒内会持续释放当前技能」
//     — a counter her T2 fills (`cnt` per damage instance), 450 to arm, and a 20 s window that re-casts her skill.
//
// 领主 (近卫) trait 「可以进行远程攻击，但此时攻击力降低至80%」: the profession default.
// - T1 颂乐音符 「丰川祥子可以持续攻击且攻击会演奏追踪敌人的音符，音符飘出攻击范围一段时间后消失。每存在一个音符，【Ave Mujica】
//   成员无视敌人def_penetrate_ratio的防御力和magic_resist_penetrate_ratio法术抗性（最多叠加至max_cnt层）」
//   At full potential `def_penetrate_ratio` 0.03 / `magic_resist_penetrate_ratio` 0.02 / `max_cnt` 10. The notes are the
//   homing projectiles her attacks play (see `note`); every note in flight gives the bond's members penetration, so the
//   stacks are counted from the notes this kit has in the air.
// - T2 毋畏遗忘 「对敌人造成伤害时使Fever+cnt；其他【Ave Mujica】成员的攻击范围若与自身原本攻击范围重合，则将其视作攻击范围的
//   延伸；攻击范围内干员攻击速度+attack_speed」 (`enable` / `attack_speed` / `cnt`; at full potential 16 / 3).
//   The FEVER counter is hers (see the header); the range-extension clause is a placement rule the match owns; the ATK
//   speed is an aura on the operators in her range (installAura).
// - S1 新月的苏醒 (MANUAL, 2 charges): 「演奏出8个音符。每个音符造成的法术伤害依次从攻击力的atk_scale逐渐降低至atk_scale_8」
//   — 8 notes, arts, each at its own share of ATK, spread over `angle`.
// - S2 满月的舞会 (MANUAL, 1 charge): a timbre toggle. 钢琴 (the opening one): ATK +`attack@atk` and the notes pierce for
//   PHYSICAL; 风琴: ASPD +`attack@attack_speed` and the notes are ARTS. 「Fever期间变为当前音色的二连击」 — in Fever every
//   note plays twice. The timbre is switched per cast (the mode has no manual control, so the kit alternates them).
// - S3 残月的余响 (MANUAL, 25 s, 1 charge): 「攻击范围扩大，攻击同时使用钢琴和风琴音色演奏，各自演奏2个造成相当于攻击力
//   attack@atk_scale物理和法术伤害的音符，且分别追踪法术抗性和防御力最高的敌人」 — four notes a swing, two physical on the
//   highest-DEF enemy and two arts on the highest-RES one. 「Fever期间【Ave Mujica】成员受到致命伤害时不撤退，Fever结束后退场」
//   is a bond-wide death rule the match's 盟约 side would own [ASSUMED: not implemented here].

import { num, talentBb, traitBb, moduleBb, skillRec, up, installAura, statBuff } from '../shared/tier1.js';
import { hasHp } from '../../../damage.js';

const S1 = 'skchr_oblvns_1';
const S2 = 'skchr_oblvns_2';
const S3 = 'skchr_oblvns_3';
/** `ba.fever` (gamedata_const termDescriptionDict): the counter arming Fever, and the window it opens. */
const FEVER_MAX = 450;
const FEVER_WINDOW = 20;
/** T1: how long a note stays in the air ["音符飘出攻击范围一段时间后消失"] [ASSUMED: no blackboard key carries it]. */
const NOTE_LIFE = 3;
/** S1: the notes it plays ["演奏出8个音符"]. */
const S1_NOTES = 8;
/** S1's notes fly at `angle` degrees apart. */
const S1_SPREAD = 15;
/** S3's two timbres play two notes each ["各自演奏2个"]. */
const S3_NOTES_PER_TIMBRE = 2;
/** Note flight speed in tiles/s [ASSUMED: the engine's bolt speed is the convention for a homing note]. */
const NOTE_SPEED = 10;
const OBLVNS_KEY = 'oblvns';
/**
 * Battle-wide state (the FEVER counter is the field's, not one unit's). Battle-level state lives in a module-level
 * WeakMap in this repo's kits (op-narant.js `STOLEN`, op-vvana.js `STOLEN`), since Battle itself keeps no `mem`.
 */
const STATE = new WeakMap();
const stateOf = (battle) => {
  let s = STATE.get(battle);
  if (!s) STATE.set(battle, (s = { fever: { points: 0, until: -Infinity } }));
  return s;
};

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};

export default {
  char_4182_oblvns: (bb, chess) => {
    const t0 = talentBb(chess, 0);            // 颂乐音符: def_penetrate_ratio / magic_resist_penetrate_ratio / max_cnt
    const t1 = talentBb(chess, 1);            // 毋畏遗忘: enable / attack_speed / cnt
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const penDef = num(t0.def_penetrate_ratio);
    const penRes = num(t0.magic_resist_penetrate_ratio);
    const maxNotes = Math.max(1, Math.round(num(t0.max_cnt, 10)));
    const feverStep = Math.max(0, Math.round(num(t1.cnt)));
    const auraAspd = num(t1.attack_speed);
    const s2Atk = num(b2['attack@atk']);
    const s2Aspd = num(b2['attack@attack_speed']);
    const s3Scale = num(b3['attack@atk_scale'], 1.55);
    const s1Scales = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => num(b1[i === 0 ? 'atk_scale' : `atk_scale_${i + 1}`], 0));

    return {
      skills: {
        // S1 新月的苏醒: eight notes, each a smaller share of ATK, spread over the angle.
        [S1]: {
          kind: 'charges',
          attack: { noAttack: true },
          onStart({ battle, unit }) {
            const foes = liveFoes(battle, unit);
            if (!foes.length) return;
            for (let i = 0; i < S1_NOTES; i++) {
              const scale = s1Scales[i] ?? 0;
              if (!(scale > 0)) continue;
              note(battle, unit, foes[i % foes.length], scale, 'arts', i * S1_SPREAD - (S1_NOTES - 1) * S1_SPREAD / 2);
            }
          },
        },
        // S2 满月的舞会: a timbre. 钢琴 = ATK & piercing physical notes; 风琴 = ASPD & arts notes.
        [S2]: {
          kind: 'toggle',
          onStart({ battle, unit }) {
            const m = (unit.mem[`${OBLVNS_KEY}:s2`] = unit.mem[`${OBLVNS_KEY}:s2`] ?? { piano: true });
            m.piano = !m.piano;   // the toggle switches timbre on every cast
            m.active = true;
            syncTimbre(battle, unit);
          },
          onEnd({ battle, unit }) {
            const m = unit.mem[`${OBLVNS_KEY}:s2`];
            if (m) m.active = false;
            battle.removeBuff(unit, `${OBLVNS_KEY}:piano`);
            battle.removeBuff(unit, `${OBLVNS_KEY}:organ`);
          },
          onTick({ battle, unit }) { syncTimbre(battle, unit); },
        },
        // S3 残月的余响: the range widens and every attack plays four notes (two physical, two arts).
        [S3]: {
          kind: 'duration', duration: Math.max(1, num(skillRec(chess, S3)?.duration, 25)),
          onStart({ battle, unit }) { unit.mem[`${OBLVNS_KEY}:s3`] = true; },
          onEnd({ unit }) { unit.mem[`${OBLVNS_KEY}:s3`] = null; },
        },
      },
      talents: [
        { install(battle, unit) { // 颂乐音符: the notes give the bond's members penetration while they are in the air
          if (!(penDef > 0 || penRes > 0)) return;
          battle.every(0.25, () => {
            if (!up(unit)) return;
            const n = Math.min(maxNotes, unit.mem[`${OBLVNS_KEY}:notes`] ?? 0);
            for (const a of battle.alliesFor(unit)) {
              if (!a.alive || !a.deployed) continue;
              if (!isMujica(a)) continue;
              if (n > 0) {
                battle.addBuff(a, {
                  key: `${OBLVNS_KEY}:notes`, refresh: 'replace', tags: ['talent'], duration: 0.4,
                  mods: { defIgnorePct: penDef * n, resIgnorePct: penRes * n },
                });
              } else {
                battle.removeBuff(a, `${OBLVNS_KEY}:notes`);
              }
            }
          }, { owner: unit });
        } },
        { install(battle, unit) { // 毋畏遗忘: a damage instance feeds Fever; her range speeds her allies up
          if (feverStep > 0) {
            battle.on('damaged', (c) => {
              if (c.source !== unit) return;
              addFever(battle, feverStep);
            }, { owner: unit });
          }
          if (auraAspd > 0) {
            installAura(battle, unit, {
              key: `${OBLVNS_KEY}:tempo`, interval: 0.5,
              select: (a) => a.kind === 'op' && a !== unit,
              mods: { aspd: auraAspd },
            });
          }
        } },
      ],
      install(battle, unit) {
        // Every attack plays a note (持续攻击 + 音符): the note is the homing projectile, and its damage type follows the
        // current timbre (風琴/钢琴) — physical on 钢琴 (piercing), arts on 风琴.
        battle.on('attack', (c) => {
          if (c.attacker !== unit) return;
          const foe = (c.targets ?? [])[0];
          if (!foe) return;
          const m = unit.mem[`${OBLVNS_KEY}:s2`] ?? {};
          const piano = m.active ? !!m.piano : true;   // 钢琴 is the opening timbre
          const times = fever(battle) ? 2 : 1;         // 「Fever期间变为当前音色的二连击」
          for (let i = 0; i < times; i++) {
            note(battle, unit, foe, num(traitBb(chess).atk_scale, 1), piano ? 'phys' : 'arts', i * 8);
          }
          // S3 replaces the single note with four (two per timbre)
          if (unit.mem[`${OBLVNS_KEY}:s3`]) {
            const phys = pickFoe(battle, unit, 'highDef');
            const arts = pickFoe(battle, unit, 'highRes');
            for (let i = 0; i < S3_NOTES_PER_TIMBRE; i++) {
              if (phys) note(battle, unit, phys, s3Scale, 'phys', i * 10);
              if (arts) note(battle, unit, arts, s3Scale, 'arts', -i * 10);
            }
          }
        }, { owner: unit });
        // Fever's window: the members re-cast their skill while it lasts.
        battle.every(0.5, () => {
          if (!up(unit) || !fever(battle)) return;
          if (unit.skill && !unit.skill.active && unit.skill.ready) unit.skill.activate('fever', { free: true });
        }, { owner: unit });
      },
    };

    // -------------------------------------------------------------------------------------------------------------
    // helpers

    /** The 钢琴 / 风琴 timbre of S2 as a stat line (the notes read the same flag). */
    function syncTimbre(battle, unit) {
      const m = unit.mem[`${OBLVNS_KEY}:s2`];
      if (!m || !m.active) return;
      if (m.piano) {
        battle.removeBuff(unit, `${OBLVNS_KEY}:organ`);
        if (!unit.findBuff(`${OBLVNS_KEY}:piano`)) {
          battle.addBuff(unit, { key: `${OBLVNS_KEY}:piano`, mods: { atkPct: s2Atk }, refresh: 'keep', tags: ['skill'] });
        }
      } else {
        battle.removeBuff(unit, `${OBLVNS_KEY}:piano`);
        if (!unit.findBuff(`${OBLVNS_KEY}:organ`)) {
          battle.addBuff(unit, { key: `${OBLVNS_KEY}:organ`, mods: { aspd: s2Aspd }, refresh: 'keep', tags: ['skill'] });
        }
      }
    }

    /** Fever: a battle-wide counter her damage fills; at `FEVER_MAX` it opens a `FEVER_WINDOW` s window. */
    function addFever(battle, n) {
      const f = stateOf(battle).fever;
      if (battle.time < f.until) return;
      f.points += n;
      if (f.points >= FEVER_MAX) {
        f.points = 0;
        f.until = battle.time + FEVER_WINDOW;
        battle.fx('fever', { x: 0, y: 0, id: 0 });
      }
    }
    function fever(battle) {
      const f = stateOf(battle).fever;
      return battle.time < f.until;
    }

    /** Whether `a` is an 【Ave Mujica】 member (the bond the data gave her: `mujica`). */
    function isMujica(a) {
      const powers = a?.def?.raw?.powers ?? a?.def?.powers ?? [];
      return Array.isArray(powers) && powers.includes('mujica');
    }

    /** One 音符: a homing projectile dealing `scale` × ATK of `type`, counted while it flies. */
    function note(battle, unit, target, scale, type, angleDeg = 0) {
      void angleDeg;   // the spread is a visual property; the homing flight ignores it
      if (!target || !hasHp(target)) return;
      const m = unit.mem;
      m[`${OBLVNS_KEY}:notes`] = (m[`${OBLVNS_KEY}:notes`] ?? 0) + 1;
      battle.addProjectile({
        from: unit, target, speed: NOTE_SPEED, source: unit,
        onHit: (c) => {
          m[`${OBLVNS_KEY}:notes`] = Math.max(0, (m[`${OBLVNS_KEY}:notes`] ?? 1) - 1);
          const t = c?.target ?? target;
          if (!t || !hasHp(t)) return;
          battle.dealDamage(unit, t, {
            amount: unit.s.atk * scale, type, isSkill: true, tags: ['skill', 'oblvns:note'],
          });
        },
      });
      battle.after(NOTE_LIFE, () => {
        m[`${OBLVNS_KEY}:notes`] = Math.max(0, (m[`${OBLVNS_KEY}:notes`] ?? 1) - 1);
      }, { owner: unit });
    }

    /** The live enemies of her range, best target first (the profile's own order). */
    function liveFoes(battle, unit) {
      return battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true }).filter(hasHp);
    }

    /** The enemy of her range with the highest DEF or the highest RES (S3's two notes track one each). */
    function pickFoe(battle, unit, which) {
      const foes = liveFoes(battle, unit);
      if (!foes.length) return null;
      let best = foes[0];
      for (const e of foes) {
        const a = which === 'highRes' ? (e.s?.res ?? 0) : (e.s?.def ?? 0);
        const b = which === 'highRes' ? (best.s?.res ?? 0) : (best.s?.def ?? 0);
        if (a > b) best = e;
      }
      return best;
    }
  },
};
