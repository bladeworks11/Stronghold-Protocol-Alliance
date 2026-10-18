"""本机自用: export 丰川祥子's official effect prefabs into the game's own fx set (public/assets/local/fx + data/local-fx.json).

A `--fx-keys` style run: tools/local-extract/fx.py merges these prefabs into the existing index (set 'used') and file
list instead of replacing them, so the rest of the extracted effects stay as they are. Run it after a client update:

  .venv-extract/bin/python tools/local-extract/export-oblvns-fx.py [<AB root>]

`<AB root>` defaults to the usual Windows client install (extract.py CANDIDATES).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # <game>
sys.path.insert(0, str(ROOT / 'tools' / 'local-extract'))
import aklz4  # noqa: F401,E402  (registers the LZ4AK decoder)
import UnityPy  # noqa: E402
import fx  # noqa: E402

DEFAULT_AB = Path(r"E:\Hypergryph Launcher\games\Arknights\Arknights_Data\StreamingAssets\AB\Windows")
BUNDLE = Path('battle') / 'prefabs' / 'effects' / 'oblvns.ab'


def main():
    ab = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_AB
    bundle = ab / BUNDLE
    if not bundle.is_file():
        sys.exit(f'no {bundle} — pass the client\'s AB root (…/StreamingAssets/AB/Windows)')
    env = UnityPy.load(str(bundle))
    keys = sorted({k.split('/')[-1][:-len('.prefab')] for k in env.container.keys() if k.endswith('.prefab')})
    print(f'oblvns.ab: {len(keys)} prefabs')
    written = fx.export_fx(
        ab, ROOT / 'public' / 'assets' / 'local', ROOT / 'data' / 'local-assets.json', print,
        selection='keys', keys=keys, jobs=8, root=ROOT,
    )
    print(f'written {written} files')
    index = json.loads((ROOT / 'public/assets/local/fx/index.json').read_text(encoding='utf-8'))
    manifest = json.loads((ROOT / 'data/local-fx.json').read_text(encoding='utf-8'))
    mine = [k for k in (index.get('prefabs') or {}) if k.startswith('oblvns_')]
    print('index prefabs:', len(index.get('prefabs') or {}), 'of hers:', len(mine))
    print('manifest:', manifest.get('count'), 'files,', {g: len(v) for g, v in (manifest.get('groups') or {}).items()})


if __name__ == '__main__':
    main()
