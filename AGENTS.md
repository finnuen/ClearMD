# AGENTS.md - developing ClearMD

Guide for engineers and coding agents working on this repo. Read this before changing code.
User-facing behaviour is documented in `README.md`; what changed per build is in `RELEASE_NOTES.md`.

## 1. What this is

ClearMD is a **single-window native Windows app** (C++17, Win32, no third-party libraries) that removes metadata from files
*without re-encoding them*. One source file, `cpp/ClearMD.cpp` (~3,000 lines), builds one portable `ClearMD.exe`.

`src/` is a **secondary** React demo (a simulator plus a viewer of the C++ source). The product is the `.exe`.

```
cpp/ClearMD.cpp        the app: format handlers + processing pipeline + Win32 UI
cpp/ClearMD.rc         icon, version info, manifest (resource ids come from resource.h)
cpp/resource.h         control ids, APP_TITLE ("ClearMD v1.0"), file version 1.0.0.x
cpp/manifest.xml       Common Controls v6, per-monitor DPI, Windows 10 compat, long paths
cpp/ClearMD.ico        7-size icon;  cpp/make_icon.py redraws it (run inside cpp/, needs Pillow)
cpp/build_mingw.bat  build_msvc.bat  CMakeLists.txt
tools/                 test_formats.py  smoke_wine.sh  sync_viewer.py  bump_version.py   (section 4)
src/components/CppSourceViewer.tsx   embeds COPIES of the cpp/ files - must be re-synced after any cpp/ edit
```

## 2. Build

### Linux / macOS cross-compile (how the shipped exe is built)
```bash
sudo apt-get install -y g++-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64   # POSIX threads variant is required (std::thread)
cd cpp
x86_64-w64-mingw32-windres ClearMD.rc -O coff -o /tmp/ClearMD.res.o
x86_64-w64-mingw32-g++ -Wall -Wextra -std=c++17 -O2 -s -municode -mwindows -static -static-libgcc -static-libstdc++ \
    ClearMD.cpp /tmp/ClearMD.res.o -lcomctl32 -lole32 -lshell32 -loleaut32 -lgdi32 -luser32 -luuid -o ClearMD.exe
```
Required flags, and why: `-municode` (wWinMain), `-luuid` (CLSID_FileOpenDialog - omitting it is a link error), `-static*`
(the exe must run with only system DLLs; it imports COMCTL32/GDI32/KERNEL32/msvcrt/ole32/SHELL32/USER32 and nothing else),
`-Wall -Wextra` (**the build must stay at zero warnings**).

### On Windows
`cpp\build_mingw.bat`, `cpp\build_msvc.bat` (x64 Native Tools prompt) or CMake. MSVC links `uuid.lib` through a `#pragma comment`.
**The MSVC and CMake paths are provided but have not been run since the Win32 UI code grew** - if you have MSVC, build with it
and fix whatever `/W4` finds before relying on it.

### Web demo
`npm install && npm run dev` / `npx vite build` / `npx tsc --noEmit`. No API key is needed (the Gemini entries in
`.env.example` and `metadata.json` are template leftovers and are unused).

## 3. Architecture

### 3.1 File layout of `ClearMD.cpp` (top to bottom)
| Section | Notes |
|---|---|
| Data structures, globals | `FileFormat`, `FileEntry`, `Job`, `JobResult`, `g_files`, `g_pathSet`, `g_isProcessing` |
| Helpers, `kExtensions`, `DetectFileFormat`, `FormatToString` | extension -> format -> friendly type label |
| **`>>> PORTABLE-CORE-BEGIN` ... `<<< PORTABLE-CORE-END`** | **All format handlers. Standard C++ only, no Win32.** Compiled on Linux by the tests. |
| `ReadWholeFile`, `StripAny`, `PatchAny`, `RemoveAlternateStreams`, `ProcessInPlace`, `ProcessBuffered`, `ProcessFile` | Win32 processing pipeline (section 3.3) |
| `CheckForUpdatesAsync`, `WinHttpGet`, `JsonStringField` | Launch-time GitHub release check; runs off the UI thread, silent on failure, posts `WM_APP_UPDATE_FOUND` |
| UI | list view, add/remove/drop, context menu, confirmation dialog, DPI-aware layout, `WndProc`, `wWinMain` |

Inside the portable core: JPEG / PNG / WebP -> binary helpers + `Crc32` + own DEFLATE reader -> ZIP container, OOXML, ODF -> PDF ->
MP3 / FLAC / WAV -> **`Buf`** and the in-place patchers (MP4, HEIF, MKV, AVI) -> GIF / AIFF / SVG.

