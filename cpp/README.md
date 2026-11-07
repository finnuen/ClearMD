# ClearMD - native C++17 source

User documentation (features, supported formats, status messages, safety notes) is in the top-level
[README.md](../README.md). This file covers building and the code layout.

## Build

| Toolchain | Command (run inside this folder) |
|---|---|
| MinGW-w64 GCC | `build_mingw.bat` |
| MSVC | `build_msvc.bat` (from an *x64 Native Tools Command Prompt for VS*) |
| CMake | `mkdir build && cd build && cmake .. && cmake --build . --config Release` |

Manual MinGW-w64 command:
```cmd
windres ClearMD.rc -O coff -o ClearMD.res.o
g++ -Wall -Wextra -std=c++17 -O2 -s -municode -mwindows -static -static-libgcc -static-libstdc++ ClearMD.cpp ClearMD.res.o -lcomctl32 -lole32 -lshell32 -loleaut32 -lgdi32 -luser32 -luuid -o ClearMD.exe
```

The MinGW build needs the POSIX-threads variant of the toolchain (`std::thread`). Link order matters: `-luuid` is required
for the file-dialog class ids. The icon (`ClearMD.ico`) must sit next to `ClearMD.rc`.

## Code map (`ClearMD.cpp`)

| Section | Contents |
|---|---|
| Data structures, extension table | `FileFormat`, `kExtensions`, type labels |
| Chunk / container strippers | JPEG, PNG, WebP, GIF, SVG, AIFF, WAV, FLAC, MP3, PDF, ZIP (own DEFLATE reader, CRC-32) for Office / OpenDocument |
| In-place patchers (`Buf`) | MP4/MOV, HEIC/AVIF, MKV/WebM, AVI. Always run twice: dry run (validate only), then real. |
| Processing pipeline | `ProcessFile` -> `ProcessInPlace` (memory-mapped) or `ProcessBuffered` (temp file + `ReplaceFileW`), then `RemoveAlternateStreams` |
| Update check | background thread, `WinHTTP` loaded by name from `winhttp.dll`, reads `tag_name` / `html_url` from the GitHub releases API, posts `WM_APP_UPDATE_FOUND` to the UI thread |
| UI | list view, add / remove / drop handling, context menu, confirm dialog with countdown, DPI-aware layout |

Design rules: the worker thread only touches its own copy of the job list and posts results to the UI thread;
a file that fails validation is never written; no function re-encodes image, audio or video data.

## Versioning

`resource.h` holds the file version (`1.0.0.x`, last digit bumped per build) and the title-bar text (`APP_TITLE`, currently `ClearMD v1.0`).
`manifest.xml`, `CMakeLists.txt` and the docs carry the same number.

## Regenerating the icon

`python make_icon.py` (needs Pillow) redraws `ClearMD.ico` and a 256 px preview from code.
