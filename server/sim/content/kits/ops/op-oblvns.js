// server/sim/content/kits/ops/op-oblvns.js — 丰川祥子 (char_4182_oblvns) 自选 operator kit: 6★ 领主 (近卫), a 联动 operator
// of the tier-5 and tier-6 自选 slots; all three skills, both talents and the module at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// 本机自用：丰川祥子是上游因版权排除的 7 名联动干员之一（tools/build-data.mjs DIY_INCLUDED_COLLABS、NOTICE.md §2）。
// 仅供本机个人非商业使用；不要公开分发，也不要向上游提 PR。
//
// Sources: the official tables (character_table / skill_table / battle_equip_table, zh_CN) as built into
// data/backups.json — the skill texts and blackboards (S1's eight `atk_scale` shares, S2's `attack@atk` /
// `attack@attack_speed` / `attack@passby_delay`, S3's `attack@atk_scale`), both talents' blackboards (`delay` 1,
// `attack@angle` 20, `def_penetrate_ratio` / `magic_resist_penetrate_ratio`, `max_cnt`) and the module LOR-Y
// “无言的约定” (its trait `attack_speed` 12 and 特性追加 sentence, the talent change 0.05 / 0.025 / 12 and 技能期间远程攻击
// 不再降低攻击力) — plus PRTS 丰川祥子, whose 备注 are the only source for how a note MOVES (no table carries any of it).
//
// THE NOTES. 「丰川祥子可以持续攻击且攻击会演奏追踪敌人的音符，音符飘出攻击范围一段时间后消失」 (T1) is the whole kit:
// - 持续攻击 (ba.permanentatk 「无论攻击范围内是否有攻击目标，都会持续进行攻击」): every attack interval a note leaves
//   her tile even when nothing is in her range. That is what lets her hit enemies OUTSIDE her own attack range — the
//   note flies out, seeks the nearest targetable enemy within `seek` of ITSELF and homes onto it (PRTS 备注 音符的行动逻辑
//   自由移动 → 追踪移动; 「音符位于自身攻击范围外时，若连续1s以上不存在追踪目标则消失」 — the seconds are T1's `delay`).
// - The note IS her attack's damage: PRTS 「所有音符强制使用缓存攻击力与攻击倍率…未阻挡敌人时发射的音符视为远程攻击…
//   始终应用特性的80%倍率；阻挡敌人时发射的音符视为近战攻击」. The engine's own hit on the attacked target is therefore
//   cancelled (install below) — the attack itself (its 攻击回复 SP, 首次接敌, the client's clip and its shot) still
//   happens — and the note carries cached ATK × its share × the cached multiplier to wherever it lands.
// - Every note in the air feeds T1's penetration for the 【Ave Mujica】 members (「每存在一个音符」, capped by `max_cnt`;
//   the note that lands still counts — PRTS 备注 命中目标的当个音符可计入音符数量).
// - The movement parameters depend on the case of the shot — nothing in her range / a target / S1 / S2's two timbres /
//   S3 — exactly as the PRTS 备注 tables print them (NOTE below, one entry per case).
//
// [ASSUMED] The 自由移动 sway of the no-target / S2 / S3 cases is the official 扩张正弦方向 (its amplitude and its speed
// along the axis are known, the sine's PERIOD is in no source): implemented as a straight line at that speed.
// [ASSUMED] 「攻击范围内不存在敌人时，若自身朝向的前方一格地块的通行类型为无，持续攻击无法发射音符」 (PRTS 天赋 备注): read
// from battle.grid (`tile.pass === 'NONE'`).
// [ASSUMED] An empty (no-target) note still recovers 攻击回复 SP: the official 术语 says she is attacking (「都会持续进行
// 攻击」); no source states the SP side of an attack that hits nothing.
// [ASSUMED] S1's 「可充能2次，充能至最大层数时自动释放一次」 — the extra auto-cast at full charges — is NOT modelled (no
// engine rule covers it); the cast itself and its eight notes are exact.
// 官方特效 (本机自用): no official projectile or ability carries a note, so the kit's fx events NAME the official prefab
// they stand for (FX_TRAIL / FX_HIT for every note, FX_SKILL for the skill's cast, its timbre aura and S3's widened range
// — exported from the local client by tools/local-extract/export-oblvns-fx.py): the client's render/vfx/wiring.js kitFx
// spawns those at the note / her tile, moves and stops the loops with the skill. Without the extracted effects (or with
// 官方特效 off) the client draws the note with the procedural art instead (render/fx, the official textures baked into
// the particle atlas) and nothing for the skill effects.
//
// 领主 (近卫) trait 「可以进行远程攻击，但此时攻击力降低至80%」: the profession default (professions.js lord `dmgMul`; the
// kit applies it to the notes itself, since the note carries the damage).
// - T1 颂乐音符: at full potential `def_penetrate_ratio` 0.03 / `magic_resist_penetrate_ratio` 0.02 / `max_cnt` 10 (the
//   module's stage 3: 0.05 / 0.025 / 12). The penetration is a direct add on the damage of every 【Ave Mujica】 member
//   (PRTS 备注 无视防御与法抗的效果于每个Ave Mujica干员造成伤害时…临时增加…法术穿透与物理穿透（直接加算）).
// - T2 毋畏遗忘 「对敌人造成伤害时使Fever+cnt；其他Ave Mujica成员的攻击范围若与自身原本攻击范围重合，则将其视作攻击范围的
//   延伸；攻击范围内干员攻击速度+attack_speed」 (`enable` / `attack_speed` / `cnt`; at full potential 16 / 3). The FEVER
//   counter is hers (`ba.fever` termDescriptionDict: 「Fever累计至450点时，任意一位【Ave Mujica】成员手动触发技能后，在场
//   所有【Ave Mujica】成员20秒内会持续释放当前技能」 — her notes' damage instances fill it and the window re-casts her
//   skill); the range-extension clause is a placement rule the match owns [ASSUMED: not implemented here]; the attack
//   speed is an aura on the operators in her range (installAura).
//   The module's 特性追加 「初始攻击范围内存在2名及以上敌人时攻击速度+12」 is HER OWN attack speed (collision count, no
//   selectability: PRTS 模组 无言的约定 备注) — traitMods.js refuses that line for her (KIT_OWNED_CHARS), so the kit owns
//   it; the module's talent parts come through `chess`.
// - S1 新月的苏醒 (MANUAL, 攻击回复, 2 charges): 「演奏出8个音符。每个音符造成的法术伤害依次从攻击力的80%逐渐降低至4%」 —
//   eight arts notes, each at its own share of ATK, played as a fan (PRTS S1 备注 以自身朝向为基准，自左13.125°至右13.125°
//   顺时针均匀演奏音符，间隔3.75°) with S1's own parameters; they seek and home like every other note.
// - S2 满月的舞会 (MANUAL, 攻击回复, a toggle): 钢琴 (the opening timbre) = ATK +`attack@atk` and physical notes that pass
//   THROUGH the enemy they hit (「命中目标后穿过敌人造成物理伤害」; the 已命中 state of the PRTS 备注: an 0.8 radius collision
//   at 3.0 tiles/s for `attack@passby_delay` s); 风琴 = ASPD +`attack@attack_speed` and slower arts notes. 「Fever期间变为
//   当前音色的二连击」: in Fever the attack plays its note twice. The timbre is switched per cast (the mode has no manual
//   control, so the kit alternates them).
// - S3 残月的余响 (MANUAL, 攻击回复, 25 s): 「攻击范围扩大，攻击同时使用钢琴和风琴音色演奏，各自演奏2个造成相当于攻击力
//   attack@atk_scale物理和法术伤害的音符，且分别追踪法术抗性和防御力最高的敌人」 — the range becomes the skill's own 3-21
//   grid and every attack plays four notes: two physical at the highest-DEF enemy, two arts at the highest-RES one.
//   「Fever期间【Ave Mujica】成员受到致命伤害时不撤退，Fever结束后退场」 is a bond-wide death rule the match's 盟约 side
//   would own [ASSUMED: not implemented here].