### 3.2 Two kinds of format handler
| | **Buffered** (rewritten copy) | **In-place** (patched through a memory map) |
|---|---|---|
| Signature | `bool StripMetadataX(const vector<uint8_t>& src, vector<uint8_t>& dst, wstring& why)` (JPEG/PNG/WebP predate `why` and return bool only) | `bool PatchX(Buf& b, wstring& why)` |
| Formats | JPEG PNG WebP GIF SVG PDF OOXML ODF MP3 FLAC WAV AIFF | MP4/MOV/M4A, HEIC/AVIF, MKV/WebM, AVI |
| Output size | may shrink | **identical to input - never changes length or any offset** |
| How applied | write `<file>.clearmd_tmp`, verify the write, `ReplaceFileW` (fallback `MoveFileExW`) | map file read/write, run patcher **twice** (see below) |
| Size limit | 1.5 GB (`kMaxBufferedSize`) | none (not read into RAM) |

PDF is "buffered" but behaves like in-place: it blanks strings with spaces so the output length equals the input.

**Dry-run protocol (in-place):** pass 1 runs with `Buf.dry = true` - `set()` records `changed` but writes nothing - so the patcher can
fully validate the file first. Only if pass 1 returns true does pass 2 run for real. **A patcher must therefore make the same
decisions in both passes and must never write while `dry` is set** (always write through `b.set / b.zero / b.put`, never through `b.d[...]`).

### 3.3 Processing pipeline
```
OnClearAllMetadata (UI thread)
  -> collect Job{index, path, format} for every not-yet-processed row      (a COPY - the worker never touches g_files)
  -> ConfirmAndCountdown()  : warning, Proceed/Cancel, 3 s cancellable progress bar   (returns false = do nothing)
  -> g_isProcessing = true; SetControlsEnabled(false); detached std::thread:
       for each Job: ProcessFile(job, res)
            fs::file_size
            format != Unknown ? (IsInPlaceFormat ? ProcessInPlace : ProcessBuffered) : skip
            RemoveAlternateStreams(path)          # NTFS streams, runs for EVERY file type
            compose res.status / res.success
         PostMessage(WM_APP_UPDATE_ITEM, lParam = new JobResult)   # UI thread takes ownership (unique_ptr)
       PostMessage(WM_APP_BATCH_DONE, ok, failed)
UI thread: WM_APP_UPDATE_ITEM updates the row; WM_APP_BATCH_DONE re-enables controls and shows the summary.
```
Rules: only the UI thread touches `g_files`, `g_pathSet` and controls. While `g_isProcessing` is true, add / remove / clear / drop and
window close are blocked. `ProcessFile` catches everything (`catch (...)`) - never let an exception cross the thread boundary.

### 3.4 User-visible status strings are an API
`README.md` documents them and users read them: `Ready`, `Ready (streams only)`, `Cleaned`, `Cleaned (-12.3 KB)`,
`Clean (no metadata found)`, `Nothing to remove`, `... + N NTFS stream(s)`, `Failed: <reason> (file untouched)`.
Change wording only together with the README table.

## 4. Tools (all under `tools/`)

| Command | Purpose |
|---|---|
| `python tools/test_formats.py` | **The main regression suite.** Extracts the portable core, builds it with ASan + UBSan, generates a sample of every format carrying `Secret...` metadata and checks: strip succeeds, no marker left (also inside zip members), content identical (pixels / decoded audio+video / document text / cell values / ODF structure), in-place length unchanged, idempotent, and truncated + 12 randomly corrupted copies never crash. Also asserts the documented failure (PDF with object streams). `--only mp4,a.pdf`, `--keep DIR`, `--src other.cpp`. |
| `python tools/sync_viewer.py [--check]` | Re-embeds `cpp/*` and the icon into `CppSourceViewer.tsx`. **Run after every edit under `cpp/`**; `--check` exits 1 if stale. |
| `python tools/bump_version.py [--set X.Y.Z.W]` | Bumps the file version everywhere (resource.h, manifest, CMake, source header, demo, docs). Does not touch `APP_TITLE`. |
| `tools/smoke_wine.sh path/to/ClearMD.exe` | Drives the **real exe** under Wine + Xvfb with xdotool: add files, warning dialog, Cancel, Cancel during countdown, full run, resize; checks the files on disk. Takes ~4 minutes - run it in the background if your tool has a 5-minute limit. Needs `wine64 xvfb xdotool imagemagick`. |

Test dependencies: `g++`, `ffmpeg`, and `pip install pillow numpy python-docx openpyxl python-pptx reportlab pikepdf pypdf mutagen pillow-heif`.
Missing pieces are reported as SKIP - **a green run with many SKIPs proves little; install the tools.**

**Proof the suite can fail:** deliberately breaking the source (PNG keeps `tEXt`, MP4 forgets `udta`, FLAC drops its last byte) made it
fail with clear messages. When you add a handler, do the same mutation check for it.

