#!/usr/bin/env python3
"""
Bump the ClearMD version everywhere it is written.

  python tools/bump_version.py              # 1.0 -> 1.1  (second number, the per-build counter)
  python tools/bump_version.py --set 1.2
  python tools/bump_version.py --root DIR   # operate on another checkout

The version has two numbers. Windows VERSIONINFO still takes four numeric fields, so the last two are pinned to 0
("1.1" -> 1,1,0,0) and the file-version strings are written as the two-number form.

Every rewrite is anchored to its context (a bare "1.0" also appears in XML declarations and format text, which must not
be touched), and nothing is written unless every pattern matched exactly once - a half-bumped tree is worse than none.
After bumping: build (the scripts read resource.h for the exe name), run tools/sync_viewer.py, and add a row to the
build table in RELEASE_NOTES.md.
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
    m = re.search(r'#define VER_FILE_VERSION_STR\s+"(\d+)\.(\d+)"', text)
    if not m:
        sys.exit('VER_FILE_VERSION_STR "X.Y" not found')
    old = ".".join(m.groups())
    if a.set:
        parts = a.set.split(".")
        if len(parts) != 2 or not all(p.isdigit() for p in parts):
            sys.exit("--set expects two numbers, e.g. 1.1")
        major, minor = parts
    else:
        major, minor = m.group(1), str(int(m.group(2)) + 1)
    new = f"{major}.{minor}"
    quad = f"{major},{minor},0,0"

    edits = []   # (path, new text)

    def add(path, pattern, repl, what):
        # accumulate: several rewrites can target the same file
        pending = next((i for i, (p, _) in enumerate(edits) if p == path), None)
        t = edits[pending][1] if pending is not None else path.read_text(encoding="utf-8")
        t2, n = re.subn(pattern, repl, t, flags=re.M)
        if n != 1:
            sys.exit(f"{path.relative_to(root)}: expected one {what}, found {n} - nothing written")
        if pending is None:
            edits.append((path, t2))
        else:
            edits[pending] = (path, t2)
        return t2

    # resource.h: numeric fields, both string forms, and the title-bar text
    t = text
    for prefix in ("VER_FILE_VERSION", "VER_PRODUCT_VERSION"):
        for suffix, val in (("_MAJOR", major), ("_MINOR", minor), ("_BUILD", "0"), ("_REVISION", "0")):
            t, n = re.subn(r"(#define %s%s\s+)\d+" % (prefix, suffix), r"\g<1>" + val, t)
            if n != 1:
                sys.exit(f"resource.h: {prefix}{suffix} not found - nothing written")
        t, n = re.subn(r"(#define %s\s+)\d+,\d+,\d+,\d+" % prefix, r"\g<1>" + quad, t)
        t, n2 = re.subn(r'(#define %s_STR\s+)"[\d.]+"' % prefix, r'\g<1>"%s"' % new, t)
        if n != 1 or n2 != 1:
            sys.exit(f"resource.h: {prefix} numbers/string not found - nothing written")
    t, n = re.subn(r'(#define APP_TITLE\s+)L"ClearMD v[\d.]+"', r'\g<1>L"ClearMD v%s"' % new, t)
    if n != 1:
        sys.exit("resource.h: APP_TITLE not found - nothing written")
    edits.append((rh, t))

    # manifest assembly identity (the dependency's 6.0.0.0 must stay untouched)
    add(root / "cpp" / "manifest.xml",
        r'(<assembly xmlns="urn:schemas-microsoft-com:asm\.v1" manifestVersion="1\.0">\s*<assemblyIdentity\s+version=")[\d.]+"',
        r'\g<1>%s.0.0"' % new, "manifest assembly version")

    # CMake project version
    add(root / "cpp" / "CMakeLists.txt", r"(project\(ClearMD VERSION )[\d.]+", r"\g<1>" + new, "CMake version")

    # source header comment
    add(root / "cpp" / "ClearMD.cpp", r"^( \* Version: )[\d.]+$", r"\g<1>" + new, "ClearMD.cpp version")

    # demo: download zip name, badge, file-version label
    app = root / "src" / "App.tsx"
    add(app, r"(ClearMD_Cpp17_Standalone_v)[\d.]+(\.zip')", r"\g<1>" + new + r"\g<2>", "zip name")
    add(app, r'(font-mono font-medium">\s*\n\s*)v[\d.]+', r"\g<1>v" + new, "version badge")
    add(app, r"(File Version )[\d.]+", r"\g<1>" + new, "footer version")

    add(root / "src" / "components" / "ClearMDWindow.tsx",
        r"(\s*)v[\d.]+( &bull; Lossless Mode)", r"\g<1>v" + new + r"\g<2>", "window badge")

    viewer = root / "src" / "components" / "CppSourceViewer.tsx"
    add(viewer, r"(ClearMD_Cpp17_Standalone_v)[\d.]+(\.zip')", r"\g<1>" + new + r"\g<2>", "zip name")
    add(viewer, r"(Standalone C\+\+17 Windows Source Project\s*\n\s*<span[^\n]*\n\s*)v[\d.]+", r"\g<1>v" + new, "version badge")
    add(viewer, r"(File Version: )[\d.]+", r"\g<1>" + new, "footer version")

    # docs that name the current version
    add(root / "cpp" / "README.md", r"`ClearMD v[\d.]+`", f"`ClearMD v{new}`", "APP_TITLE mention")
    add(root / "RELEASE_NOTES.md", r"^\*\*Release:\*\* v[\d.]+", f"**Release:** v{new}", "release line")

    for path, new_text in edits:
        if new_text != path.read_text(encoding="utf-8"):
            path.write_text(new_text, encoding="utf-8")
    print(f"{old} -> {new}")
    print("  next: build (the scripts name the exe from resource.h), run python tools/sync_viewer.py,")
    print("        add a build-history row in RELEASE_NOTES.md")
    return 0

if __name__ == "__main__":
    sys.exit(main())