import { num, talentBb, traitBb, skillRec, up, installAura, toggleBuff } from '../shared/tier1.js';
import { canTargetEnemy } from '../../../targeting.js';
import { frontOf, dirVec } from '../../../dir.js';
import { bodyDist, bodyInRange } from '../../../body.js';
import { hypot, sin, cos, roundHalfEven } from '../../../detmath.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_oblvns_1';
const S2 = 'skchr_oblvns_2';
const S3 = 'skchr_oblvns_3';
/** `ba.fever` (gamedata_const termDescriptionDict): the counter arming Fever, and the window it opens. */
const FEVER_MAX = 450;
const FEVER_WINDOW = 20;
/** S1: the notes it plays ["演奏出8个音符"], played as a fan (PRTS S1 备注: 左13.125° 至 右13.125°, 间隔3.75°). */
const S1_NOTES = 8;
const S1_SPREAD = 13.125;
/** S3's two timbres play two notes each ["各自演奏2个"]. */
const S3_NOTES_PER_TIMBRE = 2;
/**
 * The note parameter sets, one per case of the PRTS 备注 (no official table carries any of them): `upd` = the 更新间隔
 * (s) between two state updates, `minFree` = the 【自由移动】最短自由移动时间, `free` / `track` = the 自由移动 / 追踪移动
 * speeds (tiles/s), `seek` = the 追踪范围半径 (the note seeks the nearest targetable enemy within this of itself),
 * `turn` = the 转向速度 per frame (dir ← dir × (1 − turn) + target × turn; one battle tick is one frame), `passbyR` /
 * `passbySpeed` = the 已命中 state's collision radius and speed (S2 钢琴 only, 0 for the rest).
 */