### Smoke-test caveats
- Coordinates in `smoke_wine.sh` assume plain Xvfb (no window manager), the default 820x620 window and English UI. If you move a
  button or resize the confirm dialog, update the numbers.
- Wine does **not** emulate NTFS alternate data streams (it stores `file:stream` as a separate file), so `RemoveAlternateStreams`
  can only be verified on real NTFS. Do that by hand: `echo x > f.txt:Zone.Identifier`, run ClearMD, check `dir /r`.
- Wine timings are meaningless; for performance compare **CPU ticks** of the process (`/proc/PID/stat` fields 14+15) for old vs new
  builds under an identical `xdotool windowsize` loop. That is how the resize fix was measured.

## 5. Adding a new format - checklist

1. `enum class FileFormat`: add the value.
2. `kExtensions`: map extensions; `FormatToString`: friendly type label.
3. Write the handler **inside the portable core** (no Win32, no `windows.h` types). Decide buffered vs in-place (3.2).
   - Validate everything *before* producing output. Return `false` + a short `why` for anything malformed; **a failed handler must not
     have changed anything**.
   - Output must be **idempotent**: running it on its own output yields identical bytes.
   - Never decode and re-encode image / audio / video data. Copy or zero bytes only.
4. Dispatch: buffered -> add a `case` in `StripAny`; in-place -> add to `IsInPlaceFormat` **and** `PatchAny`.
5. File-dialog filters in `OnAddFiles`: update `kImages` / `kDocs` / `kMedia` **and** `kKnown`.
6. Tests: add the kind to `HARNESS_MAIN` and a sample + content check in `make_samples` in `tools/test_formats.py`; run it; run the mutation check.
7. Docs: README format table, RELEASE_NOTES, `cpp/README.md` code map if the structure changed.
8. `python tools/bump_version.py` -> `python tools/sync_viewer.py` -> rebuild -> `python tools/test_formats.py` -> (optionally) smoke test.

## 6. Invariants - do not break these

1. **A file that fails validation is never written.** Buffered: write temp, verify, then swap. In-place: dry run first.
2. **No re-encoding.** Pixels / samples / text content must be byte-identical or decode-identical after cleaning.
3. In-place patchers never change file length, never write during the dry run, bounds-check every read.
4. The worker thread never touches UI state or `g_files`.
5. Destructive action only after `ConfirmAndCountdown()` returned true. Keep **Cancel as the default button**, and keep the main
   window's "clear all metadata" button a plain `BS_PUSHBUTTON` (a default push button would let Enter trigger it).
6. Removing a list row never deletes a file on disk.
7. Zero compiler warnings with `-Wall -Wextra`; no third-party dependencies; the exe imports only system DLLs (`winhttp.dll` is loaded at run time for the update check, not added to the import table).
8. Removing rows / adding files must not make the UI O(n^2) - lists of tens of thousands of files are expected (`g_pathSet` is a hash set,
   bulk removal rebuilds the list once).

## 7. UI notes and hard-won gotchas

**Resize performance** (was laggy; keep it fast): `WM_SIZE` -> `UpdateLayout` moves all controls with one `DeferWindowPos` batch and only
resizes the **last** list column (`FitLastColumn`). Do **not** set widths of the other columns in `WM_SIZE`, do **not** use
`LVSCW_AUTOSIZE*` there, do **not** add `CS_HREDRAW | CS_VREDRAW`, keep `WS_CLIPCHILDREN`. Column widths for columns 0-3 are fixed
(`kDefaultColumnWidths`, scaled by DPI). The window minimum width (700) exists so the last column never drops below its minimum.

**DPI:** everything pixel-based goes through `Scale()`; fonts are rebuilt in `RebuildFonts()` and columns re-applied on `WM_DPICHANGED`.
`GetDpiForWindow` is loaded dynamically with a `GetDeviceCaps` fallback.

**Confirmation dialog:** a hand-built window (`ClearMDConfirmWindow`) with its own modal loop and `IsDialogMessage`, not a dialog resource.
The countdown uses `GetTickCount64` (not timer tick counts) so it is exactly 3 s. The progress bar is set to `pos+1` then `pos` to skip the
slow themed animation. Closing the window, Esc, or Cancel all mean "do nothing".

**Keyboard:** Delete and Ctrl+A are intercepted in the main message loop *before* `IsDialogMessageW`, so they work wherever focus is.

