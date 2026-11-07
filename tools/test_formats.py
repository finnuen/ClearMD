#!/usr/bin/env python3
"""
ClearMD format regression tests (runs on Linux/macOS/WSL - no Windows needed).

What it does
  1. Extracts the PORTABLE-CORE region of cpp/ClearMD.cpp (the format handlers) into a small
     command-line harness and builds it with AddressSanitizer + UndefinedBehaviorSanitizer.
  2. Generates sample files for every supported format, each carrying marker metadata ("Secret...").
  3. Runs every handler and checks: metadata gone, content identical, idempotent, size rules,
     and that truncated / corrupted copies never crash or (for in-place formats) get modified
     during the dry run.

Usage
  python tools/test_formats.py                 # everything
  python tools/test_formats.py --only mp4,pdf  # subset (names as printed in the table)
  python tools/test_formats.py --keep DIR      # keep generated samples + outputs in DIR
  python tools/test_formats.py --src FILE.cpp  # test an experimental copy (also used to prove the tests can fail)
  python tools/test_formats.py --export-samples DIR   # only write samples (used by smoke_wine.sh)

Needs: g++ (C++17), ffmpeg/ffprobe, and Python packages: pillow numpy python-docx openpyxl python-pptx
reportlab pikepdf pypdf mutagen pillow-heif. Anything missing is reported as SKIP, not FAIL.
"""
import argparse, io, os, shutil, struct, subprocess, sys, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "cpp" / "ClearMD.cpp"
MARK = b"Secret"            # every piece of metadata we plant contains this word
BEGIN, END = "// >>> PORTABLE-CORE-BEGIN", "// <<< PORTABLE-CORE-END"

HARNESS_MAIN = r'''
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <array>
#include <fstream>
#include <iterator>
#include <cstdio>
using std::wstring;
%CORE%
static bool inplace(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why,
                    bool (*f)(Buf&, std::wstring&), bool& changed) {
    dst = src;
    Buf b{ dst.data(), dst.size() };
    b.dry = true;
    if (!f(b, why)) { if (dst != src) why = L"DRY RUN MODIFIED DATA"; return false; }
    if (dst != src) { why = L"DRY RUN MODIFIED DATA"; return false; }   // invariant: dry run never writes
    if (!b.changed) { changed = false; return true; }
    b.dry = false; b.changed = false;
    bool ok = f(b, why);
    changed = b.changed;
    if (dst.size() != src.size()) { why = L"IN-PLACE PATCH CHANGED LENGTH"; return false; }
    return ok;
}
int main(int argc, char** argv) {
    if (argc < 4) return 2;
    std::ifstream in(argv[2], std::ios::binary);
    std::vector<uint8_t> b((std::istreambuf_iterator<char>(in)), {}), o;
    bool ok = false, ch = true;
    std::wstring why;
    std::string k = argv[1];
    if (k == "jpg") ok = StripMetadataJPEG(b, o);
    else if (k == "png") ok = StripMetadataPNG(b, o);
    else if (k == "webp") ok = StripMetadataWebP(b, o);
    else if (k == "pdf") ok = StripMetadataPDF(b, o, why);
    else if (k == "ooxml") ok = StripMetadataOOXML(b, o, why);
    else if (k == "odf") ok = StripMetadataODF(b, o, why);
    else if (k == "mp3") ok = StripMetadataMP3(b, o, why);
    else if (k == "flac") ok = StripMetadataFLAC(b, o, why);
    else if (k == "wav") ok = StripMetadataWAV(b, o, why);
    else if (k == "gif") ok = StripMetadataGIF(b, o, why);
    else if (k == "svg") ok = StripMetadataSVG(b, o, why);
    else if (k == "aiff") ok = StripMetadataAIFF(b, o, why);
    else if (k == "mp4") ok = inplace(b, o, why, PatchMP4, ch);
    else if (k == "mkv") ok = inplace(b, o, why, PatchMKV, ch);
    else if (k == "avi") ok = inplace(b, o, why, PatchAVI, ch);
    else if (k == "heif") ok = inplace(b, o, why, PatchHEIF, ch);
    else return 2;
    if (ok) { std::ofstream f(argv[3], std::ios::binary); f.write((const char*)o.data(), (std::streamsize)o.size()); }
    for (wchar_t c : why) putchar((char)c);
    putchar('\n');
    return ok ? 0 : 1;
}
'''