const NOTE = Object.freeze({
  /** 攻击范围内不存在目标 (the 持续攻击 case). */
  free: Object.freeze({ upd: 0.4, minFree: 0.1, free: 1.3, seek: 1.0, track: 2.0, turn: 7 / 30, passbyR: 0, passbySpeed: 0 }),
  /** 存在目标 (her ordinary attack). */
  aimed: Object.freeze({ upd: 0.4, minFree: 0.1, free: 2.0, seek: 1.0, track: 2.0, turn: 1 / 6, passbyR: 0, passbySpeed: 0 }),
  s1: Object.freeze({ upd: 0.2, minFree: 0.6, free: 1.7, seek: 1.0, track: 2.2, turn: 1 / 6, passbyR: 0, passbySpeed: 0 }),
  piano: Object.freeze({ upd: 0.2, minFree: 0.4, free: 1.9, seek: 0.8, track: 3.5, turn: 1 / 2, passbyR: 0.8, passbySpeed: 3.0 }),
  organ: Object.freeze({ upd: 0.4, minFree: 0.4, free: 0.7, seek: 1.0, track: 1.0, turn: 1 / 12, passbyR: 0, passbySpeed: 0 }),
  s3: Object.freeze({ upd: 0.4, minFree: 0.8, free: 0.8, seek: 1.0, track: 1.3, turn: 1 / 4, passbyR: 0, passbySpeed: 0 }),
});
/**
 * How often a flying note's position is sent to the client as an `oblvnsNote` fx (its point, the previous one and its
 * heading). A note is a kit-managed probe — it seeks, retargets and passes through — so it is not in the snapshot's
 * projectile list; without these events the client has nothing to draw. The rate is the renderer's own (each event draws
 * a short trail whose life outlasts the gap: the road of 陈 S3's 龙剑气, op-chen3.js NOTE_FX_EVERY, archetype 'qi').
 */
const NOTE_FX_EVERY = 0.12;
/** Loop-cap: notes one unit may have in the air at once (her cadence and the vanish rules keep the real count far below). */
const NOTE_CAP = 64;
/** The team power of 【Ave Mujica】 in the data (`backups.json diy.operators[charId].powers`; PRTS 术语 Ave Mujica). */
const MUJICA_POWER = 'mujica';
/**
 * 本机自用: the OFFICIAL effect prefabs of her notes, from the local client extraction
 * `tools/local-extract/export-oblvns-fx.py` (the client's `battle/prefabs/effects/oblvns.ab`). A note is a kit-managed
 * probe, so no official projectile carries it: the kit names the prefab its `oblvnsNote` events should play (the client's
 * render/vfx/wiring.js spawns it at the note and moves it along) and falls back to the procedural note art when the
 * effects are not extracted or 官方特效 is off. [ASSUMED] which of the two S2 / S3 trails is which timbre — the client's
 * prefab names do not say (S1's eight are used in order, matching its eight notes).
 */
const FX_TRAIL = Object.freeze({
  attack: 'oblvns_attack_01_trail',
  s1: ['oblvns_skill_01_trail', 'oblvns_skill_01_trail_02', 'oblvns_skill_01_trail_03', 'oblvns_skill_01_trail_04',
    'oblvns_skill_01_trail_05', 'oblvns_skill_01_trail_06', 'oblvns_skill_01_trail_07', 'oblvns_skill_01_trail_08'],
  piano: 'oblvns_skill_02_trail',
  organ: 'oblvns_skill_02_trail_02',
  s3phys: 'oblvns_skill_03_trail',
  s3arts: 'oblvns_skill_03_trail_02',
});
const FX_HIT = Object.freeze({
  attack: 'oblvns_attack_01_hit',
  s1: 'oblvns_skill_01_hit',
  s2: 'oblvns_skill_02_hit',
  s3: 'oblvns_skill_03_hit',
});
/**
 * 本机自用: the official prefabs of her SKILLS — the cast, the range the widened skill draws and the timbre's own aura
 * (roles 'start' / 'range' / 'buff' of the extraction's index). `oblvnsSkill` events hand them to the client, which
 * spawns or stops them at her tile (render/vfx/wiring.js noteFx). [ASSUMED] the S2 timbre pairs (`start_a`/`buff` vs
 * `start_b`/`buff_01`) and S3's `range` / `buff` split: the prefab names do not say which is which.
 */
const FX_SKILL = Object.freeze({
  s1Start: 'oblvns_skill_01_start',
  s2Start: 'oblvns_skill_02_start',
  s2StartPiano: 'oblvns_skill_02_start_a',
  s2StartOrgan: 'oblvns_skill_02_start_b',
  s2BuffPiano: 'oblvns_skill_02_buff',
  s2BuffOrgan: 'oblvns_skill_02_buff_01',
  s3Start: 'oblvns_skill_03_start',
  s3Range: 'oblvns_skill_03_range',
  s3Buff: 'oblvns_skill_03_buff',
});
/** 模组 LOR-Y 「初始攻击范围内存在2名及以上敌人时攻击速度+12」: the count it needs, and the buff key. */
const MODULE_ASPD_NEED = 2;
const MODULE_ASPD_KEY = 'trait:oblvns:module';
/** The module stage that adds 「技能期间远程攻击不再降低攻击力」 (PRTS: the Y module's stage 2 and 3). */
const MODULE_SKILL_STAGE = 2;
const OBLVNS_KEY = 'oblvns';
const NOTE_TAG = 'oblvns:note';
const NOTE_FX = 'oblvnsNote';
/** What a note may fly to: any targetable enemy, air included (a 领主's canHitFly). */
const NOTE_PROFILE = Object.freeze({ canHitFly: true });
const EPS = 1e-9;

