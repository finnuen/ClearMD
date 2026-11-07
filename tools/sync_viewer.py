#!/usr/bin/env python3
"""
Keeps the web demo's "C++ source" viewer in sync with the real sources.

src/components/CppSourceViewer.tsx embeds copies of cpp/ClearMD.cpp, ClearMD.rc, resource.h, manifest.xml,
CMakeLists.txt, both build scripts and the icon (base64) so the demo can offer a "download project" zip.
Those copies go stale whenever cpp/ changes - run this after ANY edit under cpp/.

  python tools/sync_viewer.py            # rewrite the embedded constants
  python tools/sync_viewer.py --check    # exit 1 if they are out of date (use before packaging / in CI)
"""
import argparse, base64, re, sys
from pathlib import Path

CONSTANTS = [("CPP_CODE", "ClearMD.cpp"), ("RESOURCE_RC", "ClearMD.rc"), ("BUILD_MSVC", "build_msvc.bat"),
             ("BUILD_MINGW", "build_mingw.bat"), ("RESOURCE_H", "resource.h"), ("MANIFEST_XML", "manifest.xml"),
             ("CMAKE_TXT", "CMakeLists.txt")]

def esc(s):  # make text safe inside a JS template literal
    return s.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    root = Path(a.root)
    tsx = root / "src" / "components" / "CppSourceViewer.tsx"
    text = tsx.read_text(encoding="utf-8")
    new = text
    for name, fname in CONSTANTS:
        m = re.search(r"const %s = `.*?`;\n" % name, new, re.S)
        if not m:
            sys.exit(f"constant {name} not found in {tsx}")
        body = esc((root / "cpp" / fname).read_text(encoding="utf-8"))
        new = new[:m.start()] + f"const {name} = `{body}`;\n" + new[m.end():]
    b64 = base64.b64encode((root / "cpp" / "ClearMD.ico").read_bytes()).decode()
    new, n = re.subn(r"const ICON_B64 = '[^']*';", f"const ICON_B64 = '{b64}';", new)
    if n != 1:
        sys.exit("ICON_B64 constant not found")
    if new == text:
        print("viewer is up to date")
        return 0
    if a.check:
        print("viewer is OUT OF DATE - run: python tools/sync_viewer.py")
        return 1
    tsx.write_text(new, encoding="utf-8")
    print("viewer updated")
    return 0

if __name__ == "__main__":
    sys.exit(main())
