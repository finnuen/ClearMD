#!/usr/bin/env python3
"""
Bump the ClearMD file version everywhere it is written.

  python tools/bump_version.py              # 1.0.0.5 -> 1.0.0.6  (last digit, the per-build counter)
  python tools/bump_version.py --set 1.1.0.0
  python tools/bump_version.py --root DIR   # operate on another checkout

The user-facing title-bar text ("ClearMD v1.0", APP_TITLE in cpp/resource.h) is NOT touched: change it by hand
only for a real major/minor release.
After bumping: add a row to the build table in RELEASE_NOTES.md, then run tools/sync_viewer.py.
"""
import argparse, re, sys
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--set")
    a = ap.parse_args()
    root = Path(a.root)
    rh = root / "cpp" / "resource.h"
    text = rh.read_text(encoding="utf-8")
    m = re.search(r'#define VER_FILE_VERSION_STR\s+"(\d+)\.(\d+)\.(\d+)\.(\d+)"', text)
    if not m:
        sys.exit("VER_FILE_VERSION_STR not found")
    old = ".".join(m.groups())
    if a.set:
        parts = a.set.split(".")
        if len(parts) != 4 or not all(p.isdigit() for p in parts):
            sys.exit("--set expects four numbers, e.g. 1.0.0.6")
    else:
        parts = list(m.groups()); parts[3] = str(int(parts[3]) + 1)
    new = ".".join(parts)
    major, minor, build, rev = parts

    # resource.h: every numeric / string form of the version
    for prefix in ("VER_FILE_VERSION", "VER_PRODUCT_VERSION"):
        for suffix, val in (("_MAJOR", major), ("_MINOR", minor), ("_BUILD", build), ("_REVISION", rev)):
            text = re.sub(r"(#define %s%s\s+)\d+" % (prefix, suffix), r"\g<1>" + val, text)
        text = re.sub(r"(#define %s\s+)\d+,\d+,\d+,\d+" % prefix, r"\g<1>" + ",".join(parts), text)
        text = re.sub(r'(#define %s_STR\s+)"[\d.]+"' % prefix, r'\g<1>"%s"' % new, text)
    rh.write_text(text, encoding="utf-8")

    # plain "x.y.z.w" occurrences
    files = ["cpp/manifest.xml", "cpp/CMakeLists.txt", "cpp/ClearMD.cpp", "cpp/README.md", "src/App.tsx",
             "src/components/ClearMDWindow.tsx", "README.md"]
    changed = ["cpp/resource.h"]
    for f in files:
        p = root / f
        if not p.exists():
            continue
        t = p.read_text(encoding="utf-8")
        t2 = t.replace(old, new)
        if t2 != t:
            p.write_text(t2, encoding="utf-8"); changed.append(f)
    rn = root / "RELEASE_NOTES.md"
    if rn.exists():
        t = rn.read_text(encoding="utf-8")
        t2 = t.replace(f"(file version {old})", f"(file version {new})")
        if t2 != t:
            rn.write_text(t2, encoding="utf-8"); changed.append("RELEASE_NOTES.md (header)")
    print(f"{old} -> {new}\n  updated: " + ", ".join(changed))
    print("  next: add a build-history row in RELEASE_NOTES.md, then python tools/sync_viewer.py")
    return 0

if __name__ == "__main__":
    sys.exit(main())