/**
 * Battle-wide state (the FEVER counter is the field's, not one unit's). Battle-level state lives in a module-level
 * WeakMap in this repo's kits (op-narant.js `STOLEN`, op-vvana.js `STOLEN`), since Battle itself keeps no `mem`. The
 * same record numbers the notes (their fx id, so the client can follow one note's flight and stop it).
 */
const STATE = new WeakMap();
const stateOf = (battle) => {
  let s = STATE.get(battle);
  if (!s) STATE.set(battle, (s = { fever: { points: 0, until: -Infinity }, noteSeq: 0 }));
  return s;
};

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};
/** The notes a unit has in the air (created on first use; the list lives in `unit.mem`, never across battles). */
const notesOf = (unit) => (unit.mem[`${OBLVNS_KEY}:notes`] ??= []);
/**
 * Rotate the (x = col, y = row) vector (x, y) by `deg`, clockwise on the screen (row 0 is the bottom row, so a positive
 * angle turns the way PRTS's 「顺时针」 reads). Only S1's fan and the ±`attack@angle` launch draw on it.
 */
function turnVec(x, y, deg) {
  const r = deg * Math.PI / 180, s = sin(r), c = cos(r);
  return [x * c - y * s, x * s + y * c];
}
/** The tile key a point stands on (the engine's tile rule for positions: round half to even, docs/SIM.md §2). */
const keyOfPoint = (x, y) => roundHalfEven(y) * COLS + roundHalfEven(x);

