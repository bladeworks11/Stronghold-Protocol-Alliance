#!/usr/bin/env python3
"""Extract the official 时装 (skins) of a local Arknights client into a cosmetic plugin.

The engine keeps skins out of the base manifest (docs/SKINS.md): a skin is an overlay entry
`chars[<charId>].skins[<skinId>] = { name, group, avatar, portrait, spine: { front, back? } }` that a
cosmetic plugin serves. This script builds that plugin from the client's own AssetBundles:

  spritepack/ui_char_avatar_*.ab    the skin's avatar        (sprite name = skin avatarId)
  spritepack/char_portrait_*.ab     the skin's portrait      (sprite name = skin portraitId)
  skinpack/<charId>.ab              the skin's battle Spine   (prefab `<battleSkin.skinOrPrefabId>.prefab`)

The skin list, names and groups come from the official skin table (`.cache/gamedata/excel/skin_table.json`,
tools/fetch-assets sources). Only skins of operators the installation's `data/assets.json` has are exported.

Usage:
  python tools/local-extract/skins.py --ab "<client>/Arknights_Data/StreamingAssets/AB/Windows" \
      --out plugins/skin-pack [--limit N] [--chars char_003_kalts,...] [--no-images] [--quiet]

The output is a plugin folder ready for `node tools/plugin.mjs pack` (the Spine models need its
plugin.lock.json) and `node tools/plugin.mjs check`.

Game art is (c) Hypergryph / Yostar: the plugin it writes is for personal, non-commercial use and is
NOT committed to the repository (plugins/ is ignored by git apart from its readme and templates).
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aklz4  # noqa: F401  (registers the LZ4AK decoder for Arknights bundles)
import extract as ex  # noqa: F401  (write_spine, prefab_spine_nodes, safe_name, atlas helpers)

ROOT = Path(__file__).resolve().parents[2]
SKINS_ROOT = "files/assets/skins"
# The faces docs/SKINS.md names; a prefab's other renderers (a building model, a token) are not the skin's body.
FACES = ("front", "back")
# A skin whose battle prefab is the default one adds nothing: the operator's own model is that.
DEFAULT_BATTLE = (None, "", "DefaultSkin")


def log_quiet(*_a):
    pass


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def wanted_skins(skin_table, chars, only=()):
    """[(skinId, charId, avatarId, portraitId, battleId, name, group)] of the operators `chars` has."""
    out = []
    for rec in skin_table.get("charSkins", {}).values():
        char_id = rec.get("charId")
        if char_id not in chars:
            continue
        if only and char_id not in only:
            continue
        battle = (rec.get("battleSkin") or {}).get("skinOrPrefabId")
        if battle in DEFAULT_BATTLE:
            continue  # the operator's own body: the manifest already draws it
        display = rec.get("displaySkin") or {}
        name = display.get("skinName") or rec.get("skinId")
        group = display.get("skinGroupName") or ""
        out.append({
            "skinId": rec.get("skinId"),
            "charId": char_id,
            "avatarId": rec.get("avatarId"),
            "portraitId": rec.get("portraitId"),
            "battleId": battle,
            "name": name,
            "group": group,
        })
    return out


def sprite_scan(ab_root, patterns, names, out_dir, log, quality=90):
    """Save the sprite of every wanted name found in `patterns` as `out_dir/<stem>.webp`; {name: rel path}."""
    import UnityPy
    wanted = dict(names)  # sprite name -> (stem, rel dir)
    saved = {}
    for pattern in patterns:
        for bundle in sorted(Path(ab_root).glob(pattern)):
            if not wanted:
                break
            try:
                env = UnityPy.load(str(bundle))
            except Exception as err:  # a corrupt bundle must not stop the run
                log(f"  warn {bundle.name}: {err}")
                continue
            for obj in env.objects:
                if obj.type.name != "Sprite":
                    continue
                try:
                    sprite = obj.read()
                    name = getattr(sprite, "m_Name", "")
                    if name not in wanted:
                        continue
                    stem, rel = wanted.pop(name)
                    target = Path(out_dir) / rel / f"{stem}.webp"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    image = sprite.image
                    image.save(target, "WEBP", quality=quality, method=4)
                    saved[name] = f"{rel}/{stem}.webp"
                    log(f"  {name} -> {rel}/{stem}.webp ({image.width}x{image.height})")
                except Exception as err:
                    log(f"  warn {bundle.name} sprite: {err}")
    for name in sorted(wanted):
        log(f"  skip (sprite not found) {name}")
    return saved


def extract_models(ab_root, targets, out_root, manifest, log):
    """Write every target's battle Spine; fills `manifest[group]` (paths rewritten to plugin-relative)."""
    import UnityPy
    by_char = {}
    for t in targets:
        by_char.setdefault(t["charId"], []).append(t)
    for char_id, list_ in sorted(by_char.items()):
        bundles = [p for p in (Path(ab_root) / "skinpack" / f"{char_id}.ab", Path(ab_root) / "charpack" / f"{char_id}.ab") if p.is_file()]
        if not bundles:
            log(f"  skip (no bundle) {char_id}")
            continue
        env = objects = container = None
        for bundle in bundles:
            try:
                env = UnityPy.load(str(bundle))
            except Exception as err:
                log(f"  FAIL load {bundle.name}: {err}")
                continue
            objects = {o.path_id: o for o in env.objects}
            container = getattr(env, "container", {}) or {}
            if any(str(k).lower().rsplit("/", 1)[-1] == f"{t['battleId']}.prefab".lower() for k in container for t in list_):
                break
        if env is None:
            continue
        for t in list_:
            # 容器键与资产名可能被客户端小写化（char_202_demkni_ambiencesynesthesia#7）：按小写比对
            want = f"/{t['battleId']}.prefab".lower()
            key = next((k for k in container if str(k).lower().endswith(want)), None)
            if key is None:
                log(f"  skip (no prefab) {char_id} {t['battleId']}")
                continue
            ref = container[key]
            try:
                nodes = ex.prefab_spine_nodes(ref.read_typetree(), objects)
            except Exception as err:
                log(f"  warn {char_id} {t['battleId']}: {err}")
                continue
            stem = ex.safe_name(t["skinId"])
            faces = {}
            for node_name, _active, pptr in nodes:
                face = str(node_name).lower()
                if face not in FACES or face in faces:
                    continue
                if not pptr or pptr.get("m_FileID"):
                    continue
                sda = objects.get(pptr.get("m_PathID"))
                if sda is None:
                    continue
                group = f"{SKINS_ROOT}/{stem}/{face}"
                n = ex.write_spine(objects, sda.read_typetree(), group, t["battleId"], out_root, manifest, log)
                if n:
                    faces[face] = group
            if not faces:
                log(f"  skip (no model) {char_id} {t['battleId']}")
                continue
            t["groups"] = faces
            # the skin's own artwork: the bundle's big sprite named after the battle prefab (`<id>b` is its crop)
            try:
                want = {t["battleId"], t["battleId"] + "b"}
                best = None
                for obj in env.objects:
                    if obj.type.name != "Sprite":
                        continue
                    sp = obj.read()
                    if getattr(sp, "m_Name", "") not in want:
                        continue
                    img = sp.image
                    if best is None or img.width * img.height > best.width * best.height:
                        best = img
                if best is not None:
                    if best.width > 1280:
                        best = best.resize((1280, round(best.height * 1280 / best.width)))
                    rel = f"{SKINS_ROOT}/{stem}/illust.webp"
                    target = Path(out_root) / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    best.save(target, "WEBP", quality=85, method=4)
                    t["illust"] = rel
            except Exception as err:
                log(f"  warn {char_id} illust: {err}")
            log(f"  model {char_id} {t['skinId']}: {', '.join(faces)}")


