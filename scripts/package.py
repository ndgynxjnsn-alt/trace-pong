#!/usr/bin/env python3
"""Pack plugin/ into dist/<id>-<version>.zip (the layout Grafana expects: <id>/plugin.json, ...).

Grafana serves plugin files with a one-hour cache, so relative ES-module imports get ?v=<version>
appended in the ZIP; module.js already loads js/app.js with it.
"""
import json
import re
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
        if not f.is_file() or f.name.startswith("."):
            continue
        name = f"{pid}/{f.relative_to(src)}"
        if f.parent.name == "js" and f.suffix == ".js":
            code = re.sub(r"""(from\s+['"]\./[\w.-]+\.js)(['"])""", rf"\1?v={ver}\2", f.read_text())
            z.writestr(name, code)
        else:
            z.write(f, name)
print(out.relative_to(root))