export default {
  char_4182_oblvns: (bb, chess) => {
    const t0 = talentBb(chess, 0);            // 颂乐音符: delay / attack@angle / def_penetrate_ratio / magic_resist_penetrate_ratio / max_cnt
    const t1 = talentBb(chess, 1);            // 毋畏遗忘: enable / attack_speed / cnt
    const tb = traitBb(chess);                // 领主 atk_scale · 模组 LOR-Y attack_speed
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const penDef = num(t0.def_penetrate_ratio);
    const penRes = num(t0.magic_resist_penetrate_ratio);
    const maxNotes = Math.max(1, Math.round(num(t0.max_cnt, 10)));
    /** The ±° of a note's random launch direction (T1 `attack@angle`; 未开启技能时 and both S2 timbres / S3 alike). */
    const launchAngle = num(t0['attack@angle'], 20);
    /** 音符位于自身攻击范围外时，若连续 `delay` s 以上不存在追踪目标则消失 (T1 `delay`). */
    const vanishDelay = Math.max(0, num(t0.delay, 1));
    /** 领主 「可以进行远程攻击，但此时攻击力降低至80%」 — the cached multiplier of a ranged note. */
    const rangedScale = num(tb.atk_scale, 0.8);
    /** 模组 LOR-Y: her own +12 while N enemies stand in her range (traitMods.js refuses the line for her). */
    const moduleAspd = num(tb.attack_speed);
    /** 模组 stage 2/3 「技能期间远程攻击不再降低攻击力」 (the 自选 forms carry stage 1 at tier 5, stage 3 at tier 6). */
    const moduleLevel = chess?.module && chess.module.active ? Math.round(num(chess.module.level, 0)) : 0;
    const noRangedPenaltyInSkill = moduleLevel >= MODULE_SKILL_STAGE;
    const feverStep = Math.max(0, Math.round(num(t1.cnt)));
    const auraAspd = num(t1.attack_speed);
    const s2Atk = num(b2['attack@atk']);
    const s2Aspd = num(b2['attack@attack_speed']);
    /** S2 钢琴's 已命中 state lasts `attack@passby_delay` s (0.5). */
    const passby = Math.max(0, num(b2['attack@passby_delay'], 0.5));
    const s3Scale = num(b3['attack@atk_scale'], 1.55);
    const s1Scales = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => num(b1[i === 0 ? 'atk_scale' : `atk_scale_${i + 1}`], 0));
    /** S3's 技能范围 (3-21): 「攻击范围扩大」. */
    const s3Grid = skillRec(chess, S3)?.rangeGrid ?? null;
    const isS2 = (unit) => unit.skill?.id === S2;
    const s3On = (unit) => !!unit.mem[`${OBLVNS_KEY}:s3`];
    /** Her attack interval, the cadence of both her attacks and her empty 持续攻击 notes. */
    const intervalOf = (unit) => Math.max(0.05, unit.s.interval);

    /**
     * 本机自用: hand one official skill effect to the client: `mode` 'once' spawns it at her tile, 'loop' spawns a loop
     * under the slot `tag` (a second loop replaces it) and 'stop' ends that slot's loop. See FX_SKILL.
     */
    function skillEffect(battle, unit, mode, key = null, tag = null) {
      battle.fx('oblvnsSkill', { x: unit.x, y: unit.y, id: unit.id, mode, key, tag });
    }

    return {
      skills: {
        // S1 新月的苏醒: eight arts notes, each a smaller share of ATK, played as a fan around her facing (PRTS S1 备注).
        [S1]: {
          kind: 'charges',
          onStart({ battle, unit }) {
            skillEffect(battle, unit, 'once', FX_SKILL.s1Start, 's1start');
            const step = (2 * S1_SPREAD) / (S1_NOTES - 1);
            for (let i = 0; i < S1_NOTES; i++) {
              const scale = s1Scales[i] ?? 0;
              if (!(scale > 0)) continue;
              play(battle, unit, {
                scale, type: 'arts', p: NOTE.s1, isSkill: true, angle: (i - (S1_NOTES - 1) / 2) * step,
                trail: FX_TRAIL.s1[i] ?? FX_TRAIL.s1[0], hit: FX_HIT.s1,
              });
            }
          },
        },
        // S2 满月的舞会: a timbre. 钢琴 = ATK & physical passing notes; 风琴 = ASPD & slower arts notes.
        [S2]: {
          kind: 'toggle',
          onStart({ battle, unit }) {
            const m = (unit.mem[`${OBLVNS_KEY}:s2`] = unit.mem[`${OBLVNS_KEY}:s2`] ?? { piano: true });
            m.piano = !m.piano;   // the toggle switches timbre on every cast (钢琴 is the opening one)
            m.active = true;
            syncTimbre(battle, unit);
            skillEffect(battle, unit, 'once', FX_SKILL.s2Start, 's2start');
            skillEffect(battle, unit, 'once', m.piano ? FX_SKILL.s2StartPiano : FX_SKILL.s2StartOrgan, 's2tone');
            skillEffect(battle, unit, 'loop', m.piano ? FX_SKILL.s2BuffPiano : FX_SKILL.s2BuffOrgan, 's2buff');
          },
          onEnd({ battle, unit }) {
            const m = unit.mem[`${OBLVNS_KEY}:s2`];
            if (m) m.active = false;
            battle.removeBuff(unit, `${OBLVNS_KEY}:piano`);
            battle.removeBuff(unit, `${OBLVNS_KEY}:organ`);
            skillEffect(battle, unit, 'stop', null, 's2buff');
          },
          onTick({ battle, unit }) { syncTimbre(battle, unit); },
        },
        // S3 残月的余响: the range widens (3-21) and every attack plays four notes (two physical, two arts).
        [S3]: {
          kind: 'duration',
          duration: Math.max(1, num(skillRec(chess, S3)?.duration, 25)),
          targeting: s3Grid ? { rangeGrid: s3Grid } : null,
          onStart({ battle, unit }) {
            unit.mem[`${OBLVNS_KEY}:s3`] = true;
            skillEffect(battle, unit, 'once', FX_SKILL.s3Start, 's3start');
            skillEffect(battle, unit, 'loop', FX_SKILL.s3Range, 's3range');
            skillEffect(battle, unit, 'loop', FX_SKILL.s3Buff, 's3buff');
          },
          onEnd({ battle, unit }) {
            unit.mem[`${OBLVNS_KEY}:s3`] = null;
            skillEffect(battle, unit, 'stop', null, 's3range');
            skillEffect(battle, unit, 'stop', null, 's3buff');
          },
        },
      },
      talents: [
        { install(battle, unit) { // 颂乐音符: the notes give the bond's members penetration while they are in the air
          if (!(penDef > 0 || penRes > 0)) return;
          battle.every(0.25, () => {
            if (!up(unit)) return;
            const n = Math.min(maxNotes, notesOf(unit).length);
            for (const a of battle.alliesFor(unit)) {
              if (!a.alive || !a.deployed) continue;
              if (!isMujica(battle, a)) continue;
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
        { install(battle, unit) { // 模组 LOR-Y: 初始攻击范围内存在2名及以上敌人时攻击速度+12 (her own — see the header)
          if (!(moduleAspd > 0)) return;
          // The official check is 碰撞判定，无视可选性影响, every 0.2 s (PRTS 模组 无言的约定 备注): every body inside her
          // range counts whoever it is (隐匿 / 不可选中 included), and the stat is on exactly while the count holds.
          toggleBuff(battle, unit, MODULE_ASPD_KEY, () => {
            if (!unit.rangeKeySet) return false;
            let n = 0;
            for (const e of battle.enemies) {
              if (!e.alive || e.removed || !e.deployed) continue;
              if (bodyInRange(e, unit.rangeKeySet) && ++n >= MODULE_ASPD_NEED) return true;
            }
            return false;
          }, { aspd: moduleAspd });
        } },
      ],
      install(battle, unit) {
        // The note IS her attack's damage: cancel the engine's own hit on the attacked target (the attack itself — its
        // 攻击回复 SP, 首次接敌, the client's clip and its shot — still happens). Her notes carry this tag and pass here.
        battle.on('hit', (ctx) => {
          const d = ctx.dmg;
          if (ctx.source !== unit || !d || d.cancel || !d.isAttack) return;
          if (Array.isArray(d.tags) && d.tags.includes(NOTE_TAG)) return;
          d.cancel = true;
        }, { owner: unit, priority: 1000 });
        // Every attack plays a note at the enemy it picked; S3 plays its four instead (two per timbre).
        battle.on('attack', (c) => {
          if (c.attacker !== unit) return;
          const foe = (c.targets ?? [])[0];
          if (!foe) return;
          unit.mem[`${OBLVNS_KEY}:cd`] = intervalOf(unit);   // 持续攻击: this attack owns the interval
          if (s3On(unit)) {
            const def = pickFoe(battle, unit, 'highDef'), res = pickFoe(battle, unit, 'highRes');
            for (let i = 0; i < S3_NOTES_PER_TIMBRE; i++) {
              if (def) play(battle, unit, { scale: s3Scale, type: 'phys', p: NOTE.s3, aim: def, isSkill: true, trail: FX_TRAIL.s3phys, hit: FX_HIT.s3 });
              if (res) play(battle, unit, { scale: s3Scale, type: 'arts', p: NOTE.s3, aim: res, isSkill: true, trail: FX_TRAIL.s3arts, hit: FX_HIT.s3 });
            }
            return;
          }
          const m = unit.mem[`${OBLVNS_KEY}:s2`];
          const organ = isS2(unit) && !!m && m.active && !m.piano;
          const set = isS2(unit) ? (organ ? NOTE.organ : NOTE.piano) : NOTE.aimed;
          const times = isS2(unit) && fever(battle) ? 2 : 1;   // 「Fever期间变为当前音色的二连击」
          for (let i = 0; i < times; i++) {
            play(battle, unit, {
              scale: 1, type: organ ? 'arts' : 'phys', p: set, aim: foe, passby: organ ? 0 : passby,
              trail: isS2(unit) ? (organ ? FX_TRAIL.organ : FX_TRAIL.piano) : FX_TRAIL.attack,
              hit: isS2(unit) ? FX_HIT.s2 : FX_HIT.attack,
            });
          }
        }, { owner: unit });
        // 持续攻击: her attack interval ticks whether or not anything stands in her range; with nothing there the note
        // leaves with no tracking target at all and finds its own enemy out there (PRTS 天赋 备注).
        battle.on('tick', ({ dt }) => {
          if (!up(unit) || !unit.canAct || unit.s.flags.disarm) return;   // 晕眩 / 冻结 / 缴械 hold it, as her attack
          const cd = Math.max(0, num(unit.mem[`${OBLVNS_KEY}:cd`], 0) - dt);
          unit.mem[`${OBLVNS_KEY}:cd`] = cd;
          if (cd > EPS) return;
          unit.mem[`${OBLVNS_KEY}:cd`] = intervalOf(unit);
          if (enemyInRange(battle, unit)) return;      // the attack loop makes this attack (and plays its note)
          const [fr, fc] = frontOf(unit.tileR, unit.tileC, unit.dir);
          const ahead = battle.grid.inRect(fr, fc) ? battle.grid.tile(fr, fc) : null;
          if (ahead && ahead.pass === 'NONE') return;  // 「前方一格地块的通行类型为无…无法发射音符」
          play(battle, unit, { scale: 1, type: 'phys', p: NOTE.free, trail: FX_TRAIL.attack, hit: FX_HIT.attack });
          // [ASSUMED] the empty attack is still an attack for 攻击回复 SP (see the header).
          if (unit.skill && unit.skill.spType === 'attack' && !(unit.skill.active && unit.skill.isTimed)) unit.skill.gainSp(1, 'attack');
        }, { owner: unit });
        // The notes themselves: free flight, seeking, homing, and the two ways a note ends.
        battle.on('tick', ({ dt }) => stepNotes(battle, unit, dt), { owner: unit });
        // 自身退场时，清除所有不处于【追踪移动】状态的音符 (PRTS 天赋 备注).
        battle.on('death', (c) => { if (c.unit === unit) clearNotes(battle, unit); }, { owner: unit });
        // A deployment starts her attack interval (as the engine's own atkCd does), so the first empty note waits.
        battle.on('deploy', (c) => { if (c.unit === unit) unit.mem[`${OBLVNS_KEY}:cd`] = intervalOf(unit); }, { owner: unit });
        // Fever's window: the members re-cast their skill while it lasts (the match's 盟约 side opens it; her damage
        // is what fills the counter).
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

    /**
     * Whether `a` belongs to 【Ave Mujica】 (PRTS 术语 Ave Mujica 「包括丰川祥子、八幡海铃、三角初华、祐天寺若麦、若叶睦」).
     * A 自选 piece's composed record carries no `powers` at all (shared/standIn.js composeUnitRecord has no such field,
     * and shared/diy.js diyRecordOf passes only the bonds), so the data's own team list — backups.json
     * `diy.operators[charId].powers` — is the fallback that makes the check work for the picks this kit can meet.
     */
    function isMujica(battle, a) {
      if (!a) return false;
      const own = a.def?.raw?.powers ?? a.def?.powers;
      if (Array.isArray(own) && own.includes(MUJICA_POWER)) return true;
      const id = a.def?.charId;
      if (!id) return false;
      const powers = battle.data?.rawBackups?.()?.diy?.operators?.[id]?.powers;
      return Array.isArray(powers) && powers.includes(MUJICA_POWER);
    }

    /** The cached multiplier of a note played now: 近战 while she blocks an enemy, else the 领主 ranged scale (0.8). */
    function noteMul(unit) {
      if (unit.blocking && unit.blocking.length) return 1;
      const inSkill = !!(unit.skill && unit.skill.active && unit.skill.isTimed);
      return inSkill && noRangedPenaltyInSkill ? 1 : rangedScale;
    }

    /** Whether an enemy is a target a note may fly to (dead / hidden / 隐匿 / untargetable / air rules). */
    function validFoe(unit, e) { return !!e && canTargetEnemy(unit, e, NOTE_PROFILE); }

    /** The nearest targetable enemy within `r` of (x, y) (body distance; ties by spawn order), or null. */
    function seekFoe(battle, unit, x, y, r) {
      let best = null, bd = Infinity;
      for (const e of battle.enemies) {
        if (!validFoe(unit, e)) continue;
        const d = bodyDist(e, x, y);
        if (d > r + EPS) continue;
        if (d < bd - EPS || (Math.abs(d - bd) <= EPS && best && e.spawnSeq < best.spawnSeq)) { bd = d; best = e; }
      }
      return best;
    }

    /** Whether (x, y) lies in her own attack range (by the tile the point stands on; a running skill's range counts). */
    function inOwnRange(unit, x, y) { return !!unit.rangeKeySet && unit.rangeKeySet.has(keyOfPoint(x, y)); }

    /**
     * Play one 音符 (the kit's whole mechanic). `scale` = its share of her ATK, `type` its damage type, `p` its
     * parameter set, `aim` the enemy her attack picked (a note without one starts with no tracking target), `angle` its
     * launch direction in degrees off her facing (S1's fan; otherwise a random ±`launchAngle`), `passby` the seconds of
     * S2 钢琴's 已命中 state (0 = the note is gone once it lands), `isSkill` whether a skill played it, `trail` / `hit`
     * the OFFICIAL prefabs its fx events name (see FX_TRAIL / FX_HIT; null = the procedural note art only).
     */
    function play(battle, unit, { scale, type, p, aim = null, angle = null, isSkill = false, passby: pass = 0, trail = null, hit = null }) {
      const list = notesOf(unit);
      if (list.length >= NOTE_CAP) dropNote(battle, unit, list, 0);   // loop-cap: NOTE_CAP
      const deg = angle == null ? battle.rng.range(-launchAngle, launchAngle) : angle;
      const [fr, fc] = dirVec(unit.dir);
      const [dx, dy] = turnVec(fc, fr, deg);       // (x = col, y = row)
      const n = {
        id: (stateOf(battle).noteSeq += 1), trail, hit,
        x: unit.x, y: unit.y, dx, dy,
        p, scale, type, isSkill, passby: pass, hits: null,
        atk: unit.s.atk, mul: noteMul(unit),       // 缓存攻击力与攻击倍率 (PRTS 天赋 备注)
        state: 'free', tgt: validFoe(unit, aim) ? aim : null,
        freeAt: battle.time, updAt: battle.time + p.upd, outAt: -1,
        fxAt: -Infinity, fxX: unit.x, fxY: unit.y,
        seq: unit.deploySeq,
      };
      list.push(n);
      return n;
    }

    /** Drop the note at `list[i]`, telling the client its flight is over (its official trail prefab stops there). */
    function dropNote(battle, unit, list, i) {
      const n = list[i];
      if (!n) return null;
      list.splice(i, 1);
      battle.fx('oblvnsNoteEnd', { x: n.x, y: n.y, id: unit.id, note: n.id });
      return n;
    }

    /** One note's damage on arrival (cached ATK × its share × the cached multiplier; her attack, so `isAttack`). */
    function hitNote(battle, unit, n, e) {
      if (n.hit) battle.fx('oblvnsNoteHit', { x: e.x, y: e.y, id: unit.id, note: n.id, hit: n.hit });
      battle.dealDamage(unit, e, {
        amount: n.atk * n.scale * n.mul, type: n.type, isAttack: true, isSkill: n.isSkill,
        tags: n.isSkill ? [NOTE_TAG, 'skill'] : [NOTE_TAG],
      });
    }

    /** Advance every note of `unit` by `dt` (the state machine of the PRTS 天赋 备注). */
    function stepNotes(battle, unit, dt) {
      const list = unit.mem[`${OBLVNS_KEY}:notes`];
      if (!list || !list.length) return;
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        // her retreat cleared the free ones; a note in 【追踪移动】 keeps flying to its target, and one of a former
        // deployment that is not in it is dropped here (PRTS: 清除所有不处于【追踪移动】状态的音符).
        if (n.seq !== unit.deploySeq && n.state !== 'track') { dropNote(battle, unit, list, i); continue; }
        const p = n.p;
        if (n.state === 'hit') {   // 已命中 (S2 钢琴): on at passbySpeed, colliding with everything within passbyR
          n.x += n.dx * p.passbySpeed * dt;
          n.y += n.dy * p.passbySpeed * dt;
          if (battle.time - n.hitAt >= n.passby - EPS) { dropNote(battle, unit, list, i); continue; }
          for (const e of battle.enemies) {
            if (!validFoe(unit, e) || n.hits.has(e.id)) continue;
            if (bodyDist(e, n.x, n.y) <= p.passbyR + EPS) { n.hits.add(e.id); hitNote(battle, unit, n, e); }
          }
        } else if (n.state === 'track') {
          const t = n.tgt;
          if (!validFoe(unit, t)) {   // 目标丢失: 以当前运动方向重新进入【自由移动】
            n.state = 'free'; n.tgt = null; n.freeAt = battle.time; n.updAt = battle.time + p.upd;
          } else {
            const ddx = t.x - n.x, ddy = t.y - n.y, d = hypot(ddx, ddy);
            if (d > EPS) {   // 转向速度: dir ← dir × (1 − turn) + target × turn (one frame per tick)
              const nx = n.dx * (1 - p.turn) + (ddx / d) * p.turn, ny = n.dy * (1 - p.turn) + (ddy / d) * p.turn;
              const m = hypot(nx, ny);
              if (m > EPS) { n.dx = nx / m; n.dy = ny / m; }
            }
            const step = p.track * dt;
            if (bodyDist(t, n.x, n.y) <= step + EPS) {   // arrived
              hitNote(battle, unit, n, t);
              if (n.passby > 0) { n.state = 'hit'; n.hitAt = battle.time; n.hits = new Set([t.id]); }
              else { dropNote(battle, unit, list, i); continue; }
            } else {
              n.x += n.dx * step;
              n.y += n.dy * step;
            }
          }
        } else {   // free
          const step = p.free * dt;
          n.x += n.dx * step;
          n.y += n.dy * step;
          if (battle.time >= n.updAt - EPS) {   // 每隔一段时间按照规则尝试更新行动状态
            n.updAt = battle.time + p.upd;
            if (!n.tgt) n.tgt = seekFoe(battle, unit, n.x, n.y, p.seek);
            if (n.tgt && battle.time - n.freeAt >= p.minFree - EPS && validFoe(unit, n.tgt)) n.state = 'track';
          }
          // 音符位于自身攻击范围外时，若连续 vanishDelay s 以上不存在追踪目标则消失
          if (!n.tgt && !inOwnRange(unit, n.x, n.y)) {
            if (n.outAt < 0) n.outAt = battle.time;
            else if (battle.time - n.outAt >= vanishDelay - EPS) { dropNote(battle, unit, list, i); continue; }
          } else n.outAt = -1;
        }
        emitNoteFx(battle, unit, n);
      }
    }

    /**
     * Tell the client where a flying note is (see NOTE_FX_EVERY): `note` its id (one flight), `trail` the official prefab
     * to play along it (null: the procedural note art) and `tone` which art — 钢琴's is physical, 风琴's arts.
     */
    function emitNoteFx(battle, unit, n) {
      if (battle.time - n.fxAt < NOTE_FX_EVERY - EPS) return;
      n.fxAt = battle.time;
      battle.fx(NOTE_FX, {
        x: n.x, y: n.y, fromX: n.fxX, fromY: n.fxY, dr: n.dy, dc: n.dx, id: unit.id,
        note: n.id, trail: n.trail, tone: n.type,
      });
      n.fxX = n.x; n.fxY = n.y;
    }

    /** Drop the notes of `unit` that are not in 【追踪移动】 (PRTS 天赋 备注 自身退场时…), ending their fx. */
    function clearNotes(battle, unit) {
      const list = unit.mem[`${OBLVNS_KEY}:notes`];
      if (!list) return;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].state !== 'track') dropNote(battle, unit, list, i);
    }

    /** Any targetable enemy in her current range (the 持续攻击 check: with one there her attack loop plays the note). */
    function enemyInRange(battle, unit) { return battle.enemiesInKeys(unit.rangeKeys, unit, NOTE_PROFILE).length > 0; }

    /** The targetable enemy of her range with the highest DEF or the highest RES (S3's two notes track one each). */
    function pickFoe(battle, unit, which) {
      let best = null;
      for (const e of battle.enemiesInKeys(unit.rangeKeys, unit, NOTE_PROFILE)) {
        if (!validFoe(unit, e)) continue;
        if (!best) { best = e; continue; }
        const a = which === 'highRes' ? (e.s?.res ?? 0) : (e.s?.def ?? 0);
        const b = which === 'highRes' ? (best.s?.res ?? 0) : (best.s?.def ?? 0);
        if (a > b) best = e;
      }
      return best;
    }
  },
};
