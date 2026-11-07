#!/usr/bin/env python3
"""Pack plugin/ into dist/<id>-<version>.zip (the layout Grafana expects: <id>/plugin.json, ...)."""
import json
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
src = root / "plugin"
meta = json.loads((src / "plugin.json").read_text())
pid, ver = meta["id"], meta["info"]["version"]
dist = root / "dist"
dist.mkdir(exist_ok=True)
for old in dist.glob(f"{pid}-*.zip"):
    old.unlink()
out = dist / f"{pid}-{ver}.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(src.rglob("*")):
        if f.is_file() and not f.name.startswith("."):
            z.write(f, f"{pid}/{f.relative_to(src)}")
print(out.relative_to(root))