RESULTS = []   # (format, check, status, detail)
def record(fmt, check, status, detail=""):
    RESULTS.append((fmt, check, status, detail))

def have(mod):
    try:
        __import__(mod); return True
    except Exception:
        return False

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

def build_harness(work):
    src = SRC.read_text(encoding="utf-8")
    a, b = src.index(BEGIN), src.index(END)
    core = src[a:b]
    (work / "harness.cpp").write_text(HARNESS_MAIN.replace("%CORE%", core), encoding="utf-8")
    exe = work / "harness"
    r = run(["g++", "-std=c++17", "-O1", "-g", "-Wall", "-Wextra", "-fsanitize=address,undefined",
             "-fno-sanitize-recover=undefined", str(work / "harness.cpp"), "-o", str(exe)])
    if r.returncode != 0:
        print(r.stderr); sys.exit("harness build failed")
    if r.stderr.strip():
        print("harness compiled with warnings:\n" + r.stderr)
        record("harness", "compiles warning-free", "FAIL", r.stderr.strip()[:200])
    return exe

ENV = dict(os.environ, ASAN_OPTIONS="exitcode=99:detect_leaks=0", UBSAN_OPTIONS="exitcode=98:print_stacktrace=1")

def strip(exe, kind, inp, out):
    r = subprocess.run([str(exe), kind, str(inp), str(out)], capture_output=True, text=True, env=ENV)
    return r.returncode, r.stdout.strip(), r.stderr

# ----------------------------------------------------------------------------- sample generation
class Sample:
    def __init__(self, name, kind, path, content=None, inplace=False, same_size=False, expect_fail=None, ext_check=None):
        self.name, self.kind, self.path = name, kind, path
        self.content = content          # callable(before_path, after_path) -> (ok, detail)
        self.inplace, self.same_size = inplace, same_size
        self.expect_fail = expect_fail  # substring expected in the failure message
        self.ext_check = ext_check      # extra callable(after_path) -> (ok, detail)

def raw_contains(path, needle=MARK):
    """Search the raw bytes AND every member of a zip package."""
    data = Path(path).read_bytes()
    if needle in data:
        return True
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            return any(needle in z.read(n) for n in z.namelist())
    return False

def ffmd5(path, sel):
    r = run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-map", sel, "-f", "md5", "-"])
    return r.stdout.strip() if r.returncode == 0 else None

def ffprobe_tags(path):
    r = run(["ffprobe", "-loglevel", "error", "-show_entries", "format_tags:stream_tags", "-of", "default=nw=1", str(path)])
    return [l for l in r.stdout.splitlines() if "Secret" in l]

def media_content(streams):
    def check(a, b):
        for s in streams:
            ha, hb = ffmd5(a, s), ffmd5(b, s)
            if ha is None or ha != hb:
                return False, f"decoded {s} differs ({ha} vs {hb})"
        t = ffprobe_tags(b)
        return (not t), (f"tags left: {t}" if t else "")
    return check

def image_content(a, b):
    from PIL import Image
    import numpy as np
    A, B = Image.open(a), Image.open(b)
    n = getattr(A, "n_frames", 1)
    if n != getattr(B, "n_frames", 1):
        return False, "frame count differs"
    for i in range(n):
        A.seek(i); B.seek(i)
        if not np.array_equal(np.array(A.convert("RGBA")), np.array(B.convert("RGBA"))):
            return False, f"pixels differ in frame {i}"
    return True, f"{n} frame(s) identical"