**Update check:** one `GET https://api.github.com/repos/finnuen/ClearMD/releases/latest` per launch, started after `ShowWindow` on a
detached thread. Only `tag_name` and `html_url` are read from the JSON; missing version parts count as 0, so releases must be tagged
with the build's full file version (`v1.0.0.7`) for the comparison to distinguish builds; a bare `v1.0` equals `1.0.0.0`. Any failure
(offline, 404 when no release exists, rate limit, proxy) is silent. A found update is posted as `WM_APP_UPDATE_FOUND` and shown with a
Yes/No prompt that opens the release page; nothing is downloaded. Keep it off the UI thread, and never add a static
`winhttp.lib` dependency - the functions are resolved from `winhttp.dll` at run time.

**Build gotchas:** missing `-luuid` -> unresolved `CLSID_FileOpenDialog`. Win32-thread MinGW has no `std::thread`. In CMake do not list
`manifest.xml` as a source (the `.rc` already embeds it -> duplicate-manifest link error on MSVC). `ifstream` with a `wstring` path needs
`fs::path(...)`. Avoid `swprintf_s` / `%s` in wide printf (MinGW vs MSVC differ) - build strings with `std::to_wstring` or `StringCchPrintfW`.

**Format gotchas:**
- JPEG: keep APP0 (JFIF), APP2 only if `ICC_PROFILE`, **APP14 (Adobe)** always (CMYK/YCCK decode needs it); data after EOI is dropped.
  The SOS scan must be copied by walking entropy data (progressive files have several scans).
- MP4: `meta` / `udta` are blanked by retyping the box to `free` and zeroing it. **Never run the MP4 cleaner on HEIC** - there `meta` holds
  the whole item table; `PatchHEIF` retypes only the Exif / XMP items and zeroes their extents.
- MKV: elements are replaced by EBML Void elements of identical total length; unknown-size clusters stop the walk.
- ZIP rewrite drops extra fields, archive comment and timestamps; ODF requires `mimetype` first and stored; OOXML thumbnails also need their
  relationship removed from `_rels/.rels`. Encrypted / ZIP64 packages are rejected.
- PDF: bails on `/Encrypt`; an `/Info` object living inside an object stream is *reported unsupported* (blanking in place is impossible) -
  this is tested and intentional. XMP is blanked inside the `<?xpacket ...?>` wrapper and replaced by an empty but valid `x:xmpmeta`.
- MP3 tail tags can appear in either order (ID3v1 then APE, or APE then ID3v1) - the loop peels both.
- WAV / AIFF / WebP chunk pad bytes: tolerate a missing final pad, re-add it when copying.

**Memory-mapped files:** `ProcessInPlace` maps the whole file. An I/O error on a mapped view raises a structured exception (e.g. a network
share dropping) that the code does not catch - see backlog.

## 8. Known gaps / backlog

- NTFS stream removal untested on real NTFS; MSVC and CMake builds unverified (see section 2 and 4).
- No SEH around memory-mapped views; in-place patching is not atomic (a crash mid-write could leave a half-patched but still same-length file).
- Not supported: TIFF, OGG/Opus, RAW, SVGZ, encrypted files, ZIP64; Word comment / tracked-change author names; PDFs with Info in object streams.
- No cancel button for a *running* batch (only for the 3-second countdown); no results export / log; no installer or code signing; English-only strings.
- Removing `Zone.Identifier` strips the "Mark of the Web" - consider making stream removal optional (checkbox) if users object.
- Unit tests exercise the portable core only; the Win32 pipeline (`ProcessInPlace/Buffered`, dialogs) is covered by the Wine smoke test, not by CI.

## 9. Conventions

- C++17, 4-space indent, `static` free functions, no classes unless a struct is enough. Comments explain *why* (invariants, format quirks), not what.
- Wide strings (`L"..."`) for everything user-visible; `std::string` only for file-format bytes / XML text.
- Error text from handlers (`why`) is short, user-readable and ends up in the status column as `Failed: <why> (file untouched)`.
- Keep the portable core free of Win32 so `tools/test_formats.py` keeps compiling it on Linux.
- Version: `1.0.0.x`, last digit +1 per build (`bump_version.py`); `APP_TITLE` ("ClearMD v1.0") changes only for real major/minor releases.

## 10. Definition of done for a change

- [ ] `-Wall -Wextra` build has **zero warnings**
- [ ] `python tools/test_formats.py` -> 0 failed (and not mostly SKIP)
- [ ] new / changed handler has a sample, a content check, and survived a mutation check
- [ ] UI change: `tools/smoke_wine.sh` passes (update coordinates if you moved controls)
- [ ] `python tools/bump_version.py`, build-history row in `RELEASE_NOTES.md`, README tables updated if behaviour changed
- [ ] `python tools/sync_viewer.py` (then `--check` is clean), `npx tsc --noEmit` and `npx vite build` pass
- [ ] ship the rebuilt `ClearMD.exe` together with the source zip