def fix_group(out_root, group):
    """Rename atlas pages the URL cannot carry (`#`, `@`, spaces) and point the atlas text at the new names.

    A skin's atlas names its page after the skin (`char_181_flower_daily#1.png`); `#` ends a URL, so the page and
    every line naming it become `safe_name(page)`. Returns the group's files as {name: path} for the manifest.
    """
    out_dir = Path(out_root) / group
    if not out_dir.is_dir():
        return {}
    page_re = re.compile(r"(?m)^([^\s:]+\.png)$")
    atlases = sorted(out_dir.glob("*.atlas"))
    for atlas in atlases:
        text = atlas.read_text(encoding="utf-8")
        renamed = {}

        def repl(m):
            old = m.group(1)
            new = old if ex.safe_name(old) == old else ex.safe_name(old)
            if new != old:
                renamed[old] = new
            return new

        text = page_re.sub(repl, text)
        for old, new in renamed.items():
            src = out_dir / old
            if src.is_file():
                src.replace(out_dir / new)
        if renamed:
            atlas.write_text(text, encoding="utf-8", newline="\n")
    return {f.name: {"path": f"{group}/{f.name}"} for f in sorted(out_dir.iterdir()) if f.is_file()}


def spine_ref(manifest, group):
    files = manifest.get(group) or {}
    skel = next((k for k in files if k.endswith(".skel")), None)
    if not skel:
        return None
    atlas = skel[:-5] + ".atlas"
    if atlas not in files:
        return None
    textures = [files[k]["path"] for k in sorted(files) if k.endswith(".png")]
    return {"skel": files[skel]["path"], "atlas": files[atlas]["path"], "textures": textures}