def make_samples(d):
    S = []
    d = Path(d)
    ff = shutil.which("ffmpeg") is not None

    if have("PIL") and have("numpy"):
        from PIL import Image, PngImagePlugin
        import numpy as np
        rng = np.random.default_rng(1)
        im = Image.fromarray(rng.integers(0, 255, (64, 64, 3), dtype=np.uint8))
        ex = Image.Exif(); ex[0x010F] = "SecretCam"; ex[0x0132] = "2020:01:01 00:00:00"; ex[0x0112] = 6
        im.save(d / "a.jpg", quality=90, exif=ex.tobytes(), comment=b"SecretComment")
        im.save(d / "prog.jpg", quality=90, progressive=True, exif=ex.tobytes())
        pi = PngImagePlugin.PngInfo(); pi.add_text("Author", "SecretBob"); pi.add_itxt("XML:com.adobe.xmp", "<x>SecretXmp</x>")
        im.save(d / "a.png", pnginfo=pi, exif=ex.tobytes())
        im.save(d / "a.webp", exif=ex.tobytes(), xmp=b"<x>SecretXmp</x>", lossless=True)
        im.convert("RGBA").save(d / "anim.webp", save_all=True, append_images=[im.convert("RGBA")], exif=ex.tobytes())
        for n, k in [("a.jpg", "jpg"), ("prog.jpg", "jpg"), ("a.png", "png"), ("a.webp", "webp"), ("anim.webp", "webp")]:
            S.append(Sample(n, k, d / n, content=image_content))
        # GIF with comment + XMP application extension
        fr = [Image.fromarray(rng.integers(0, 255, (32, 32, 3), dtype=np.uint8)).convert("P") for _ in range(3)]
        fr[0].save(d / "g0.gif", save_all=True, append_images=fr[1:], loop=0, duration=100, comment=b"SecretGifComment")
        g = (d / "g0.gif").read_bytes()
        pos = 13 + (3 * 2 ** ((g[10] & 7) + 1) if g[10] & 0x80 else 0)
        xmp = b"<x:xmpmeta>SecretXmp</x:xmpmeta>"
        (d / "a.gif").write_bytes(g[:pos] + b"\x21\xff\x0bXMP DataXMP" + bytes([len(xmp)]) + xmp + b"\x00" + g[pos:])
        (d / "g0.gif").unlink()
        S.append(Sample("a.gif", "gif", d / "a.gif", content=image_content))
        if have("pillow_heif"):
            import pillow_heif; pillow_heif.register_heif_opener()
            for n, fmt in (("a.heic", "HEIF"), ("a.avif", "AVIF")):
                try:
                    im.save(d / n, format=fmt, exif=ex.tobytes(), xmp=b"<x:xmpmeta>SecretXmp</x:xmpmeta>", quality=80)
                    S.append(Sample(n, "heif", d / n, content=image_content, inplace=True, same_size=True))
                except Exception as e:
                    record(n, "generate sample", "SKIP", str(e)[:80])
        else:
            record("heic/avif", "generate sample", "SKIP", "pillow-heif not installed")
    else:
        record("images", "generate samples", "SKIP", "pillow/numpy not installed")

    (d / "a.svg").write_text('''<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape SecretComment -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="100" height="100" inkscape:version="1.2 SecretVer" sodipodi:docname="C:\\Users\\Secret\\doc.svg">
  <sodipodi:namedview id="nv" inkscape:export-filename="C:\\Users\\Secret\\out.png"/>
  <metadata id="m1"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><dc:creator>SecretAuthor</dc:creator></rdf:RDF></metadata>
  <title>Keep me</title>
  <rect id="r" x="10" y="10" width="80" height="80" fill="red" inkscape:label="SecretLabel"/>
  <text x="5" y="5">a &gt; b <!-- inner SecretInner --></text>
  <style><![CDATA[ .a > .b { fill: blue } ]]></style>
</svg>''', encoding="utf-8")
    def svg_content(a, b):
        t = Path(b).read_text(encoding="utf-8")
        keep = ['<title>Keep me</title>', 'fill="red"', 'a &gt; b', 'CDATA[ .a > .b { fill: blue } ]]>']
        import xml.dom.minidom as m
        m.parseString(t)
        return all(k in t for k in keep), "drawing content kept, XML well-formed"
    S.append(Sample("a.svg", "svg", d / "a.svg", content=svg_content))

    # ---- documents
    if have("docx"):
        from docx import Document
        doc = Document(); doc.add_paragraph("Hello body text")
        cp = doc.core_properties; cp.author = "SecretAlice"; cp.last_modified_by = "SecretBob"; cp.title = "SecretTitle"; cp.comments = "SecretNote"
        doc.save(d / "a.docx")
        def docx_content(a, b):
            x, y = Document(a), Document(b)
            if [p.text for p in x.paragraphs] != [p.text for p in y.paragraphs]: return False, "text differs"
            return (y.core_properties.author == ""), "text identical, author empty"
        S.append(Sample("a.docx", "ooxml", d / "a.docx", content=docx_content))
    else:
        record("docx", "generate sample", "SKIP", "python-docx not installed")
    if have("openpyxl"):
        import openpyxl
        wb = openpyxl.Workbook(); wb.active["A1"] = "cell value"; wb.properties.creator = "SecretCarol"; wb.properties.title = "SecretBudget"
        wb.save(d / "a.xlsx")
        def xlsx_content(a, b):
            return openpyxl.load_workbook(a).active["A1"].value == openpyxl.load_workbook(b).active["A1"].value, "cell A1 identical"
        S.append(Sample("a.xlsx", "ooxml", d / "a.xlsx", content=xlsx_content))
    if have("pptx"):
        from pptx import Presentation
        p = Presentation(); p.slides.add_slide(p.slide_layouts[0]).shapes.title.text = "Slide title"
        p.core_properties.author = "SecretDave"; p.core_properties.title = "SecretDeck"; p.save(d / "a.pptx")
        def pptx_content(a, b):
            return Presentation(a).slides[0].shapes.title.text == Presentation(b).slides[0].shapes.title.text, "slide title identical"
        S.append(Sample("a.pptx", "ooxml", d / "a.pptx", content=pptx_content))

    # ODT built by hand (mimetype first + stored, meta.xml with creator, thumbnail + manifest entries)
    def build_odt(path):
        man = ('<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">\n'
               ' <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>\n'
               ' <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>\n'
               ' <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>\n'
               ' <manifest:file-entry manifest:full-path="Thumbnails/thumbnail.png" manifest:media-type="image/png"/>\n'
               ' <manifest:file-entry manifest:full-path="Thumbnails/" manifest:media-type=""/>\n</manifest:manifest>')
        meta = ('<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
                'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">'
                '<office:meta><dc:creator>SecretAuthor</dc:creator><meta:initial-creator>SecretAuthor</meta:initial-creator></office:meta></office:document-meta>')
        content = ('<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
                   'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text><text:p>Hello ODF body</text:p></office:text></office:body></office:document-content>')
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("mimetype", "application/vnd.oasis.opendocument.text", compress_type=zipfile.ZIP_STORED)
            z.writestr("content.xml", content, compress_type=zipfile.ZIP_DEFLATED)
            z.writestr("meta.xml", meta, compress_type=zipfile.ZIP_DEFLATED)
            z.writestr("META-INF/manifest.xml", man, compress_type=zipfile.ZIP_DEFLATED)
            z.writestr("Thumbnails/thumbnail.png", b"\x89PNGSecretThumb", compress_type=zipfile.ZIP_STORED)
    build_odt(d / "a.odt")
    def odt_content(a, b):
        za, zb = zipfile.ZipFile(a), zipfile.ZipFile(b)
        if zb.infolist()[0].filename != "mimetype" or zb.infolist()[0].compress_type != zipfile.ZIP_STORED: return False, "mimetype entry must stay first and stored"
        if zb.read("content.xml") != za.read("content.xml"): return False, "content.xml changed"
        if any("Thumbnails" in n for n in zb.namelist()) or b"Thumbnails" in zb.read("META-INF/manifest.xml"): return False, "thumbnail not fully removed"
        return zb.testzip() is None, "content identical, mimetype first+stored, thumbnail gone"
    S.append(Sample("a.odt", "odf", d / "a.odt", content=odt_content))

    # ---- PDF
    if have("reportlab"):
        from reportlab.pdfgen import canvas
        c = canvas.Canvas(str(d / "a.pdf")); c.setAuthor("SecretEve"); c.setTitle("SecretTitle"); c.setSubject("SecretSubj"); c.setKeywords("SecretK")
        c.drawString(72, 720, "PDF body text visible"); c.save()
        def pdf_content(a, b):
            import pypdf
            ra, rb = pypdf.PdfReader(a), pypdf.PdfReader(b)
            if ra.pages[0].extract_text() != rb.pages[0].extract_text(): return False, "text differs"
            if any("Secret" in str(v) for v in (rb.metadata or {}).values()): return False, "info dict not blanked"
            return True, "text identical, info blanked"
        S.append(Sample("a.pdf", "pdf", d / "a.pdf", content=pdf_content if have("pypdf") else None, same_size=True))
        if have("pikepdf"):
            import pikepdf
            pdf = pikepdf.open(d / "a.pdf")
            with pdf.open_metadata() as m:
                m["dc:creator"] = ["SecretFrank"]; m["dc:title"] = "SecretXmpTitle"; m["xmp:CreatorTool"] = "SecretTool"
            pdf.save(d / "xmp.pdf")
            pdf.save(d / "objstm.pdf", object_stream_mode=pikepdf.ObjectStreamMode.generate)
            S.append(Sample("xmp.pdf", "pdf", d / "xmp.pdf", content=pdf_content if have("pypdf") else None, same_size=True))
            S.append(Sample("objstm.pdf", "pdf", d / "objstm.pdf", expect_fail="object streams"))   # documented limitation
    else:
        record("pdf", "generate sample", "SKIP", "reportlab not installed")

    # ---- audio / video (ffmpeg)
    if ff:
        def ffm(args, out):
            r = run(["ffmpeg", "-loglevel", "error", "-y"] + args + [str(d / out)])
            if r.returncode != 0: record(out, "generate sample", "SKIP", r.stderr.strip()[:80]); return False
            return True
        sine = ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]
        vid = ["-f", "lavfi", "-i", "testsrc=duration=1:size=128x96:rate=15"]
        tags = ["-metadata", "title=SecretSong", "-metadata", "artist=SecretArtist"]
        if ffm(sine + tags + ["-id3v2_version", "3", "-write_id3v1", "1"], "a.mp3"):
            if have("mutagen"):
                from mutagen.apev2 import APEv2
                t = APEv2()
                try: t.load(str(d / "a.mp3"))
                except Exception: pass
                t["Artist"] = "SecretApe"; t.save(str(d / "a.mp3"))
            S.append(Sample("a.mp3", "mp3", d / "a.mp3", content=media_content(["0:a"])))
        if ffm(sine + tags, "a.flac"):
            if have("mutagen"):
                from mutagen.flac import FLAC, Picture
                f = FLAC(str(d / "a.flac")); pic = Picture(); pic.data = b"\x89PNGSecretPic"; pic.type = 3; pic.mime = "image/png"; f.add_picture(pic); f.save()
            S.append(Sample("a.flac", "flac", d / "a.flac", content=media_content(["0:a"])))
        if ffm(sine + tags, "a.wav"): S.append(Sample("a.wav", "wav", d / "a.wav", content=media_content(["0:a"])))
        if ffm(sine + tags, "a.aiff"): S.append(Sample("a.aiff", "aiff", d / "a.aiff", content=media_content(["0:a"])))
        if ffm(sine + ["-c:a", "aac"] + tags, "a.m4a"): S.append(Sample("a.m4a", "mp4", d / "a.m4a", content=media_content(["0:a"]), inplace=True, same_size=True))
        vtags = ["-metadata", "title=SecretVideo", "-metadata", "location=+12.3456+098.7654/"]
        if ffm(vid + sine + ["-c:v", "libx264", "-c:a", "aac"] + vtags + ["-movflags", "+faststart"], "a.mp4"):
            S.append(Sample("a.mp4", "mp4", d / "a.mp4", content=media_content(["0:v", "0:a"]), inplace=True, same_size=True))
        if ffm(vid + ["-c:v", "libx264", "-metadata", "title=SecretMov", "-f", "mov"], "a.mov"):
            S.append(Sample("a.mov", "mp4", d / "a.mov", content=media_content(["0:v"]), inplace=True, same_size=True))
        if ffm(vid + sine + ["-c:v", "libx264", "-c:a", "aac", "-metadata", "title=SecretMkv", "-metadata", "author=SecretAuthor"], "a.mkv"):
            S.append(Sample("a.mkv", "mkv", d / "a.mkv", content=media_content(["0:v", "0:a"]), inplace=True, same_size=True))
        if ffm(vid + sine + ["-c:v", "libvpx", "-c:a", "libvorbis", "-metadata", "title=SecretWebm"], "a.webm"):
            S.append(Sample("a.webm", "mkv", d / "a.webm", content=media_content(["0:v", "0:a"]), inplace=True, same_size=True))
        if ffm(vid + sine + ["-c:v", "mpeg4", "-c:a", "mp3", "-metadata", "title=SecretAvi", "-metadata", "artist=SecretArtist"], "a.avi"):
            S.append(Sample("a.avi", "avi", d / "a.avi", content=media_content(["0:v", "0:a"]), inplace=True, same_size=True))
    else:
        record("audio/video", "generate samples", "SKIP", "ffmpeg not installed")
    return S

