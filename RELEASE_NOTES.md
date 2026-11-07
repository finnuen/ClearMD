# ClearMD v1.0 - Release notes

**Release:** v1.0 (file version 1.0.0.6), November 2026
**Platform:** Windows 10 / 11, 64-bit. Single portable `ClearMD.exe`, no installer.

ClearMD removes hidden personal metadata from files **without re-encoding** them, so images, audio, video and documents keep
their exact content.

---

## Highlights

- **Works on far more than images.** Photos, PDF, Word / Excel / PowerPoint, OpenDocument, audio, video, GIF, SVG, HEIC / AVIF.
- **Accepts any file.** Formats ClearMD doesn't know still get their NTFS alternate data streams (e.g. the "downloaded from the Internet" mark) removed.
- **Safety prompt.** A warning ("This app does not automatically create backup" / "Deleted metadata is unrecoverable") with **Proceed** / **Cancel**, followed by a **3-second cancellable progress bar** before anything is touched.
- **Handles large videos.** MP4, MKV, AVI and HEIC are cleaned in place, memory-mapped, so even multi-GB files need no extra RAM or disk space.
- **Smooth window resizing**, a **new app icon**, **Delete key and right-click menu**, and `ClearMD v1.0` in the title bar.

---

## New

### Formats
| Added | Formats |
|---|---|
| Documents | PDF; Office (docx, xlsx, pptx and macro / template variants); OpenDocument (odt, ods, odp, odg and templates) |
| Audio | MP3, FLAC, WAV, AIFF |
| Video / containers | MP4, M4A, MOV, 3GP, MKV, WebM, AVI |
| Images | GIF, SVG, HEIC / HEIF / AVIF (joining the original JPEG, PNG, WebP) |
| Any file | NTFS alternate data streams are removed from every file, including unsupported types |

### Interface
- Warning dialog with **Proceed** / **Cancel** (Cancel is the default button).
- **3-second progress bar** after Proceed with a live "Starting in N seconds" label; **Cancel** works until it completes.
- **Delete** key removes the selected rows from the list; **Ctrl+A** selects all; **right-click menu** with *Remove from list* and *Select all*. Removing rows never deletes files on disk.
- New application icon (document, broom and sparkles), embedded in the exe.
- Title bar shows the version: **ClearMD v1.0**.
- Checks GitHub for a newer release on every launch (the only network access) and offers to open its release page.
- Type column shows friendly names (Word Document, HEIC Image, TXT File ...). Files without embedded-metadata support show **Ready (streams only)**.
- Per-file results with clear reasons: `Cleaned (-1.5 KB)`, `Clean (no metadata found)`, `Failed: ... (file untouched)`.
- Tab-key navigation; Enter can no longer trigger the destructive button by accident.

---

## Improved

- **Resize performance.** Controls now move in one batch and only the last column follows the window width. In a Wine test with 3,000 rows, the same 180 resize steps used about 27x less CPU than before.
- **High-DPI.** Fonts, margins and columns scale with the monitor and re-scale when you move the window between monitors.
- **No empty column.** The status column now stretches to the window edge instead of leaving a blank strip that looked like an extra column.
- **Faster, safer file handling.** Whole-file reads are no longer byte-by-byte; duplicate detection is instant even with tens of thousands of files; long paths are supported.
- **Better JPEG cleaning.** APP3-APP13 / APP15 blocks and any data after the end-of-image marker are now removed; the Adobe colour block (APP14) is kept so CMYK images still decode.
- **Better PNG cleaning.** C2PA (`caBX`) content credentials are removed.
- **Better MP3 cleaning.** ID3v1 and APE tags are removed in either order at the end of the file.
- The web demo's download now contains every file needed to build the app, and its embedded source matches the real one.

---

## Fixed (compared with the original upload)

**Build**
- The source did not compile with MinGW (missing `<cstring>` and `-luuid`); fixed, and both build scripts and the README were corrected.
- The CMake build embedded the manifest twice, which breaks the MSVC link; fixed.
- `npm install` failed on an incompatible `esbuild` version; fixed.
- The web demo's "download C++ project" zip omitted `resource.h` and `manifest.xml`; fixed.

**Data safety**
- A truncated JPEG or PNG could be written back damaged; invalid files are now rejected and left untouched.
- A failed write (for example a full disk) could replace the original with a partial file; writes are now verified before the original is replaced.

**Stability**
- Dropping files onto the window during a batch could crash the app; the list is now locked while a batch runs, and the window cannot be closed mid-batch.
- The worker thread and the window no longer share the file list.

**Format edge cases**
- WebP files with a missing final pad byte or trailing junk are handled correctly.

---

## Known limitations

- Metadata is format-specific: "any file" means every supported format, plus file-system streams for the rest.
- Not supported: TIFF, OGG / Opus, RAW camera files, SVGZ, encrypted files, ZIP64 packages.
- Author names inside Word comments / tracked changes are not removed.
- PDFs with their info dictionary inside compressed object streams are reported as unsupported and left untouched.
- Rewritten formats are skipped above 1.5 GB (in-place formats have no limit).
- **No automatic backup and no undo.** Digitally signed PDFs / documents lose signature validity. Removing Exif from a JPEG can change how a rotated photo displays.
- Removing `Zone.Identifier` also removes the Windows "Mark of the Web", so SmartScreen will no longer warn about that file.

---

## Testing notes

- Each format handler was run on real files containing metadata (generated with ffmpeg, LibreOffice, python-docx, openpyxl, python-pptx, reportlab, pikepdf, pillow-heif and others). Results were checked for: metadata gone, content identical (decoded audio / video / pixels, document text and cell values), file still opens in its normal reader, running twice gives the same result, and truncated or random input is rejected without any write. Handlers were also run under AddressSanitizer / UndefinedBehaviorSanitizer.
- The full application was driven under Wine: adding files, right-click menu, Delete, Ctrl+A, the warning, cancelling at the prompt, cancelling during the countdown, a full run, and window resizing.
- **Not verified in this release:** NTFS alternate-data-stream removal on real NTFS (the test environment cannot emulate it), and the MSVC / CMake build scripts. The release `.exe` was built with MinGW-w64 GCC 13, warning-free.

---

## Build history (v1.0)

| Build | Changes |
|---|---|
| 1.0.0.1 | Original upload (images only; did not compile cleanly). |
| 1.0.0.2 | Build fixes, data-loss and crash fixes, JPEG / PNG / WebP corrections, DPI awareness. First working `.exe`. |
| 1.0.0.3 | PDF, Office, OpenDocument, MP3, FLAC, WAV, MP4 / MOV support; Delete key and right-click menu; app icon; extra column fix. |
| 1.0.0.4 | Any-file support (NTFS streams); GIF, SVG, HEIC / AVIF, AVI, MKV / WebM, AIFF; warning with Proceed / Cancel and 3-second cancellable countdown; resize performance; version in title bar. |
| 1.0.0.5 | Icon refinement (removed the bumps on the broom). |
| 1.0.0.6 | Checks GitHub for a newer release on every launch and offers to open its release page. Silent when offline or when no release exists. |