def main():
    ap = argparse.ArgumentParser(description="extract official skins into a cosmetic plugin folder")
    ap.add_argument("--ab", required=True, help="<client>/Arknights_Data/StreamingAssets/AB/Windows")
    ap.add_argument("--out", required=True, help="the plugin folder to write (e.g. plugins/skin-pack)")
    ap.add_argument("--skin-table", default=str(ROOT / ".cache" / "gamedata" / "excel" / "skin_table.json"))
    ap.add_argument("--data", default=str(ROOT / "data" / "assets.json"), help="the installation's manifest")
    ap.add_argument("--limit", type=int, default=0, help="only the first N operators (a trial run)")
    ap.add_argument("--chars", default="", help="comma-separated charIds to restrict to")
    ap.add_argument("--no-images", action="store_true", help="skip avatars and portraits")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    log = log_quiet if args.quiet else print

    ab_root = Path(args.ab)
    out_root = Path(args.out)
    if not (ab_root / "skinpack").is_dir():
        sys.exit(f"not a client AB folder: {ab_root}")
    table = load_json(args.skin_table)
    manifest = load_json(args.data)
    chars = set(manifest.get("chars", {}))
    only = {c.strip() for c in args.chars.split(",") if c.strip()}
    targets = wanted_skins(table, chars, only)
    if args.limit:
        keep = list(dict.fromkeys(t["charId"] for t in targets))[: args.limit]
        targets = [t for t in targets if t["charId"] in keep]
    if not targets:
        sys.exit("no skins to export (check --skin-table and --chars)")
    log(f"[skins] {len(targets)} skins over {len(set(t['charId'] for t in targets))} operators")

    avatars, portraits = {}, {}
    if not args.no_images:
        log("[skins] avatars")
        wanted = {t["avatarId"]: ("avatar", f"{SKINS_ROOT}/{ex.safe_name(t['skinId'])}")
                  for t in targets if t.get("avatarId")}
        avatars = sprite_scan(ab_root, ["spritepack/ui_char_avatar_*.ab"], wanted, out_root, log)
        log("[skins] portraits")
        wanted = {t["portraitId"]: ("portrait", f"{SKINS_ROOT}/{ex.safe_name(t['skinId'])}")
                  for t in targets if t.get("portraitId")}
        portraits = sprite_scan(ab_root, ["spritepack/char_portrait_*.ab"], wanted, out_root, log)

    log("[skins] battle models")
    extract_models(ab_root, targets, out_root, {}, log)
    files = {}
    for group in sorted({g for t in targets for g in (t.get("groups") or {}).values()}):
        files[group] = fix_group(out_root, group)

    chars_out = {}
    made = 0
    for t in targets:
        groups = t.get("groups") or {}
        skins = chars_out.setdefault(t["charId"], {}).setdefault("skins", {})
        entry = {"name": t["name"]}
        if t.get("group"):
            entry["group"] = t["group"]
        if t.get("avatarId") in avatars:
            entry["avatar"] = avatars[t["avatarId"]]
        if t.get("portraitId") in portraits:
            entry["portrait"] = portraits[t["portraitId"]]
        if t.get("illust"):
            entry["illust"] = t["illust"]
        spine = {}
        for face, group in groups.items():
            ref = spine_ref(files, group)
            if ref:
                spine[face] = ref
        if spine:
            entry["spine"] = spine
        if len(entry) <= 1 and not spine:
            continue  # nothing of this skin is in the client
        skins[t["skinId"]] = entry
        made += 1

    # drop the operators nothing was found for
    chars_out = {c: v for c, v in chars_out.items() if v.get("skins")}
    assets = {"chars": chars_out}
    (out_root / "files").mkdir(parents=True, exist_ok=True)
    with open(out_root / "assets.json", "w", encoding="utf-8", newline="\n") as fh:
        json.dump(assets, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    plugin = {
        "$schema": "../../schemas/plugin.schema.json",
        "manifest": 2,
        "id": out_root.name,
        "name": {"zh": "官方时装皮肤包", "en": "Official outfit skins"},
        "version": "1.0.0",
        "app": ">=0.3.0 <0.4.0",
        "api": 1,
        "sourceLang": "zh",
        "class": "cosmetic",
        "scope": ["room", "personal"],
        "permissions": ["assets.override"],
        "assets": "assets.json",
        "description": {
            "zh": f"从本机官方客户端提取的 {made} 套时装（{len(chars_out)} 名干员）：头像、立绘与战斗模型。"
                  "只改外观，不改任何战斗数值；素材版权属鹰角网络 / Yostar，仅个人非商业使用。",
            "en": f"{made} official outfits of {len(chars_out)} operators extracted from a local client: avatars, "
                  "portraits and battle models. Appearance only; art (c) Hypergryph / Yostar, personal non-commercial use.",
        },
        "authors": ["local extraction (tools/local-extract/skins.py)"],
        "license": "代码 GPL-3.0-or-later；时装美术 © Hypergryph / Yostar，仅个人非商业使用",
    }
    with open(out_root / "plugin.json", "w", encoding="utf-8", newline="\n") as fh:
        json.dump(plugin, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    log(f"[skins] plugin written: {out_root} · {made} skins, {len(chars_out)} operators")
    log("[skins] next: node tools/plugin.mjs pack <dir>  (writes plugin.lock.json), then check")


if __name__ == "__main__":
    main()