# ----------------------------------------------------------------------------- checks
def check_sample(exe, s, work):
    out = work / ("out_" + s.name)
    rc, msg, err = strip(exe, s.kind, s.path, out)
    if rc >= 98:
        record(s.name, "no crash / sanitizer clean", "FAIL", err.strip()[-300:]); return
    if s.expect_fail:
        okk = rc == 1 and s.expect_fail in msg
        record(s.name, "fails cleanly with expected reason", "PASS" if okk else "FAIL", msg)
        return
    if rc != 0:
        record(s.name, "strip succeeds", "FAIL", msg or f"rc={rc}"); return
    record(s.name, "strip succeeds", "PASS")
    left = raw_contains(out)
    record(s.name, "no 'Secret' metadata left", "FAIL" if left else "PASS")
    if s.same_size:
        a, b = s.path.stat().st_size, out.stat().st_size
        record(s.name, "file length unchanged (in-place)", "PASS" if a == b else "FAIL", f"{a} -> {b}")
    if s.content:
        try:
            ok, detail = s.content(s.path, out)
        except Exception as e:
            ok, detail = False, f"{type(e).__name__}: {e}"
        record(s.name, "content identical / still opens", "PASS" if ok else "FAIL", detail)
    out2 = work / ("out2_" + s.name)
    rc2, _, _ = strip(exe, s.kind, out, out2)
    record(s.name, "idempotent (second run = no change)", "PASS" if rc2 == 0 and out.read_bytes() == out2.read_bytes() else "FAIL")
    # robustness: truncated / corrupted copies must never crash, and failures must not write output
    data = s.path.read_bytes()
    bad = 0
    cuts = sorted({1, 2, 3, 8, 20, len(data) // 7, len(data) // 3, len(data) // 2, len(data) - 1})
    for i, n in enumerate(c for c in cuts if 0 < c < len(data)):
        p = work / f"trunc_{i}_{s.name}"; p.write_bytes(data[:n])
        rc3, _, e3 = strip(exe, s.kind, p, work / "x")
        if rc3 >= 98: bad += 1; record(s.name, f"truncated at {n} bytes", "FAIL", e3.strip()[-200:])
    import random
    rnd = random.Random(1234)
    for i in range(12):
        b = bytearray(data)
        for _ in range(max(1, len(b) // 500)):
            b[rnd.randrange(len(b))] = rnd.randrange(256)
        p = work / f"flip_{i}_{s.name}"; p.write_bytes(bytes(b))
        rc4, _, e4 = strip(exe, s.kind, p, work / "x")
        if rc4 >= 98: bad += 1; record(s.name, f"random corruption #{i}", "FAIL", e4.strip()[-200:])
    if not bad:
        record(s.name, "survives truncation + 12 corrupted copies", "PASS")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated sample names or kinds (e.g. mp4,a.pdf)")
    ap.add_argument("--keep", help="keep work files in this directory")
    ap.add_argument("--src", help="test a different copy of ClearMD.cpp (default: cpp/ClearMD.cpp)")
    ap.add_argument("--export-samples", help="only write the sample files into this directory and exit")
    a = ap.parse_args()

    if a.export_samples:
        d = Path(a.export_samples); d.mkdir(parents=True, exist_ok=True)
        S = make_samples(d)
        print(f"wrote {len(S)} samples to {d}")
        return 0

    global SRC
    if a.src: SRC = Path(a.src)
    work = Path(a.keep) if a.keep else Path(tempfile.mkdtemp(prefix="clearmd_test_"))
    work.mkdir(parents=True, exist_ok=True)
    if not shutil.which("g++"): sys.exit("g++ not found")
    exe = build_harness(work)
    samples = make_samples(work)
    only = set(a.only.split(",")) if a.only else None
    for s in samples:
        if only and not (s.name in only or s.kind in only): continue
        check_sample(exe, s, work)

    w = max([len(r[0]) for r in RESULTS] + [8])
    fails = 0
    for fmt, check, status, detail in RESULTS:
        if status == "FAIL": fails += 1
        print(f"{status:<5} {fmt:<{w}}  {check}" + (f"  [{detail}]" if detail else ""))
    n = {k: sum(1 for r in RESULTS if r[2] == k) for k in ("PASS", "FAIL", "SKIP")}
    print(f"\n{n['PASS']} passed, {n['FAIL']} failed, {n['SKIP']} skipped   (work dir: {work})")
    if not a.keep: shutil.rmtree(work, ignore_errors=True)
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
