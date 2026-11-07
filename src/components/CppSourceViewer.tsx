import React, { useState } from 'react';
import { Copy, Check, Download, Terminal, FileCode, CheckCircle2 } from 'lucide-react';
import { SimpleZip } from '../utils/zipWriter';

// Raw C++ code embedded for display and download
const CPP_CODE = `/**
 * ClearMD - Lossless Metadata Stripper (C++17 Standalone Windows Native Application)
 *
 * Fully standalone, zero external dependencies (uses native Win32/Shell APIs only).
 * Cross-compiler clean: MSVC (/W4) and MinGW-w64 (-Wall -Wextra).
 * Version: 1.0.0.6
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <strsafe.h>
#include <winhttp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <system_error>
#include <thread>
#include <unordered_set>
#include <vector>

#include "resource.h"

#if defined(_MSC_VER)
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "uuid.lib")
#endif

namespace fs = std::filesystem;

// -----------------------------------------------------------------------------
// Data Structures
// -----------------------------------------------------------------------------
enum class FileFormat {
    Unknown,
    JPEG,
    PNG,
    WebP,
    PDF,
    OOXML,   // .docx .xlsx .pptx ...
    ODF,     // .odt .ods .odp ...
    MP3,
    FLAC,
    WAV,
    MP4,     // .mp4 .m4a .m4v .mov .3gp
    GIF,
    SVG,
    AIFF,
    AVI,
    MKV,     // .mkv .mka .webm
    HEIF     // .heic .heif .avif
};

struct FileEntry {
    std::wstring path;
    std::wstring filename;
    std::wstring extension;
    std::wstring location;
    uintmax_t originalSize = 0;
    uintmax_t cleanedSize = 0;
    FileFormat format = FileFormat::Unknown;
    std::wstring status = L"Pending";
    bool processed = false;
    bool success = false;
};

// Work item handed to the worker thread (a private copy, so the UI thread's
// g_files vector is never touched from the worker).
struct Job {
    size_t index;
    std::wstring path;
    FileFormat format;
};

// Result posted back from the worker thread to the UI thread.
struct JobResult {
    size_t index = 0;
    std::wstring status;
    uintmax_t originalSize = 0;
    uintmax_t cleanedSize = 0;
    bool success = false;
};

// -----------------------------------------------------------------------------
// Global Application State
// -----------------------------------------------------------------------------
static HINSTANCE g_hInstance = nullptr;
static HWND g_hWndMain = nullptr;
static HWND g_hListView = nullptr;
static HWND g_hBtnAddFolder = nullptr;
static HWND g_hBtnAddFile = nullptr;
static HWND g_hBtnClearList = nullptr;
static HWND g_hBtnClearMetadata = nullptr;
static HWND g_hStatusBar = nullptr;
static HFONT g_hFont = nullptr;
static HFONT g_hFontBold = nullptr;
static UINT g_dpi = 96;

static std::vector<FileEntry> g_files;
static std::unordered_set<std::wstring> g_pathSet; // lower-cased paths, O(1) duplicate check
static std::atomic<bool> g_isProcessing{false};

// Custom Window Messages
#define WM_APP_UPDATE_ITEM   (WM_APP + 1)   // lParam = JobResult* (ownership transferred)
#define WM_APP_BATCH_DONE    (WM_APP + 2)   // wParam = ok count, lParam = failed count
#define WM_APP_UPDATE_FOUND  (WM_APP + 3)   // lParam = UpdateInfo* (ownership transferred)

// -----------------------------------------------------------------------------
// Helper Utilities
// -----------------------------------------------------------------------------
static int Scale(int v) {
    return MulDiv(v, static_cast<int>(g_dpi), 96);
}

static UINT QueryWindowDpi(HWND hWnd) {
    typedef UINT (WINAPI *GetDpiForWindowFn)(HWND);
    static GetDpiForWindowFn fn = reinterpret_cast<GetDpiForWindowFn>(
        reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow")));
    if (fn && hWnd) {
        UINT d = fn(hWnd);
        if (d) return d;
    }
    HDC dc = GetDC(nullptr);
    int d = dc ? GetDeviceCaps(dc, LOGPIXELSX) : 96;
    if (dc) ReleaseDC(nullptr, dc);
    return d > 0 ? static_cast<UINT>(d) : 96u;
}

static std::wstring FormatFileSize(uintmax_t bytes) {
    wchar_t buf[48];
    if (bytes < 1024) {
        return std::to_wstring(bytes) + L" B";
    } else if (bytes < 1024ULL * 1024) {
        StringCchPrintfW(buf, ARRAYSIZE(buf), L"%.1f KB", static_cast<double>(bytes) / 1024.0);
    } else if (bytes < 1024ULL * 1024 * 1024) {
        StringCchPrintfW(buf, ARRAYSIZE(buf), L"%.2f MB", static_cast<double>(bytes) / (1024.0 * 1024.0));
    } else {
        StringCchPrintfW(buf, ARRAYSIZE(buf), L"%.2f GB", static_cast<double>(bytes) / (1024.0 * 1024.0 * 1024.0));
    }
    return buf;
}

static std::wstring ToLower(std::wstring s) {
    for (auto& ch : s) ch = static_cast<wchar_t>(towlower(ch));
    return s;
}

struct ExtMap { const wchar_t* ext; FileFormat fmt; };
static const ExtMap kExtensions[] = {
    { L".jpg", FileFormat::JPEG }, { L".jpeg", FileFormat::JPEG }, { L".jpe", FileFormat::JPEG }, { L".jfif", FileFormat::JPEG },
    { L".png", FileFormat::PNG }, { L".webp", FileFormat::WebP },
    { L".pdf", FileFormat::PDF },
    { L".docx", FileFormat::OOXML }, { L".docm", FileFormat::OOXML }, { L".dotx", FileFormat::OOXML }, { L".dotm", FileFormat::OOXML },
    { L".xlsx", FileFormat::OOXML }, { L".xlsm", FileFormat::OOXML }, { L".xltx", FileFormat::OOXML }, { L".xltm", FileFormat::OOXML },
    { L".pptx", FileFormat::OOXML }, { L".pptm", FileFormat::OOXML }, { L".potx", FileFormat::OOXML }, { L".potm", FileFormat::OOXML },
    { L".ppsx", FileFormat::OOXML }, { L".ppsm", FileFormat::OOXML },
    { L".odt", FileFormat::ODF }, { L".ods", FileFormat::ODF }, { L".odp", FileFormat::ODF }, { L".odg", FileFormat::ODF },
    { L".ott", FileFormat::ODF }, { L".ots", FileFormat::ODF }, { L".otp", FileFormat::ODF },
    { L".mp3", FileFormat::MP3 }, { L".flac", FileFormat::FLAC }, { L".wav", FileFormat::WAV },
    { L".mp4", FileFormat::MP4 }, { L".m4a", FileFormat::MP4 }, { L".m4b", FileFormat::MP4 }, { L".m4v", FileFormat::MP4 },
    { L".mov", FileFormat::MP4 }, { L".3gp", FileFormat::MP4 }, { L".3g2", FileFormat::MP4 },
    { L".gif", FileFormat::GIF }, { L".svg", FileFormat::SVG },
    { L".aif", FileFormat::AIFF }, { L".aiff", FileFormat::AIFF }, { L".aifc", FileFormat::AIFF },
    { L".avi", FileFormat::AVI },
    { L".mkv", FileFormat::MKV }, { L".mka", FileFormat::MKV }, { L".mk3d", FileFormat::MKV }, { L".webm", FileFormat::MKV },
    { L".heic", FileFormat::HEIF }, { L".heif", FileFormat::HEIF }, { L".hif", FileFormat::HEIF }, { L".avif", FileFormat::HEIF },
};

static FileFormat DetectFileFormat(const std::wstring& ext) {
    const std::wstring lowerExt = ToLower(ext);
    for (const auto& m : kExtensions) {
        if (lowerExt == m.ext) return m.fmt;
    }
    return FileFormat::Unknown;
}

static std::wstring FormatToString(FileFormat fmt, const std::wstring& ext) {
    const std::wstring e = ToLower(ext);
    switch (fmt) {
        case FileFormat::JPEG: return L"JPEG Image";
        case FileFormat::PNG:  return L"PNG Image";
        case FileFormat::WebP: return L"WebP Image";
        case FileFormat::PDF:  return L"PDF Document";
        case FileFormat::OOXML:
            if (e.compare(0, 4, L".doc") == 0 || e.compare(0, 4, L".dot") == 0) return L"Word Document";
            if (e.compare(0, 3, L".xl") == 0) return L"Excel Workbook";
            if (e.compare(0, 3, L".pp") == 0 || e.compare(0, 4, L".pot") == 0) return L"PowerPoint Presentation";
            return L"Office Document";
        case FileFormat::ODF:
            if (e == L".odt" || e == L".ott") return L"OpenDocument Text";
            if (e == L".ods" || e == L".ots") return L"OpenDocument Spreadsheet";
            if (e == L".odp" || e == L".otp") return L"OpenDocument Presentation";
            return L"OpenDocument Drawing";
        case FileFormat::MP3:  return L"MP3 Audio";
        case FileFormat::FLAC: return L"FLAC Audio";
        case FileFormat::WAV:  return L"WAV Audio";
        case FileFormat::MP4:
            if (e == L".m4a" || e == L".m4b") return L"MP4 Audio";
            if (e == L".mov") return L"QuickTime Video";
            return L"MP4 Video";
        case FileFormat::GIF:  return L"GIF Image";
        case FileFormat::SVG:  return L"SVG Image";
        case FileFormat::AIFF: return L"AIFF Audio";
        case FileFormat::AVI:  return L"AVI Video";
        case FileFormat::MKV:
            if (e == L".mka") return L"Matroska Audio";
            if (e == L".webm") return L"WebM Video";
            return L"Matroska Video";
        case FileFormat::HEIF:
            if (e == L".avif") return L"AVIF Image";
            return L"HEIC Image";
        default: {
            if (e.size() > 1 && e.size() <= 9) {
                std::wstring up = e.substr(1);
                for (auto& c : up) c = static_cast<wchar_t>(towupper(c));
                return up + L" File";
            }
            return L"File";
        }
    }
}

// >>> PORTABLE-CORE-BEGIN  (format handlers: standard C++ only, no Win32 - tools/test_formats.py compiles this region on Linux)
static bool Tag4(const uint8_t* p, const char* tag) {
    return std::memcmp(p, tag, 4) == 0;
}

// -----------------------------------------------------------------------------
// Lossless Metadata Stripping Core (Zero Re-encoding)
// -----------------------------------------------------------------------------

/**
 * Strips JPEG metadata without recompression.
 * Keeps: SOI, DQT, DHT, SOFn, DRI, SOS + entropy data (all scans, so progressive works),
 *        APP0 (JFIF), APP2 ICC_PROFILE, APP14 (Adobe - needed for correct CMYK/YCCK decoding), EOI.
 * Strips: APP1 (Exif/XMP), APP3..APP13 (IPTC/Photoshop, vendor blocks), APP15, COM,
 *         non-ICC APP2 (FlashPix/MPF), and anything stray after EOI.
 * Returns false (and leaves the file untouched) if the file is not a well-formed JPEG.
 */
static bool StripMetadataJPEG(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst) {
    const size_t total = src.size();
    if (total < 4) return false;
    if (src[0] != 0xFF || src[1] != 0xD8) return false;

    dst.clear();
    dst.reserve(total);
    dst.push_back(0xFF);
    dst.push_back(0xD8);

    size_t i = 2;
    bool sawScan = false;

    while (i < total) {
        if (src[i] != 0xFF) { i++; continue; }          // garbage between segments
        while (i < total && src[i] == 0xFF) i++;        // skip fill bytes
        if (i >= total) break;

        const uint8_t marker = src[i++];
        if (marker == 0x00) continue;

        if (marker == 0xD9) {                            // EOI
            dst.push_back(0xFF);
            dst.push_back(0xD9);
            break;
        }

        // Standalone markers (no length): TEM, RSTn, SOI
        if (marker == 0x01 || marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7)) {
            dst.push_back(0xFF);
            dst.push_back(marker);
            continue;
        }

        if (i + 2 > total) return false;
        const size_t length = (static_cast<size_t>(src[i]) << 8) | src[i + 1];
        if (length < 2 || i + length > total) return false; // corrupt / truncated

        bool strip = false;
        if (marker == 0xFE) {                            // COM
            strip = true;
        } else if (marker >= 0xE1 && marker <= 0xEF && marker != 0xEE) {
            // APP1..APP15 except APP14 (Adobe colour transform)
            strip = true;
            if (marker == 0xE2 && length >= 14 &&
                std::memcmp(&src[i + 2], "ICC_PROFILE\\0", 12) == 0) {
                strip = false;                           // keep colour profile
            }
        }

        if (!strip) {
            dst.push_back(0xFF);
            dst.push_back(marker);
            dst.insert(dst.end(), src.begin() + static_cast<std::ptrdiff_t>(i),
                                  src.begin() + static_cast<std::ptrdiff_t>(i + length));
        }
        i += length;

        if (marker == 0xDA) {                            // SOS: copy entropy-coded data verbatim
            sawScan = true;
            size_t j = i;
            while (j < total) {
                if (src[j] == 0xFF) {
                    if (j + 1 >= total) { j++; break; }
                    const uint8_t n = src[j + 1];
                    if (n == 0x00 || (n >= 0xD0 && n <= 0xD7)) { j += 2; continue; } // stuffing / RSTn
                    if (n == 0xFF) { j++; continue; }                                  // fill
                    break;                                                             // real marker
                }
                j++;
            }
            dst.insert(dst.end(), src.begin() + static_cast<std::ptrdiff_t>(i),
                                  src.begin() + static_cast<std::ptrdiff_t>(j));
            i = j;
        }
    }

    return sawScan;
}

/**
 * Strips PNG metadata chunks without touching image data.
 * Strips: tEXt, zTXt, iTXt (incl. XMP), eXIf, tIME, dSIG, caBX (C2PA manifest).
 * Returns false if the file is not a complete PNG (no IEND), so truncated files are never rewritten.
 */
static bool StripMetadataPNG(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst) {
    static const uint8_t pngSig[8] = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
    const size_t total = src.size();
    if (total < 8 || std::memcmp(src.data(), pngSig, 8) != 0) return false;

    dst.clear();
    dst.reserve(total);
    dst.insert(dst.end(), pngSig, pngSig + 8);

    size_t i = 8;
    bool sawIHDR = false;
    bool sawIEND = false;

    while (i + 12 <= total) {
        const uint64_t length = (static_cast<uint64_t>(src[i]) << 24) |
                                (static_cast<uint64_t>(src[i + 1]) << 16) |
                                (static_cast<uint64_t>(src[i + 2]) << 8) |
                                 static_cast<uint64_t>(src[i + 3]);
        const uint64_t chunkTotal = 12 + length;
        if (i + chunkTotal > total) return false; // truncated chunk

        const uint8_t* type = &src[i + 4];
        if (Tag4(type, "IHDR")) sawIHDR = true;

        const bool isMetadata = Tag4(type, "tEXt") || Tag4(type, "zTXt") || Tag4(type, "iTXt") ||
                                Tag4(type, "eXIf") || Tag4(type, "tIME") || Tag4(type, "dSIG") ||
                                Tag4(type, "caBX");

        if (!isMetadata) {
            dst.insert(dst.end(),
                       src.begin() + static_cast<std::ptrdiff_t>(i),
                       src.begin() + static_cast<std::ptrdiff_t>(i + chunkTotal));
        }

        i += static_cast<size_t>(chunkTotal);
        if (Tag4(type, "IEND")) { sawIEND = true; break; }
    }

    return sawIHDR && sawIEND;
}

/**
 * Strips WebP EXIF and XMP chunks losslessly, fixes the RIFF size and the VP8X feature flags.
 */
static bool StripMetadataWebP(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst) {
    if (src.size() < 12) return false;
    if (std::memcmp(src.data(), "RIFF", 4) != 0 || std::memcmp(src.data() + 8, "WEBP", 4) != 0) {
        return false;
    }

    // Honour the declared RIFF size (ignore trailing junk after the RIFF payload)
    const uint64_t declared = static_cast<uint64_t>(src[4]) | (static_cast<uint64_t>(src[5]) << 8) |
                              (static_cast<uint64_t>(src[6]) << 16) | (static_cast<uint64_t>(src[7]) << 24);
    size_t total = src.size();
    if (declared + 8 < total) total = static_cast<size_t>(declared + 8);
    if (total < 12) return false;

    dst.clear();
    dst.reserve(total);
    dst.insert(dst.end(), src.begin(), src.begin() + 12);

    size_t i = 12;
    size_t vp8xOffsetInDst = 0;
    bool hasVp8x = false;
    bool sawImageData = false;

    while (i + 8 <= total) {
        const uint8_t* fourCC = &src[i];
        const uint64_t chunkSize = static_cast<uint64_t>(src[i + 4]) | (static_cast<uint64_t>(src[i + 5]) << 8) |
                                   (static_cast<uint64_t>(src[i + 6]) << 16) | (static_cast<uint64_t>(src[i + 7]) << 24);
        if (i + 8 + chunkSize > total) return false; // truncated chunk

        const size_t pad = (chunkSize & 1) ? 1 : 0;
        const size_t payloadEnd = i + 8 + static_cast<size_t>(chunkSize);
        const size_t chunkEnd = std::min(payloadEnd + pad, total); // tolerate a missing final pad byte

        const bool isMetadata = Tag4(fourCC, "EXIF") || Tag4(fourCC, "XMP ");

        if (Tag4(fourCC, "VP8X")) {
            hasVp8x = true;
            vp8xOffsetInDst = dst.size();
        }
        if (Tag4(fourCC, "VP8 ") || Tag4(fourCC, "VP8L") || Tag4(fourCC, "ANMF")) sawImageData = true;

        if (!isMetadata) {
            dst.insert(dst.end(),
                       src.begin() + static_cast<std::ptrdiff_t>(i),
                       src.begin() + static_cast<std::ptrdiff_t>(chunkEnd));
            if (pad && chunkEnd < payloadEnd + pad) dst.push_back(0); // keep RIFF even-aligned
        }

        i = chunkEnd;
    }

    if (!sawImageData) return false;

    const uint32_t riffSize = static_cast<uint32_t>(dst.size() - 8);
    dst[4] = static_cast<uint8_t>(riffSize & 0xFF);
    dst[5] = static_cast<uint8_t>((riffSize >> 8) & 0xFF);
    dst[6] = static_cast<uint8_t>((riffSize >> 16) & 0xFF);
    dst[7] = static_cast<uint8_t>((riffSize >> 24) & 0xFF);

    // VP8X flags: bit 3 = EXIF, bit 2 = XMP
    if (hasVp8x && vp8xOffsetInDst + 9 <= dst.size()) {
        dst[vp8xOffsetInDst + 8] &= static_cast<uint8_t>(~0x0C);
    }

    return true;
}

// -----------------------------------------------------------------------------
// Binary helpers
// -----------------------------------------------------------------------------
static uint32_t RdBE32(const uint8_t* p) {
    return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
           (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}
static uint64_t RdBE64(const uint8_t* p) {
    return (static_cast<uint64_t>(RdBE32(p)) << 32) | RdBE32(p + 4);
}
static uint32_t RdLE32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
static uint16_t RdLE16(const uint8_t* p) {
    return static_cast<uint16_t>(p[0] | (p[1] << 8));
}
static void PutLE16(std::vector<uint8_t>& v, uint32_t x) {
    v.push_back(static_cast<uint8_t>(x & 0xFF));
    v.push_back(static_cast<uint8_t>((x >> 8) & 0xFF));
}
static void PutLE32(std::vector<uint8_t>& v, uint32_t x) {
    PutLE16(v, x & 0xFFFF);
    PutLE16(v, x >> 16);
}
static void PutBytes(std::vector<uint8_t>& v, const void* p, size_t n) {
    const uint8_t* b = static_cast<const uint8_t*>(p);
    v.insert(v.end(), b, b + n);
}
static bool StartsWith(const std::string& s, const char* prefix) {
    return s.compare(0, std::strlen(prefix), prefix) == 0;
}

static uint32_t Crc32(const uint8_t* data, size_t n) {
    static const std::array<uint32_t, 256> table = [] {
        std::array<uint32_t, 256> t{};
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
            t[i] = c;
        }
        return t;
    }();
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) c = table[(c ^ data[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

// -----------------------------------------------------------------------------
// Minimal DEFLATE decoder (RFC 1951) - only used to read small XML parts of
// Office / OpenDocument packages so they can be edited.
// -----------------------------------------------------------------------------
struct InflState {
    const uint8_t* in;
    size_t inLen;
    size_t inPos;
    uint32_t bitBuf;
    int bitCnt;
    std::vector<uint8_t>* out;
};
struct Huff {
    uint16_t count[16];
    uint16_t symbol[288];
};

static int InflBits(InflState& s, int need) {
    uint32_t val = s.bitBuf;
    while (s.bitCnt < need) {
        if (s.inPos >= s.inLen) return -1;
        val |= static_cast<uint32_t>(s.in[s.inPos++]) << s.bitCnt;
        s.bitCnt += 8;
    }
    s.bitBuf = val >> need;
    s.bitCnt -= need;
    return static_cast<int>(val & ((1u << need) - 1));
}

static int HuffBuild(Huff& h, const uint16_t* length, int n) {
    for (int l = 0; l <= 15; l++) h.count[l] = 0;
    for (int sym = 0; sym < n; sym++) h.count[length[sym]]++;
    if (h.count[0] == n) return 0;
    int left = 1;
    for (int l = 1; l <= 15; l++) {
        left <<= 1;
        left -= h.count[l];
        if (left < 0) return left;
    }
    uint16_t offs[16];
    offs[1] = 0;
    for (int l = 1; l < 15; l++) offs[l + 1] = static_cast<uint16_t>(offs[l] + h.count[l]);
    for (int sym = 0; sym < n; sym++) {
        if (length[sym] != 0) h.symbol[offs[length[sym]]++] = static_cast<uint16_t>(sym);
    }
    return left;
}

static int HuffDecode(InflState& s, const Huff& h) {
    int code = 0, first = 0, index = 0;
    for (int len = 1; len <= 15; len++) {
        int b = InflBits(s, 1);
        if (b < 0) return -1;
        code |= b;
        int count = h.count[len];
        if (code - count < first) return h.symbol[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
    }
    return -2;
}

static bool InflateCodes(InflState& s, const Huff& lc, const Huff& dc) {
    static const uint16_t lens[29] = { 3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258 };
    static const uint16_t lext[29] = { 0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0 };
    static const uint16_t dists[30] = { 1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577 };
    static const uint16_t dext[30] = { 0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13 };
    int sym;
    do {
        sym = HuffDecode(s, lc);
        if (sym < 0) return false;
        if (sym < 256) {
            s.out->push_back(static_cast<uint8_t>(sym));
        } else if (sym > 256) {
            sym -= 257;
            if (sym >= 29) return false;
            int e = InflBits(s, lext[sym]);
            if (e < 0) return false;
            const int len = lens[sym] + e;
            const int ds = HuffDecode(s, dc);
            if (ds < 0 || ds >= 30) return false;
            e = InflBits(s, dext[ds]);
            if (e < 0) return false;
            const size_t dist = static_cast<size_t>(dists[ds]) + static_cast<size_t>(e);
            if (dist > s.out->size()) return false;
            const size_t from = s.out->size() - dist;
            for (int k = 0; k < len; k++) {
                const uint8_t v = (*s.out)[from + static_cast<size_t>(k)];
                s.out->push_back(v);
            }
        }
        if (s.out->size() > (64u << 20)) return false;
    } while (sym != 256);
    return true;
}

static bool Inflate(const uint8_t* in, size_t n, std::vector<uint8_t>& out) {
    InflState s{ in, n, 0, 0, 0, &out };
    out.clear();
    int last;
    do {
        last = InflBits(s, 1);
        const int type = InflBits(s, 2);
        if (last < 0 || type < 0) return false;
        if (type == 0) {
            s.bitBuf = 0;
            s.bitCnt = 0;
            if (s.inPos + 4 > n) return false;
            const unsigned len = in[s.inPos] | (in[s.inPos + 1] << 8);
            const unsigned nlen = in[s.inPos + 2] | (in[s.inPos + 3] << 8);
            s.inPos += 4;
            if (len != (~nlen & 0xFFFFu)) return false;
            if (s.inPos + len > n) return false;
            out.insert(out.end(), in + s.inPos, in + s.inPos + len);
            s.inPos += len;
        } else if (type == 1) {
            uint16_t lengths[288];
            int k = 0;
            for (; k < 144; k++) lengths[k] = 8;
            for (; k < 256; k++) lengths[k] = 9;
            for (; k < 280; k++) lengths[k] = 7;
            for (; k < 288; k++) lengths[k] = 8;
            Huff lc, dc;
            HuffBuild(lc, lengths, 288);
            for (k = 0; k < 30; k++) lengths[k] = 5;
            HuffBuild(dc, lengths, 30);
            if (!InflateCodes(s, lc, dc)) return false;
        } else if (type == 2) {
            const int nlen = InflBits(s, 5) + 257;
            const int ndist = InflBits(s, 5) + 1;
            const int ncode = InflBits(s, 4) + 4;
            if (nlen < 257 || ndist < 1 || ncode < 4 || nlen > 286 || ndist > 30) return false;
            static const uint8_t order[19] = { 16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15 };
            uint16_t lengths[320];
            int idx = 0;
            for (; idx < ncode; idx++) {
                const int v = InflBits(s, 3);
                if (v < 0) return false;
                lengths[order[idx]] = static_cast<uint16_t>(v);
            }
            for (; idx < 19; idx++) lengths[order[idx]] = 0;
            Huff lc, dc;
            if (HuffBuild(lc, lengths, 19) != 0) return false;
            idx = 0;
            while (idx < nlen + ndist) {
                int sym = HuffDecode(s, lc);
                if (sym < 0) return false;
                if (sym < 16) {
                    lengths[idx++] = static_cast<uint16_t>(sym);
                } else {
                    uint16_t prev = 0;
                    int rep;
                    if (sym == 16) {
                        if (idx == 0) return false;
                        prev = lengths[idx - 1];
                        rep = InflBits(s, 2);
                        if (rep < 0) return false;
                        rep += 3;
                    } else if (sym == 17) {
                        rep = InflBits(s, 3);
                        if (rep < 0) return false;
                        rep += 3;
                    } else {
                        rep = InflBits(s, 7);
                        if (rep < 0) return false;
                        rep += 11;
                    }
                    if (idx + rep > nlen + ndist) return false;
                    while (rep--) lengths[idx++] = prev;
                }
            }
            if (lengths[256] == 0) return false;
            int err = HuffBuild(lc, lengths, nlen);
            if (err < 0 || (err > 0 && nlen - lc.count[0] != 1)) return false;
            err = HuffBuild(dc, lengths + nlen, ndist);
            if (err < 0 || (err > 0 && ndist - dc.count[0] != 1)) return false;
            if (!InflateCodes(s, lc, dc)) return false;
        } else {
            return false;
        }
    } while (!last);
    return true;
}

// -----------------------------------------------------------------------------
// ZIP container (read central directory, rewrite without touching entry payloads)
// -----------------------------------------------------------------------------
struct ZipEntry {
    std::string name;
    uint16_t madeBy = 20, needed = 20, flags = 0, method = 0, intAttr = 0;
    uint32_t crc = 0, csize = 0, usize = 0, extAttr = 0;
    size_t dataOff = 0;
    bool removed = false;
    bool replaced = false;
    std::vector<uint8_t> newData;
};

static bool ZipParse(const std::vector<uint8_t>& z, std::vector<ZipEntry>& ents, std::wstring& why) {
    const size_t n = z.size();
    if (n < 22) { why = L"Not a ZIP-based document"; return false; }
    size_t eocd = std::string::npos;
    const size_t lowest = n > 22 + 65535 ? n - 22 - 65535 : 0;
    for (size_t i = n - 22 + 1; i-- > lowest;) {
        if (RdLE32(&z[i]) == 0x06054B50u) { eocd = i; break; }
    }
    if (eocd == std::string::npos) { why = L"Not a ZIP-based document"; return false; }

    const uint32_t count = RdLE16(&z[eocd + 10]);
    const uint32_t cdSize = RdLE32(&z[eocd + 12]);
    const uint32_t cdOff = RdLE32(&z[eocd + 16]);
    if (count == 0xFFFF || cdOff == 0xFFFFFFFFu || cdSize == 0xFFFFFFFFu) { why = L"ZIP64 packages are not supported"; return false; }
    if (static_cast<uint64_t>(cdOff) + cdSize > n) { why = L"Corrupt ZIP directory"; return false; }

    size_t p = cdOff;
    const size_t cdEnd = static_cast<size_t>(cdOff) + cdSize;
    for (uint32_t i = 0; i < count; i++) {
        if (p + 46 > cdEnd || RdLE32(&z[p]) != 0x02014B50u) { why = L"Corrupt ZIP directory"; return false; }
        ZipEntry e;
        e.madeBy = RdLE16(&z[p + 4]);
        e.needed = RdLE16(&z[p + 6]);
        e.flags = RdLE16(&z[p + 8]);
        e.method = RdLE16(&z[p + 10]);
        e.crc = RdLE32(&z[p + 16]);
        e.csize = RdLE32(&z[p + 20]);
        e.usize = RdLE32(&z[p + 24]);
        const size_t nameLen = RdLE16(&z[p + 28]);
        const size_t extraLen = RdLE16(&z[p + 30]);
        const size_t commentLen = RdLE16(&z[p + 32]);
        e.intAttr = RdLE16(&z[p + 36]);
        e.extAttr = RdLE32(&z[p + 38]);
        const uint32_t localOff = RdLE32(&z[p + 42]);
        if (p + 46 + nameLen + extraLen + commentLen > cdEnd) { why = L"Corrupt ZIP directory"; return false; }
        e.name.assign(reinterpret_cast<const char*>(&z[p + 46]), nameLen);
        if (e.flags & 1) { why = L"Encrypted or password-protected document"; return false; }
        if (e.csize == 0xFFFFFFFFu || e.usize == 0xFFFFFFFFu || localOff == 0xFFFFFFFFu) { why = L"ZIP64 packages are not supported"; return false; }
        if (static_cast<uint64_t>(localOff) + 30 > n || RdLE32(&z[localOff]) != 0x04034B50u) { why = L"Corrupt ZIP entry"; return false; }
        const size_t lName = RdLE16(&z[localOff + 26]);
        const size_t lExtra = RdLE16(&z[localOff + 28]);
        e.dataOff = static_cast<size_t>(localOff) + 30 + lName + lExtra;
        if (static_cast<uint64_t>(e.dataOff) + e.csize > n) { why = L"Corrupt ZIP entry"; return false; }
        ents.push_back(std::move(e));
        p += 46 + nameLen + extraLen + commentLen;
    }
    return true;
}

static bool ZipRead(const std::vector<uint8_t>& z, const ZipEntry& e, std::string& text) {
    if (e.replaced) { text.assign(e.newData.begin(), e.newData.end()); return true; }
    if (e.method == 0) {
        text.assign(reinterpret_cast<const char*>(&z[e.dataOff]), e.csize);
        return true;
    }
    if (e.method == 8) {
        std::vector<uint8_t> raw;
        if (!Inflate(&z[e.dataOff], e.csize, raw)) return false;
        text.assign(raw.begin(), raw.end());
        return true;
    }
    return false;
}

static void ZipSetText(ZipEntry& e, const std::string& text) {
    e.newData.assign(text.begin(), text.end());
    e.replaced = true;
}

static void ZipBuild(const std::vector<uint8_t>& z, const std::vector<ZipEntry>& ents, std::vector<uint8_t>& dst) {
    dst.clear();
    dst.reserve(z.size());
    std::vector<uint32_t> offsets(ents.size(), 0);

    // Entries are re-emitted with their original compressed bytes. Names are kept; DOS timestamps,
    // "extra" fields (extended timestamps, owner ids) and the archive comment are dropped.
    for (size_t i = 0; i < ents.size(); i++) {
        const ZipEntry& e = ents[i];
        if (e.removed) continue;
        offsets[i] = static_cast<uint32_t>(dst.size());

        const uint8_t* data;
        size_t clen;
        uint16_t method;
        uint32_t crc, usize;
        if (e.replaced) {
            data = e.newData.data();
            clen = e.newData.size();
            method = 0;
            crc = Crc32(data, clen);
            usize = static_cast<uint32_t>(clen);
        } else {
            data = e.csize ? &z[e.dataOff] : nullptr;
            clen = e.csize;
            method = e.method;
            crc = e.crc;
            usize = e.usize;
        }
        const uint16_t flags = static_cast<uint16_t>(e.flags & 0x0806);
        PutLE32(dst, 0x04034B50u);
        PutLE16(dst, e.replaced ? 20 : e.needed);
        PutLE16(dst, flags);
        PutLE16(dst, method);
        PutLE16(dst, 0);       // time
        PutLE16(dst, 0x0021);  // date: 1980-01-01
        PutLE32(dst, crc);
        PutLE32(dst, static_cast<uint32_t>(clen));
        PutLE32(dst, usize);
        PutLE16(dst, static_cast<uint32_t>(e.name.size()));
        PutLE16(dst, 0);
        PutBytes(dst, e.name.data(), e.name.size());
        if (clen) PutBytes(dst, data, clen);
    }

    const uint32_t cdOff = static_cast<uint32_t>(dst.size());
    uint32_t kept = 0;
    for (size_t i = 0; i < ents.size(); i++) {
        const ZipEntry& e = ents[i];
        if (e.removed) continue;
        kept++;
        uint32_t crc, csize, usize;
        uint16_t method;
        if (e.replaced) {
            crc = Crc32(e.newData.data(), e.newData.size());
            csize = usize = static_cast<uint32_t>(e.newData.size());
            method = 0;
        } else {
            crc = e.crc; csize = e.csize; usize = e.usize; method = e.method;
        }
        PutLE32(dst, 0x02014B50u);
        PutLE16(dst, e.madeBy);
        PutLE16(dst, e.replaced ? 20 : e.needed);
        PutLE16(dst, e.flags & 0x0806);
        PutLE16(dst, method);
        PutLE16(dst, 0);
        PutLE16(dst, 0x0021);
        PutLE32(dst, crc);
        PutLE32(dst, csize);
        PutLE32(dst, usize);
        PutLE16(dst, static_cast<uint32_t>(e.name.size()));
        PutLE16(dst, 0);
        PutLE16(dst, 0);
        PutLE16(dst, 0);
        PutLE16(dst, e.intAttr);
        PutLE32(dst, e.extAttr);
        PutLE32(dst, offsets[i]);
        PutBytes(dst, e.name.data(), e.name.size());
    }
    const uint32_t cdSize = static_cast<uint32_t>(dst.size()) - cdOff;
    PutLE32(dst, 0x06054B50u);
    PutLE16(dst, 0);
    PutLE16(dst, 0);
    PutLE16(dst, kept);
    PutLE16(dst, kept);
    PutLE32(dst, cdSize);
    PutLE32(dst, cdOff);
    PutLE16(dst, 0);
}

// Removes self-closing XML elements that start with \`startTag\` and whose text contains \`needle\`.
static void RemoveXmlElements(std::string& xml, const char* startTag, const char* needle) {
    size_t pos = 0;
    while ((pos = xml.find(startTag, pos)) != std::string::npos) {
        const size_t end = xml.find('>', pos);
        if (end == std::string::npos) break;
        if (end > pos && xml[end - 1] == '/' &&
            xml.substr(pos, end - pos + 1).find(needle) != std::string::npos) {
            xml.erase(pos, end - pos + 1);
            continue;
        }
        pos = end + 1;
    }
}

static ZipEntry* ZipFind(std::vector<ZipEntry>& ents, const char* name) {
    for (auto& e : ents) if (e.name == name) return &e;
    return nullptr;
}

/**
 * Office Open XML (.docx/.xlsx/.pptx and macro/template variants).
 * Resets document properties (author, last-modified-by, company, manager, dates, template,
 * statistics, custom properties) and removes the embedded page thumbnail. Document content,
 * styles and every other part are copied byte-for-byte.
 * Not covered: author names inside comments / tracked changes.
 */
static bool StripMetadataOOXML(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    std::vector<ZipEntry> ents;
    if (!ZipParse(src, ents, why)) return false;
    if (!ZipFind(ents, "[Content_Types].xml")) { why = L"Not an Office Open XML document"; return false; }

    static const char kCore[] =
        "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\" standalone=\\"yes\\"?>\\r\\n"
        "<cp:coreProperties xmlns:cp=\\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\\" "
        "xmlns:dc=\\"http://purl.org/dc/elements/1.1/\\" xmlns:dcterms=\\"http://purl.org/dc/terms/\\" "
        "xmlns:dcmitype=\\"http://purl.org/dc/dcmitype/\\" xmlns:xsi=\\"http://www.w3.org/2001/XMLSchema-instance\\"/>";
    static const char kApp[] =
        "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\" standalone=\\"yes\\"?>\\r\\n"
        "<Properties xmlns=\\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\\" "
        "xmlns:vt=\\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\\"/>";
    static const char kCustom[] =
        "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\" standalone=\\"yes\\"?>\\r\\n"
        "<Properties xmlns=\\"http://schemas.openxmlformats.org/officeDocument/2006/custom-properties\\" "
        "xmlns:vt=\\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\\"/>";

    bool thumbRemoved = false;
    for (auto& e : ents) {
        if (e.name == "docProps/core.xml") ZipSetText(e, kCore);
        else if (e.name == "docProps/app.xml") ZipSetText(e, kApp);
        else if (e.name == "docProps/custom.xml") ZipSetText(e, kCustom);
        else if (StartsWith(e.name, "docProps/thumbnail.")) { e.removed = true; thumbRemoved = true; }
    }

    if (thumbRemoved) {
        ZipEntry* rels = ZipFind(ents, "_rels/.rels");
        std::string xml;
        if (!rels || !ZipRead(src, *rels, xml)) { why = L"Cannot read package relationships"; return false; }
        RemoveXmlElements(xml, "<Relationship ", "thumbnail");
        ZipSetText(*rels, xml);
    }

    ZipBuild(src, ents, dst);
    return true;
}

/**
 * OpenDocument (.odt/.ods/.odp/.odg and templates).
 * Replaces meta.xml (author, dates, generator, editing duration, user-defined fields) with an
 * empty one and removes the preview thumbnail. All content parts are copied byte-for-byte.
 */
static bool StripMetadataODF(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    std::vector<ZipEntry> ents;
    if (!ZipParse(src, ents, why)) return false;
    if (ents.empty() || ents[0].name != "mimetype") { why = L"Not an OpenDocument file"; return false; }

    ZipEntry* manifest = ZipFind(ents, "META-INF/manifest.xml");
    std::string manifestXml;
    if (manifest) {
        if (!ZipRead(src, *manifest, manifestXml)) { why = L"Cannot read package manifest"; return false; }
        if (manifestXml.find("encryption-data") != std::string::npos) {
            why = L"Encrypted document";
            return false;
        }
    }

    static const char kMeta[] =
        "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>\\n"
        "<office:document-meta xmlns:office=\\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\\" "
        "office:version=\\"1.2\\"><office:meta/></office:document-meta>";

    bool thumbRemoved = false;
    for (auto& e : ents) {
        if (e.name == "meta.xml") ZipSetText(e, kMeta);
        else if (StartsWith(e.name, "Thumbnails/")) { e.removed = true; thumbRemoved = true; }
    }
    if (thumbRemoved && manifest) {
        RemoveXmlElements(manifestXml, "<manifest:file-entry", "Thumbnails/");
        ZipSetText(*manifest, manifestXml);
    }

    ZipBuild(src, ents, dst);
    return true;
}

// -----------------------------------------------------------------------------
// PDF - blanks in place (same byte length), so xref offsets stay valid.
// -----------------------------------------------------------------------------
static bool PdfIsWs(uint8_t c) { return c == 0 || c == 9 || c == 10 || c == 12 || c == 13 || c == 32; }
static bool PdfIsDigit(uint8_t c) { return c >= '0' && c <= '9'; }

static size_t FindBytes(const std::vector<uint8_t>& d, const char* needle, size_t from, size_t limit) {
    const size_t nl = std::strlen(needle);
    if (limit > d.size()) limit = d.size();
    if (from >= limit || limit - from < nl) return std::string::npos;
    auto it = std::search(d.begin() + static_cast<std::ptrdiff_t>(from), d.begin() + static_cast<std::ptrdiff_t>(limit),
                          needle, needle + nl);
    return it == d.begin() + static_cast<std::ptrdiff_t>(limit) ? std::string::npos
                                                                : static_cast<size_t>(it - d.begin());
}

// Replaces the content of every (literal) and <hex> string between [from,to) with spaces.
static void PdfBlankStrings(std::vector<uint8_t>& d, size_t from, size_t to) {
    size_t i = from;
    while (i < to) {
        const uint8_t c = d[i];
        if (c == '%') {
            while (i < to && d[i] != '\\n' && d[i] != '\\r') i++;
        } else if (c == '(') {
            int depth = 1;
            i++;
            while (i < to && depth > 0) {
                const uint8_t ch = d[i];
                if (ch == '\\\\' && i + 1 < to) { d[i] = ' '; d[i + 1] = ' '; i += 2; continue; }
                if (ch == '(') { depth++; d[i] = ' '; }
                else if (ch == ')') { depth--; if (depth > 0) d[i] = ' '; }
                else d[i] = ' ';
                i++;
            }
        } else if (c == '<') {
            if (i + 1 < to && d[i + 1] == '<') { i += 2; continue; }
            i++;
            while (i < to && d[i] != '>') { d[i] = ' '; i++; }
        } else {
            i++;
        }
    }
}

/**
 * Clears the document Info dictionary (title, author, subject, keywords, creator, producer, dates)
 * and XMP metadata packets without changing the file length or any offset.
 * Files that keep their Info dictionary inside compressed object streams, or that are encrypted,
 * are reported as unsupported and left untouched.
 */
static bool StripMetadataPDF(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    const size_t n = src.size();
    if (n < 16) { why = L"Not a PDF"; return false; }
    if (FindBytes(src, "%PDF-", 0, std::min<size_t>(n, 1024)) == std::string::npos) { why = L"Not a PDF"; return false; }
    if (FindBytes(src, "/Encrypt", 0, n) != std::string::npos) { why = L"Encrypted PDF"; return false; }

    dst = src;

    // 1) object numbers referenced as /Info N G R
    std::vector<uint32_t> infoObjs;
    for (size_t pos = 0; (pos = FindBytes(dst, "/Info", pos, n)) != std::string::npos; pos += 5) {
        size_t i = pos + 5;
        if (i >= n || !(PdfIsWs(dst[i]) || PdfIsDigit(dst[i]))) continue; // e.g. /InfoXYZ
        while (i < n && PdfIsWs(dst[i])) i++;
        uint64_t num = 0; size_t digits = 0;
        while (i < n && PdfIsDigit(dst[i]) && digits < 10) { num = num * 10 + (dst[i] - '0'); i++; digits++; }
        if (!digits) continue;
        if (i >= n || !PdfIsWs(dst[i])) continue;
        while (i < n && PdfIsWs(dst[i])) i++;
        size_t gd = 0;
        while (i < n && PdfIsDigit(dst[i]) && gd < 6) { i++; gd++; }
        if (!gd) continue;
        while (i < n && PdfIsWs(dst[i])) i++;
        if (i < n && dst[i] == 'R' && num > 0 && num < 0xFFFFFFFFull) {
            const uint32_t v = static_cast<uint32_t>(num);
            if (std::find(infoObjs.begin(), infoObjs.end(), v) == infoObjs.end()) infoObjs.push_back(v);
        }
    }

    // 2) locate every "N G obj" body for those numbers (all revisions of the file)
    std::vector<bool> resolved(infoObjs.size(), false);
    if (!infoObjs.empty()) {
        for (size_t i = 3; i + 3 <= n; i++) {
            if (dst[i] != 'o' || dst[i + 1] != 'b' || dst[i + 2] != 'j') continue;
            if (dst[i - 1] == 'd') continue; // endobj
            size_t j = i;
            size_t k = j;
            while (k > 0 && PdfIsWs(dst[k - 1])) k--;
            if (k == j) continue;
            size_t genEnd = k;
            while (k > 0 && PdfIsDigit(dst[k - 1])) k--;
            if (k == genEnd) continue;
            size_t numEnd = k;
            while (k > 0 && PdfIsWs(dst[k - 1])) k--;
            if (k == numEnd) continue;
            size_t numStart = k;
            while (numStart > 0 && PdfIsDigit(dst[numStart - 1])) numStart--;
            if (numStart == k || k - numStart > 10) continue;
            uint64_t num = 0;
            for (size_t q = numStart; q < k; q++) num = num * 10 + (dst[q] - '0');

            for (size_t w = 0; w < infoObjs.size(); w++) {
                if (num != infoObjs[w]) continue;
                const size_t bodyStart = i + 3;
                const size_t end = FindBytes(dst, "endobj", bodyStart, n);
                if (end == std::string::npos) continue;
                // Safety: an Info dictionary is a plain dictionary - never a stream or a typed object.
                const size_t probe = std::min(end, bodyStart + 4096);
                if (FindBytes(dst, "/Type", bodyStart, probe) != std::string::npos ||
                    FindBytes(dst, "stream", bodyStart, probe) != std::string::npos ||
                    FindBytes(dst, "/Filter", bodyStart, probe) != std::string::npos) continue;
                PdfBlankStrings(dst, bodyStart, end);
                resolved[w] = true;
            }
        }
        for (bool r : resolved) {
            if (!r) {
                why = L"Metadata is inside compressed object streams (unsupported)";
                return false;
            }
        }
    }

    // 3) XMP packets: keep the xpacket wrapper, empty the inside
    static const char kEmptyXmpLong[] =
        "<x:xmpmeta xmlns:x=\\"adobe:ns:meta/\\"><rdf:RDF xmlns:rdf=\\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\\">"
        "<rdf:Description rdf:about=\\"\\"/></rdf:RDF></x:xmpmeta>";
    size_t pos = 0;
    while ((pos = FindBytes(dst, "<?xpacket begin", pos, n)) != std::string::npos) {
        const size_t hdrEnd = FindBytes(dst, "?>", pos, n);
        if (hdrEnd == std::string::npos) break;
        const size_t trailer = FindBytes(dst, "<?xpacket end", hdrEnd + 2, n);
        if (trailer == std::string::npos) break;
        const size_t from = hdrEnd + 2;
        for (size_t q = from; q < trailer; q++) dst[q] = ' ';
        // leave a well-formed, empty XMP document when it fits (readers expect an rdf:RDF root)
        if (trailer - from > sizeof(kEmptyXmpLong)) std::memcpy(&dst[from], kEmptyXmpLong, sizeof(kEmptyXmpLong) - 1);
        pos = trailer + 13;
    }

    // 4) a compressed XMP stream cannot be cleared in place
    for (size_t p = 0; (p = FindBytes(dst, "/Metadata", p, n)) != std::string::npos; p += 9) {
        // an object *whose own type* is Metadata: "/Type /Metadata" (or "/Type/Metadata")
        size_t b = p;
        while (b > 0 && PdfIsWs(dst[b - 1])) b--;
        if (b >= 5 && std::memcmp(&dst[b - 5], "/Type", 5) == 0) {
            const size_t objStart = (p > 400) ? p - 400 : 0;
            const size_t objEnd = FindBytes(dst, "stream", p, std::min(n, p + 400));
            if (objEnd != std::string::npos &&
                FindBytes(dst, "/Filter", objStart, objEnd) != std::string::npos) {
                why = L"XMP metadata stream is compressed (unsupported)";
                return false;
            }
        }
    }
    return true;
}

// -----------------------------------------------------------------------------
// Audio: MP3 / FLAC / WAV
// -----------------------------------------------------------------------------
static size_t SkipId3v2(const std::vector<uint8_t>& s, size_t start, bool& bad) {
    bad = false;
    while (start + 10 <= s.size() && std::memcmp(&s[start], "ID3", 3) == 0) {
        if ((s[start + 6] | s[start + 7] | s[start + 8] | s[start + 9]) & 0x80) { bad = true; return start; }
        const size_t size = (static_cast<size_t>(s[start + 6]) << 21) | (static_cast<size_t>(s[start + 7]) << 14) |
                            (static_cast<size_t>(s[start + 8]) << 7) | s[start + 9];
        const size_t total = 10 + size + ((s[start + 5] & 0x10) ? 10 : 0);
        if (start + total > s.size()) { bad = true; return start; }
        start += total;
    }
    return start;
}

/** MP3: drops ID3v2 (head) and ID3v1 / APEv2 (tail). The MPEG audio frames are untouched. */
static bool StripMetadataMP3(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    bool bad = false;
    const size_t start = SkipId3v2(src, 0, bad);
    if (bad) { why = L"Corrupt ID3 tag"; return false; }
    size_t end = src.size();
    if (end <= start) { why = L"No audio data"; return false; }

    // Tail tags can appear in either order (ID3v1 last is the norm, but APEv2 after it also occurs),
    // so peel them off until nothing recognisable is left.
    for (bool again = true; again;) {
        again = false;
        if (end - start >= 128 && std::memcmp(&src[end - 128], "TAG", 3) == 0) {
            end -= 128;
            if (end - start >= 227 && std::memcmp(&src[end - 227], "TAG+", 4) == 0) end -= 227;
            again = true;
        }
        if (end - start >= 32 && std::memcmp(&src[end - 32], "APETAGEX", 8) == 0) {
            const uint32_t size = RdLE32(&src[end - 32 + 12]);
            const uint32_t flags = RdLE32(&src[end - 32 + 20]);
            const uint64_t total = static_cast<uint64_t>(size) + ((flags & 0x80000000u) ? 32 : 0);
            if (total >= 32 && total <= end - start) { end -= static_cast<size_t>(total); again = true; }
        }
    }
    if (end <= start) { why = L"No audio data"; return false; }

    dst.assign(src.begin() + static_cast<std::ptrdiff_t>(start), src.begin() + static_cast<std::ptrdiff_t>(end));
    return true;
}

/** FLAC: keeps STREAMINFO, SEEKTABLE, CUESHEET and all audio frames; drops Vorbis comments, pictures, padding, application blocks. */
static bool StripMetadataFLAC(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    bool bad = false;
    const size_t start = SkipId3v2(src, 0, bad);
    const size_t n = src.size();
    if (bad || start + 8 > n || std::memcmp(&src[start], "fLaC", 4) != 0) { why = L"Not a FLAC file"; return false; }

    struct Blk { size_t off; size_t len; uint8_t type; };
    std::vector<Blk> keep;
    size_t pos = start + 4;
    bool last = false;
    while (!last) {
        if (pos + 4 > n) { why = L"Truncated FLAC header"; return false; }
        const uint8_t h = src[pos];
        last = (h & 0x80) != 0;
        const uint8_t type = h & 0x7F;
        const size_t len = (static_cast<size_t>(src[pos + 1]) << 16) | (static_cast<size_t>(src[pos + 2]) << 8) | src[pos + 3];
        if (type == 127 || pos + 4 + len > n) { why = L"Corrupt FLAC metadata"; return false; }
        if (type == 0 || type == 3 || type == 5) keep.push_back(Blk{ pos + 4, len, type });
        pos += 4 + len;
    }
    if (keep.empty() || keep[0].type != 0) { why = L"Missing STREAMINFO"; return false; }

    dst.clear();
    dst.reserve(n);
    PutBytes(dst, "fLaC", 4);
    for (size_t i = 0; i < keep.size(); i++) {
        dst.push_back(static_cast<uint8_t>(keep[i].type | (i + 1 == keep.size() ? 0x80 : 0)));
        dst.push_back(static_cast<uint8_t>((keep[i].len >> 16) & 0xFF));
        dst.push_back(static_cast<uint8_t>((keep[i].len >> 8) & 0xFF));
        dst.push_back(static_cast<uint8_t>(keep[i].len & 0xFF));
        dst.insert(dst.end(), src.begin() + static_cast<std::ptrdiff_t>(keep[i].off),
                              src.begin() + static_cast<std::ptrdiff_t>(keep[i].off + keep[i].len));
    }
    dst.insert(dst.end(), src.begin() + static_cast<std::ptrdiff_t>(pos), src.end());
    return true;
}

/** WAV: keeps fmt/data/fact/cue/smpl/inst; drops LIST-INFO, bext, iXML, XMP, ID3, cart, JUNK and other tags. */
static bool StripMetadataWAV(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    if (src.size() < 12 || std::memcmp(src.data(), "RIFF", 4) != 0 || std::memcmp(src.data() + 8, "WAVE", 4) != 0) {
        why = L"Not a WAV file";
        return false;
    }
    const uint64_t declared = static_cast<uint64_t>(RdLE32(&src[4])) + 8;
    size_t total = src.size();
    if (declared < total) total = static_cast<size_t>(declared);

    dst.clear();
    dst.reserve(src.size());
    dst.insert(dst.end(), src.begin(), src.begin() + 12);

    size_t i = 12;
    bool sawFmt = false, sawData = false;
    while (i + 8 <= total) {
        const uint8_t* id = &src[i];
        const uint64_t size = RdLE32(&src[i + 4]);
        if (i + 8 + size > total) { why = L"Truncated or streamed WAV (unsupported)"; return false; }
        const size_t chunkEnd = std::min<size_t>(i + 8 + static_cast<size_t>(size) + (size & 1), total);

        bool keepChunk = Tag4(id, "fmt ") || Tag4(id, "data") || Tag4(id, "fact") || Tag4(id, "cue ") ||
                         Tag4(id, "smpl") || Tag4(id, "inst");
        if (Tag4(id, "LIST") && size >= 4 && std::memcmp(&src[i + 8], "adtl", 4) == 0) keepChunk = true;
        if (Tag4(id, "fmt ")) sawFmt = true;
        if (Tag4(id, "data")) sawData = true;

        if (keepChunk) {
            dst.insert(dst.end(), src.begin() + static_cast<std::ptrdiff_t>(i), src.begin() + static_cast<std::ptrdiff_t>(chunkEnd));
            if ((size & 1) && chunkEnd < i + 8 + size + 1) dst.push_back(0);
        }
        i = chunkEnd;
    }
    if (!sawFmt || !sawData) { why = L"Missing fmt/data chunk"; return false; }

    const uint32_t riffSize = static_cast<uint32_t>(dst.size() - 8);
    dst[4] = static_cast<uint8_t>(riffSize & 0xFF);
    dst[5] = static_cast<uint8_t>((riffSize >> 8) & 0xFF);
    dst[6] = static_cast<uint8_t>((riffSize >> 16) & 0xFF);
    dst[7] = static_cast<uint8_t>((riffSize >> 24) & 0xFF);
    return true;
}

// -----------------------------------------------------------------------------
// In-place patching (formats whose metadata can be cleared without changing the
// file length or any offset). The file is memory-mapped, so even multi-GB videos
// are handled without being read into RAM. Every patcher is run twice: first as a
// "dry run" that only validates, then for real - so an invalid file is never touched.
// -----------------------------------------------------------------------------
struct Buf {
    uint8_t* d;
    size_t n;
    bool dry = false;
    bool changed = false;
    void set(size_t i, uint8_t v) {
        if (d[i] != v) {
            changed = true;
            if (!dry) d[i] = v;
        }
    }
    void zero(size_t off, size_t len) {
        for (size_t i = off; i < off + len; i++) set(i, 0);
    }
    void put(size_t off, const void* p, size_t len) {
        const uint8_t* s = static_cast<const uint8_t*>(p);
        for (size_t i = 0; i < len; i++) set(off + i, s[i]);
    }
};

static uint16_t RdBE16(const uint8_t* p) {
    return static_cast<uint16_t>((p[0] << 8) | p[1]);
}

// ---- ISO base media (MP4 / M4A / MOV / 3GP) ----------------------------------
struct Mp4Box {
    size_t off;      // start of box
    size_t hdr;      // header size (8 or 16)
    size_t size;     // total size
    uint8_t type[4];
};

static bool Mp4ReadBox(const uint8_t* d, size_t pos, size_t limit, Mp4Box& b) {
    if (pos + 8 > limit) return false;
    uint64_t size = RdBE32(&d[pos]);
    b.hdr = 8;
    std::memcpy(b.type, &d[pos + 4], 4);
    if (size == 1) {
        if (pos + 16 > limit) return false;
        size = RdBE64(&d[pos + 8]);
        b.hdr = 16;
    } else if (size == 0) {
        size = limit - pos;
    }
    if (size < b.hdr || size > limit - pos) return false;
    b.off = pos;
    b.size = static_cast<size_t>(size);
    return true;
}

static bool BoxIs(const Mp4Box& b, const char* t) { return std::memcmp(b.type, t, 4) == 0; }

static void Mp4Blank(Buf& b, const Mp4Box& x) {
    b.put(x.off + 4, "free", 4);
    b.zero(x.off + x.hdr, x.size - x.hdr);
}

static void Mp4ZeroTimes(Buf& b, const Mp4Box& x) {
    // full box: version(1) flags(3) creation modification ...
    const size_t p = x.off + x.hdr;
    if (x.size < x.hdr + 4) return;
    const uint8_t version = b.d[p];
    const size_t span = (version == 1) ? 16 : 8;
    if (x.size < x.hdr + 4 + span) return;
    b.zero(p + 4, span);
}

static void Mp4CleanContainer(Buf& b, size_t from, size_t to, int depth, bool& sawMoov) {
    size_t pos = from;
    Mp4Box x;
    while (Mp4ReadBox(b.d, pos, to, x)) {
        const size_t next = x.off + x.size;
        if (BoxIs(x, "udta") || BoxIs(x, "meta") || BoxIs(x, "XMP_")) {
            Mp4Blank(b, x);
        } else if (BoxIs(x, "uuid") && x.size >= x.hdr + 16) {
            static const uint8_t xmpUuid[16] = { 0xBE,0x7A,0xCF,0xCB,0x97,0xA9,0x42,0xE8,0x9C,0x71,0x99,0x94,0x91,0xE3,0xAF,0xAC };
            if (std::memcmp(&b.d[x.off + x.hdr], xmpUuid, 16) == 0) Mp4Blank(b, x);
        } else if (BoxIs(x, "mvhd") || BoxIs(x, "tkhd") || BoxIs(x, "mdhd")) {
            Mp4ZeroTimes(b, x);
        } else if (depth < 4 && (BoxIs(x, "moov") || BoxIs(x, "trak") || BoxIs(x, "mdia"))) {
            if (BoxIs(x, "moov")) sawMoov = true;
            Mp4CleanContainer(b, x.off + x.hdr, next, depth + 1, sawMoov);
        }
        pos = next;
    }
}

/** MP4 / M4A / M4V / MOV / 3GP: tags, GPS, cover art, XMP and creation/modification times are cleared in place. */
static bool PatchMP4(Buf& b, std::wstring& why) {
    if (b.n < 16) { why = L"Not an MP4/MOV file"; return false; }
    Mp4Box first;
    if (!Mp4ReadBox(b.d, 0, b.n, first) ||
        !(BoxIs(first, "ftyp") || BoxIs(first, "moov") || BoxIs(first, "mdat") || BoxIs(first, "wide") ||
          BoxIs(first, "free") || BoxIs(first, "skip") || BoxIs(first, "pnot"))) {
        why = L"Not an MP4/MOV file";
        return false;
    }
    bool sawMoov = false;
    Mp4CleanContainer(b, 0, b.n, 0, sawMoov);
    if (!sawMoov) { why = L"No movie header found"; return false; }
    return true;
}

// ---- HEIC / HEIF / AVIF ------------------------------------------------------
static bool RdUInt(const uint8_t* d, size_t& q, size_t limit, int size, uint64_t& out) {
    if (size < 0 || size > 8 || q + static_cast<size_t>(size) > limit) return false;
    out = 0;
    for (int i = 0; i < size; i++) out = (out << 8) | d[q++];
    return true;
}

/** HEIC / HEIF / AVIF: the Exif and XMP items are zeroed and re-typed as 'free' (ignored by decoders). */
static bool PatchHEIF(Buf& b, std::wstring& why) {
    const uint8_t* d = b.d;
    Mp4Box ftyp;
    if (b.n < 16 || !Mp4ReadBox(d, 0, b.n, ftyp) || !BoxIs(ftyp, "ftyp")) { why = L"Not a HEIF/AVIF image"; return false; }

    Mp4Box meta = {};
    bool haveMeta = false;
    for (size_t pos = 0; pos < b.n;) {
        Mp4Box x;
        if (!Mp4ReadBox(d, pos, b.n, x)) break;
        if (BoxIs(x, "meta")) { meta = x; haveMeta = true; break; }
        pos = x.off + x.size;
    }
    if (!haveMeta || meta.size < meta.hdr + 4) { why = L"Not a HEIF/AVIF image"; return false; }

    Mp4Box iinf = {}, iloc = {}, idat = {};
    bool haveIinf = false, haveIloc = false, haveIdat = false;
    const size_t metaEnd = meta.off + meta.size;
    for (size_t pos = meta.off + meta.hdr + 4; pos < metaEnd;) {
        Mp4Box x;
        if (!Mp4ReadBox(d, pos, metaEnd, x)) break;
        if (BoxIs(x, "iinf")) { iinf = x; haveIinf = true; }
        else if (BoxIs(x, "iloc")) { iloc = x; haveIloc = true; }
        else if (BoxIs(x, "idat")) { idat = x; haveIdat = true; }
        pos = x.off + x.size;
    }
    if (!haveIinf || !haveIloc) return true; // no item table: nothing to clear

    // 1) find Exif / XMP items
    std::vector<uint32_t> ids;
    std::vector<size_t> typeOffsets;
    {
        const size_t end = iinf.off + iinf.size;
        size_t q = iinf.off + iinf.hdr;
        if (q + 6 > end) { why = L"Corrupt item table"; return false; }
        const uint8_t ver = d[q];
        q += 4;
        if (ver == 0) q += 2; else q += 4;
        while (q < end) {
            Mp4Box ib;
            if (!Mp4ReadBox(d, q, end, ib)) break;
            const size_t next = ib.off + ib.size;
            if (BoxIs(ib, "infe") && ib.size >= ib.hdr + 4 + 8) {
                size_t r = ib.off + ib.hdr;
                const uint8_t v = d[r];
                r += 4;
                if (v >= 2) {
                    uint32_t id;
                    if (v == 2) { id = RdBE16(&d[r]); r += 2; } else { id = RdBE32(&d[r]); r += 4; }
                    r += 2; // item_protection_index
                    if (r + 4 <= next) {
                        bool drop = std::memcmp(&d[r], "Exif", 4) == 0;
                        if (!drop && std::memcmp(&d[r], "mime", 4) == 0) {
                            size_t s = r + 4;
                            while (s < next && d[s] != 0) s++;       // item_name
                            s++;
                            static const char kXmp[] = "application/rdf+xml";
                            if (s + sizeof(kXmp) <= next && std::memcmp(&d[s], kXmp, sizeof(kXmp) - 1) == 0) drop = true;
                        }
                        if (drop) { ids.push_back(id); typeOffsets.push_back(r); }
                    }
                }
            }
            q = next;
        }
    }
    if (ids.empty()) return true;

    // 2) walk the item location table and collect the byte ranges to clear
    struct Range { size_t off, len; };
    std::vector<Range> ranges;
    {
        const size_t end = iloc.off + iloc.size;
        size_t q = iloc.off + iloc.hdr;
        if (q + 8 > end) { why = L"Corrupt item location table"; return false; }
        const uint8_t v = d[q];
        q += 4;
        const int offSize = d[q] >> 4, lenSize = d[q] & 15;
        q++;
        const int baseSize = d[q] >> 4;
        const int idxSize = (v == 1 || v == 2) ? (d[q] & 15) : 0;
        q++;
        uint64_t itemCount = 0;
        if (v < 2) { itemCount = RdBE16(&d[q]); q += 2; }
        else { if (q + 4 > end) { why = L"Corrupt item location table"; return false; } itemCount = RdBE32(&d[q]); q += 4; }
        for (uint64_t i = 0; i < itemCount; i++) {
            uint64_t id = 0, method = 0, base = 0, extCount = 0, tmp = 0;
            if (!RdUInt(d, q, end, v < 2 ? 2 : 4, id)) { why = L"Corrupt item location table"; return false; }
            if (v == 1 || v == 2) {
                if (!RdUInt(d, q, end, 2, tmp)) { why = L"Corrupt item location table"; return false; }
                method = tmp & 0xF;
            }
            if (!RdUInt(d, q, end, 2, tmp) || !RdUInt(d, q, end, baseSize, base) || !RdUInt(d, q, end, 2, extCount)) {
                why = L"Corrupt item location table";
                return false;
            }
            const bool wanted = std::find(ids.begin(), ids.end(), static_cast<uint32_t>(id)) != ids.end();
            for (uint64_t e = 0; e < extCount; e++) {
                uint64_t eo = 0, el = 0;
                if (idxSize && !RdUInt(d, q, end, idxSize, tmp)) { why = L"Corrupt item location table"; return false; }
                if (!RdUInt(d, q, end, offSize, eo) || !RdUInt(d, q, end, lenSize, el)) { why = L"Corrupt item location table"; return false; }
                if (!wanted) continue;
                uint64_t start;
                if (method == 0) start = base + eo;
                else if (method == 1 && haveIdat) start = static_cast<uint64_t>(idat.off + idat.hdr) + base + eo;
                else continue;
                if (start > b.n || el > b.n - start) { why = L"Metadata range outside the file"; return false; }
                ranges.push_back(Range{ static_cast<size_t>(start), static_cast<size_t>(el) });
            }
        }
    }

    for (const Range& r : ranges) b.zero(r.off, r.len);
    for (size_t t : typeOffsets) b.put(t, "free", 4);
    return true;
}

// ---- Matroska / WebM ---------------------------------------------------------
struct EbmlEl {
    size_t off = 0, dataOff = 0, end = 0;
    uint32_t id = 0;
    bool unknown = false;
};

static bool EbmlRead(const uint8_t* d, size_t pos, size_t limit, EbmlEl& e) {
    if (pos >= limit) return false;
    const uint8_t b0 = d[pos];
    const size_t idLen = (b0 & 0x80) ? 1 : (b0 & 0x40) ? 2 : (b0 & 0x20) ? 3 : (b0 & 0x10) ? 4 : 0;
    if (!idLen || pos + idLen >= limit) return false;
    uint32_t id = 0;
    for (size_t i = 0; i < idLen; i++) id = (id << 8) | d[pos + i];
    const size_t sp = pos + idLen;
    const uint8_t s = d[sp];
    if (s == 0) return false;
    size_t szLen = 1;
    uint8_t mask = 0x80;
    while (!(s & mask)) { mask = static_cast<uint8_t>(mask >> 1); szLen++; }
    if (sp + szLen > limit) return false;
    uint64_t v = s & (mask - 1);
    bool allOnes = (v == static_cast<uint64_t>(mask - 1));
    for (size_t i = 1; i < szLen; i++) {
        v = (v << 8) | d[sp + i];
        if (d[sp + i] != 0xFF) allOnes = false;
    }
    e.off = pos;
    e.id = id;
    e.dataOff = sp + szLen;
    e.unknown = allOnes;
    if (allOnes) {
        e.end = limit;
    } else {
        if (v > limit - e.dataOff) return false;
        e.end = e.dataOff + static_cast<size_t>(v);
    }
    return true;
}

// Replaces a whole element with an EBML Void element of identical total length.
static void EbmlVoid(Buf& b, const EbmlEl& e) {
    if (e.unknown) return;
    const size_t total = e.end - e.off;
    for (size_t k = 1; k <= 8; k++) {
        if (total < 1 + k) continue;
        const uint64_t payload = total - 1 - k;
        if (payload >= ((static_cast<uint64_t>(1) << (7 * k)) - 1)) continue;
        b.set(e.off, 0xEC);
        const uint64_t enc = (static_cast<uint64_t>(1) << (7 * k)) | payload;
        for (size_t i = 0; i < k; i++) b.set(e.off + 1 + i, static_cast<uint8_t>(enc >> (8 * (k - 1 - i))));
        b.zero(e.off + 1 + k, static_cast<size_t>(payload));
        return;
    }
}

/** MKV / MKA / WebM: Tags, title, date, file names and track names become Void elements (length unchanged). */
static bool PatchMKV(Buf& b, std::wstring& why) {
    EbmlEl head;
    if (b.n < 32 || !EbmlRead(b.d, 0, b.n, head) || head.id != 0x1A45DFA3u) { why = L"Not a Matroska/WebM file"; return false; }

    EbmlEl seg;
    bool haveSeg = false;
    for (size_t pos = head.end; pos < b.n;) {
        EbmlEl e;
        if (!EbmlRead(b.d, pos, b.n, e)) break;
        if (e.id == 0x18538067u) { seg = e; haveSeg = true; break; }
        if (e.unknown) break;
        pos = e.end;
    }
    if (!haveSeg) { why = L"No Segment found"; return false; }

    for (size_t pos = seg.dataOff; pos < seg.end;) {
        EbmlEl e;
        if (!EbmlRead(b.d, pos, seg.end, e)) break;
        if (e.id == 0x1254C367u) {                       // Tags
            EbmlVoid(b, e);
        } else if (e.id == 0x1549A966u) {                // Info
            for (size_t p2 = e.dataOff; p2 < e.end;) {
                EbmlEl c;
                if (!EbmlRead(b.d, p2, e.end, c)) break;
                if (c.id == 0x7BA9u || c.id == 0x4461u || c.id == 0x7384u || c.id == 0x3C83ABu || c.id == 0x3EB923u) EbmlVoid(b, c);
                p2 = c.end;
            }
        } else if (e.id == 0x1654AE6Bu) {                // Tracks
            for (size_t p2 = e.dataOff; p2 < e.end;) {
                EbmlEl te;
                if (!EbmlRead(b.d, p2, e.end, te)) break;
                if (te.id == 0xAEu) {
                    for (size_t p3 = te.dataOff; p3 < te.end;) {
                        EbmlEl c;
                        if (!EbmlRead(b.d, p3, te.end, c)) break;
                        if (c.id == 0x536Eu) EbmlVoid(b, c);   // track Name
                        p3 = c.end;
                    }
                }
                p2 = te.end;
            }
        }
        if (e.unknown) break; // live-stream cluster: cannot skip it safely
        pos = e.end;
    }
    return true;
}

// ---- AVI ---------------------------------------------------------------------
/** AVI: LIST-INFO, IDIT (date), stream names and JUNK payloads are zeroed in place (offsets stay valid). */
static bool PatchAVI(Buf& b, std::wstring& why) {
    if (b.n < 12 || std::memcmp(b.d, "RIFF", 4) != 0 || std::memcmp(b.d + 8, "AVI ", 4) != 0) { why = L"Not an AVI file"; return false; }
    size_t total = b.n;
    const uint64_t declared = static_cast<uint64_t>(RdLE32(b.d + 4)) + 8;
    if (declared < total) total = static_cast<size_t>(declared);

    for (size_t pos = 12; pos + 8 <= total;) {
        const uint8_t* id = b.d + pos;
        const uint64_t size = RdLE32(b.d + pos + 4);
        if (pos + 8 + size > total) break;
        const size_t payload = pos + 8;
        const size_t next = pos + 8 + static_cast<size_t>(size) + (size & 1);
        if (Tag4(id, "LIST") && size >= 4) {
            if (std::memcmp(b.d + payload, "INFO", 4) == 0) {
                b.put(pos, "JUNK", 4);
                b.zero(payload, static_cast<size_t>(size));
            } else if (std::memcmp(b.d + payload, "hdrl", 4) == 0) {
                for (size_t p2 = payload + 4; p2 + 8 <= payload + size;) {
                    const uint64_t s2 = RdLE32(b.d + p2 + 4);
                    if (p2 + 8 + s2 > payload + size) break;
                    if (Tag4(b.d + p2, "LIST") && s2 >= 4 && std::memcmp(b.d + p2 + 8, "strl", 4) == 0) {
                        for (size_t p3 = p2 + 12; p3 + 8 <= p2 + 8 + s2;) {
                            const uint64_t s3 = RdLE32(b.d + p3 + 4);
                            if (p3 + 8 + s3 > p2 + 8 + s2) break;
                            if (Tag4(b.d + p3, "strn")) b.zero(p3 + 8, static_cast<size_t>(s3));
                            p3 += 8 + static_cast<size_t>(s3) + (s3 & 1);
                        }
                    }
                    p2 += 8 + static_cast<size_t>(s2) + (s2 & 1);
                }
            }
        } else if (Tag4(id, "IDIT") || Tag4(id, "JUNK")) {
            b.zero(payload, static_cast<size_t>(size));
        }
        pos = next;
    }
    return true;
}

// -----------------------------------------------------------------------------
// GIF, AIFF, SVG (rewritten copies)
// -----------------------------------------------------------------------------
static size_t GifSkipSubBlocks(const std::vector<uint8_t>& s, size_t pos) {
    while (pos < s.size()) {
        const size_t len = s[pos];
        pos += 1 + len;
        if (len == 0) return pos <= s.size() ? pos : std::string::npos;
    }
    return std::string::npos;
}

/** GIF: drops comment extensions and application extensions other than the animation loop (incl. XMP). */
static bool StripMetadataGIF(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    const size_t n = src.size();
    if (n < 14 || (std::memcmp(src.data(), "GIF87a", 6) != 0 && std::memcmp(src.data(), "GIF89a", 6) != 0)) {
        why = L"Not a GIF";
        return false;
    }
    size_t pos = 13;
    if (src[10] & 0x80) pos += 3u * (1u << ((src[10] & 7) + 1));
    if (pos > n) { why = L"Truncated GIF"; return false; }
    dst.assign(src.begin(), src.begin() + static_cast<std::ptrdiff_t>(pos));

    bool sawTrailer = false;
    while (pos < n) {
        const uint8_t b0 = src[pos];
        if (b0 == 0x3B) { dst.push_back(0x3B); sawTrailer = true; break; }
        if (b0 == 0x2C) {                                   // image descriptor
            if (pos + 10 > n) { why = L"Truncated GIF"; return false; }
            size_t p = pos + 10;
            if (src[pos + 9] & 0x80) p += 3u * (1u << ((src[pos + 9] & 7) + 1));
            if (p + 1 > n) { why = L"Truncated GIF"; return false; }
            p += 1;                                          // LZW minimum code size
            const size_t e = GifSkipSubBlocks(src, p);
            if (e == std::string::npos) { why = L"Truncated GIF"; return false; }
            dst.insert(dst.end(), src.begin() + static_cast<std::ptrdiff_t>(pos), src.begin() + static_cast<std::ptrdiff_t>(e));
            pos = e;
        } else if (b0 == 0x21) {                            // extension
            if (pos + 2 > n) { why = L"Truncated GIF"; return false; }
            const uint8_t label = src[pos + 1];
            const size_t e = GifSkipSubBlocks(src, pos + 2);
            if (e == std::string::npos) { why = L"Truncated GIF"; return false; }
            bool keep = true;
            if (label == 0xFE) keep = false;                // comment
            if (label == 0xFF) {                            // application extension
                keep = false;
                if (pos + 14 <= n && src[pos + 2] == 11) {
                    if (std::memcmp(&src[pos + 3], "NETSCAPE2.0", 11) == 0 || std::memcmp(&src[pos + 3], "ANIMEXTS1.0", 11) == 0 ||
                        std::memcmp(&src[pos + 3], "ICCRGBG1012", 11) == 0) keep = true;
                }
            }
            if (keep) dst.insert(dst.end(), src.begin() + static_cast<std::ptrdiff_t>(pos), src.begin() + static_cast<std::ptrdiff_t>(e));
            pos = e;
        } else {
            why = L"Corrupt GIF";
            return false;
        }
    }
    if (!sawTrailer) { why = L"Truncated GIF"; return false; }
    return true;
}

/** AIFF / AIFC: keeps COMM, SSND, FVER, MARK, INST; drops NAME, AUTH, (c), ANNO, COMT, ID3, APPL ... */
static bool StripMetadataAIFF(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    if (src.size() < 12 || std::memcmp(src.data(), "FORM", 4) != 0 ||
        (std::memcmp(src.data() + 8, "AIFF", 4) != 0 && std::memcmp(src.data() + 8, "AIFC", 4) != 0)) {
        why = L"Not an AIFF file";
        return false;
    }
    size_t total = src.size();
    const uint64_t declared = static_cast<uint64_t>(RdBE32(&src[4])) + 8;
    if (declared < total) total = static_cast<size_t>(declared);

    dst.assign(src.begin(), src.begin() + 12);
    bool sawComm = false, sawSsnd = false;
    size_t i = 12;
    while (i + 8 <= total) {
        const uint8_t* id = &src[i];
        const uint64_t size = RdBE32(&src[i + 4]);
        if (i + 8 + size > total) { why = L"Truncated AIFF"; return false; }
        const size_t end = std::min<size_t>(i + 8 + static_cast<size_t>(size) + (size & 1), total);
        const bool keep = Tag4(id, "COMM") || Tag4(id, "SSND") || Tag4(id, "FVER") || Tag4(id, "MARK") || Tag4(id, "INST");
        if (Tag4(id, "COMM")) sawComm = true;
        if (Tag4(id, "SSND")) sawSsnd = true;
        if (keep) {
            dst.insert(dst.end(), src.begin() + static_cast<std::ptrdiff_t>(i), src.begin() + static_cast<std::ptrdiff_t>(end));
            if ((size & 1) && end < i + 8 + size + 1) dst.push_back(0);
        }
        i = end;
    }
    if (!sawComm || !sawSsnd) { why = L"Missing COMM/SSND chunk"; return false; }
    const uint32_t sz = static_cast<uint32_t>(dst.size() - 8);
    dst[4] = static_cast<uint8_t>(sz >> 24);
    dst[5] = static_cast<uint8_t>(sz >> 16);
    dst[6] = static_cast<uint8_t>(sz >> 8);
    dst[7] = static_cast<uint8_t>(sz);
    return true;
}

/** SVG: removes <metadata>, comments, Inkscape/Sodipodi editor data (incl. export paths). Drawing content is untouched. */
static bool StripMetadataSVG(const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    if (src.size() >= 2 && src[0] == 0x1F && src[1] == 0x8B) { why = L"Compressed SVGZ is not supported"; return false; }
    const std::string s(src.begin(), src.end());
    if (s.find("<svg") == std::string::npos) { why = L"Not an SVG"; return false; }

    auto isSpace = [](char c) { return c == ' ' || c == '\\t' || c == '\\r' || c == '\\n'; };
    std::string out;
    out.reserve(s.size());
    const size_t n = s.size();
    size_t i = 0;
    while (i < n) {
        if (s[i] != '<') {
            size_t j = s.find('<', i);
            if (j == std::string::npos) j = n;
            out.append(s, i, j - i);
            i = j;
            continue;
        }
        if (s.compare(i, 4, "<!--") == 0) {                       // comment: drop
            const size_t e = s.find("-->", i + 4);
            if (e == std::string::npos) { out.append(s, i, n - i); break; }
            i = e + 3;
            continue;
        }
        if (s.compare(i, 9, "<![CDATA[") == 0) {
            size_t e = s.find("]]>", i);
            e = (e == std::string::npos) ? n : e + 3;
            out.append(s, i, e - i);
            i = e;
            continue;
        }
        if (s.compare(i, 2, "<?") == 0) {
            size_t e = s.find("?>", i);
            e = (e == std::string::npos) ? n : e + 2;
            out.append(s, i, e - i);
            i = e;
            continue;
        }
        if (s.compare(i, 2, "<!") == 0) {                         // DOCTYPE (may have an internal subset)
            size_t e = i + 2;
            int depth = 0;
            while (e < n) {
                const char c = s[e];
                if (c == '[') depth++;
                else if (c == ']') depth--;
                else if (c == '>' && depth <= 0) break;
                e++;
            }
            e = std::min(e + 1, n);
            out.append(s, i, e - i);
            i = e;
            continue;
        }
        if (s.compare(i, 2, "</") == 0) {
            size_t e = s.find('>', i);
            e = (e == std::string::npos) ? n : e + 1;
            out.append(s, i, e - i);
            i = e;
            continue;
        }

        // start tag
        size_t p = i + 1;
        const size_t nameStart = p;
        while (p < n && !isSpace(s[p]) && s[p] != '/' && s[p] != '>') p++;
        const std::string name = s.substr(nameStart, p - nameStart);
        size_t q = p;
        char quote = 0;
        while (q < n) {
            const char c = s[q];
            if (quote) { if (c == quote) quote = 0; }
            else if (c == '"' || c == '\\'') quote = c;
            else if (c == '>') break;
            q++;
        }
        if (q >= n) { out.append(s, i, n - i); break; }
        const bool selfClose = (q > i && s[q - 1] == '/');
        const size_t tagEnd = q + 1;

        if (name == "metadata" || name == "sodipodi:namedview") {
            if (selfClose) { i = tagEnd; continue; }
            const std::string closeTag = "</" + name + ">";
            const size_t e = s.find(closeTag, tagEnd);
            i = (e == std::string::npos) ? tagEnd : e + closeTag.size();
            continue;
        }

        out.push_back('<');
        out.append(name);
        size_t a = p;
        while (a < q) {
            const size_t ws = a;
            while (a < q && isSpace(s[a])) a++;
            if (a >= q) { out.append(s, ws, q - ws); break; }
            if (s[a] == '/') { out.append(s, ws, q - ws); break; }
            const size_t ns = a;
            while (a < q && !isSpace(s[a]) && s[a] != '=' && s[a] != '/') a++;
            const std::string an = s.substr(ns, a - ns);
            size_t ve = a;
            while (ve < q && isSpace(s[ve])) ve++;
            if (ve < q && s[ve] == '=') {
                ve++;
                while (ve < q && isSpace(s[ve])) ve++;
                if (ve < q && (s[ve] == '"' || s[ve] == '\\'')) {
                    const size_t e2 = s.find(s[ve], ve + 1);
                    ve = (e2 == std::string::npos || e2 >= q) ? q : e2 + 1;
                } else {
                    while (ve < q && !isSpace(s[ve])) ve++;
                }
            } else {
                ve = a;
            }
            const bool drop = an.compare(0, 9, "inkscape:") == 0 || an.compare(0, 9, "sodipodi:") == 0;
            if (!drop) out.append(s, ws, ve - ws);
            a = ve;
        }
        out.push_back('>');
        i = tagEnd;
    }

    dst.assign(out.begin(), out.end());
    return true;
}

// <<< PORTABLE-CORE-END

static bool ReadWholeFile(const std::wstring& path, std::vector<uint8_t>& out) {
    std::ifstream in(fs::path(path), std::ios::binary);
    if (!in.is_open()) return false;
    in.seekg(0, std::ios::end);
    const std::streamoff size = in.tellg();
    if (size < 0) return false;
    in.seekg(0, std::ios::beg);
    out.resize(static_cast<size_t>(size));
    if (size > 0) {
        in.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(size));
        if (static_cast<std::streamoff>(in.gcount()) != size) return false;
    }
    return true;
}

static bool StripAny(FileFormat fmt, const std::vector<uint8_t>& src, std::vector<uint8_t>& dst, std::wstring& why) {
    switch (fmt) {
        case FileFormat::JPEG:
            if (StripMetadataJPEG(src, dst)) return true;
            why = L"Not a valid JPEG";
            return false;
        case FileFormat::PNG:
            if (StripMetadataPNG(src, dst)) return true;
            why = L"Not a valid PNG";
            return false;
        case FileFormat::WebP:
            if (StripMetadataWebP(src, dst)) return true;
            why = L"Not a valid WebP";
            return false;
        case FileFormat::PDF:   return StripMetadataPDF(src, dst, why);
        case FileFormat::OOXML: return StripMetadataOOXML(src, dst, why);
        case FileFormat::ODF:   return StripMetadataODF(src, dst, why);
        case FileFormat::MP3:   return StripMetadataMP3(src, dst, why);
        case FileFormat::FLAC:  return StripMetadataFLAC(src, dst, why);
        case FileFormat::WAV:   return StripMetadataWAV(src, dst, why);
        case FileFormat::GIF:   return StripMetadataGIF(src, dst, why);
        case FileFormat::SVG:   return StripMetadataSVG(src, dst, why);
        case FileFormat::AIFF:  return StripMetadataAIFF(src, dst, why);
        default:
            why = L"Unsupported format";
            return false;
    }
}

static bool IsInPlaceFormat(FileFormat f) {
    return f == FileFormat::MP4 || f == FileFormat::MKV || f == FileFormat::AVI || f == FileFormat::HEIF;
}

static bool PatchAny(FileFormat fmt, Buf& b, std::wstring& why) {
    switch (fmt) {
        case FileFormat::MP4:  return PatchMP4(b, why);
        case FileFormat::MKV:  return PatchMKV(b, why);
        case FileFormat::AVI:  return PatchAVI(b, why);
        case FileFormat::HEIF: return PatchHEIF(b, why);
        default:
            why = L"Unsupported format";
            return false;
    }
}

// Files above this size are not loaded into memory (in-place formats are exempt: they are memory-mapped).
static const uintmax_t kMaxBufferedSize = 1536ULL * 1024 * 1024;

/**
 * Removes NTFS alternate data streams (for example "Zone.Identifier", which records where a file
 * was downloaded from). Works for every file type. Returns how many streams were removed.
 */
static int RemoveAlternateStreams(const std::wstring& path, int& failed) {
    failed = 0;
    WIN32_FIND_STREAM_DATA fsd;
    HANDLE h = FindFirstStreamW(path.c_str(), FindStreamInfoStandard, &fsd, 0);
    if (h == INVALID_HANDLE_VALUE) return 0; // not NTFS, or no streams

    std::vector<std::wstring> names;
    do {
        const std::wstring name = fsd.cStreamName;
        if (name != L"::$DATA") names.push_back(name);
    } while (FindNextStreamW(h, &fsd));
    FindClose(h);

    int removed = 0;
    static const wchar_t kSuffix[] = L":$DATA";
    const size_t suffixLen = (sizeof(kSuffix) / sizeof(wchar_t)) - 1;
    for (std::wstring name : names) {
        if (name.size() > suffixLen && name.compare(name.size() - suffixLen, suffixLen, kSuffix) == 0) {
            name.resize(name.size() - suffixLen);
        }
        if (DeleteFileW((path + name).c_str())) removed++; else failed++;
    }
    return removed;
}

// In-place formats: map the file, validate (dry run), then patch.
static bool ProcessInPlace(const Job& job, uintmax_t fileSize, JobResult& res, bool& changed) {
    if (fileSize < 16) { res.status = L"Failed: File too small (file untouched)"; return false; }
    HANDLE hFile = CreateFileW(job.path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) {
        res.status = L"Failed: Cannot open for writing (read-only or in use?)";
        return false;
    }
    HANDLE hMap = CreateFileMappingW(hFile, nullptr, PAGE_READWRITE, 0, 0, nullptr);
    void* view = hMap ? MapViewOfFile(hMap, FILE_MAP_WRITE, 0, 0, 0) : nullptr;
    if (!view) {
        if (hMap) CloseHandle(hMap);
        CloseHandle(hFile);
        res.status = L"Failed: Cannot map file into memory";
        return false;
    }

    Buf buf{ static_cast<uint8_t*>(view), static_cast<size_t>(fileSize) };
    std::wstring why;
    buf.dry = true;
    bool ok = PatchAny(job.format, buf, why);
    if (ok) {
        buf.dry = false;
        buf.changed = false;
        ok = PatchAny(job.format, buf, why);
        if (ok && buf.changed) FlushViewOfFile(view, 0);
    }
    changed = ok && buf.changed;

    UnmapViewOfFile(view);
    CloseHandle(hMap);
    CloseHandle(hFile);

    if (!ok) {
        res.status = L"Failed: " + (why.empty() ? std::wstring(L"Invalid file") : why) + L" (file untouched)";
        return false;
    }
    return true;
}

// Rewritten-copy formats: read, strip in memory, write a temp file next to the original, swap it in.
static bool ProcessBuffered(const Job& job, uintmax_t fileSize, JobResult& res, bool& changed) {
    if (fileSize > kMaxBufferedSize) {
        res.status = L"Failed: File too large for this format (limit 1.5 GB)";
        return false;
    }
    std::vector<uint8_t> buffer;
    if (!ReadWholeFile(job.path, buffer)) {
        res.status = L"Failed: Cannot read";
        return false;
    }

    std::vector<uint8_t> stripped;
    std::wstring why;
    if (!StripAny(job.format, buffer, stripped, why) || stripped.empty()) {
        res.status = L"Failed: " + (why.empty() ? std::wstring(L"Invalid file") : why) + L" (file untouched)";
        return false;
    }

    if (stripped == buffer) { // nothing to remove: leave the file (and its timestamps) alone
        changed = false;
        return true;
    }

    const std::wstring tempPath = job.path + L".clearmd_tmp";
    {
        std::ofstream out(fs::path(tempPath), std::ios::binary | std::ios::trunc);
        if (!out.is_open()) {
            res.status = L"Failed: Cannot write (folder read-only?)";
            return false;
        }
        out.write(reinterpret_cast<const char*>(stripped.data()), static_cast<std::streamsize>(stripped.size()));
        out.flush();
        if (!out.good()) {
            out.close();
            DeleteFileW(tempPath.c_str());
            res.status = L"Failed: Write error (disk full?)";
            return false;
        }
    }

    if (!ReplaceFileW(job.path.c_str(), tempPath.c_str(), nullptr,
                      REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS, nullptr, nullptr)) {
        if (!MoveFileExW(tempPath.c_str(), job.path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED)) {
            DeleteFileW(tempPath.c_str());
            res.status = L"Failed: Cannot replace (read-only or in use?)";
            return false;
        }
    }
    res.cleanedSize = stripped.size();
    changed = true;
    return true;
}

// Runs on the worker thread. Touches only its own arguments.
static void ProcessFile(const Job& job, JobResult& res) {
    res.index = job.index;
    res.success = false;
    try {
        std::error_code ec;
        const uintmax_t fileSize = fs::file_size(fs::path(job.path), ec);
        if (ec) {
            res.status = L"Failed: Cannot read";
            return;
        }
        res.originalSize = fileSize;
        res.cleanedSize = fileSize;

        // 1) metadata embedded in the file's own format
        bool contentChanged = false;
        if (job.format != FileFormat::Unknown) {
            const bool ok = IsInPlaceFormat(job.format) ? ProcessInPlace(job, fileSize, res, contentChanged)
                                                        : ProcessBuffered(job, fileSize, res, contentChanged);
            if (!ok) return;
        }

        // 2) file-system metadata that applies to every file type (NTFS alternate data streams)
        int failedStreams = 0;
        const int removedStreams = RemoveAlternateStreams(job.path, failedStreams);

        std::wstring status;
        if (job.format == FileFormat::Unknown) {
            status = removedStreams ? L"Cleaned" : L"Nothing to remove";
        } else if (contentChanged) {
            const uintmax_t diff = res.originalSize > res.cleanedSize ? res.originalSize - res.cleanedSize : 0;
            status = diff ? L"Cleaned (-" + FormatFileSize(diff) + L")" : std::wstring(L"Cleaned");
        } else {
            status = L"Clean (no metadata found)";
        }
        if (removedStreams) {
            status += L" + " + std::to_wstring(removedStreams) + (removedStreams == 1 ? L" NTFS stream" : L" NTFS streams");
        }
        if (failedStreams) {
            res.status = L"Failed: " + std::to_wstring(failedStreams) + L" NTFS stream(s) could not be removed (" + status + L")";
            return;
        }
        res.status = status;
        res.success = true;
    } catch (...) {
        res.status = L"Failed: Unexpected error";
        res.success = false;
    }
}

// -----------------------------------------------------------------------------
// UI Layout & ListView Management
// -----------------------------------------------------------------------------
static void InsertRow(int index) {
    const FileEntry& e = g_files[static_cast<size_t>(index)];

    LVITEMW lvi = {};
    lvi.mask = LVIF_TEXT;
    lvi.iItem = index;
    lvi.iSubItem = 0;
    lvi.pszText = const_cast<LPWSTR>(e.filename.c_str());
    ListView_InsertItem(g_hListView, &lvi);

    const std::wstring typeStr = FormatToString(e.format, e.extension);
    ListView_SetItemText(g_hListView, index, 1, const_cast<LPWSTR>(typeStr.c_str()));

    const std::wstring sizeStr = FormatFileSize(e.cleanedSize > 0 ? e.cleanedSize : e.originalSize);
    ListView_SetItemText(g_hListView, index, 2, const_cast<LPWSTR>(sizeStr.c_str()));

    ListView_SetItemText(g_hListView, index, 3, const_cast<LPWSTR>(e.location.c_str()));
    ListView_SetItemText(g_hListView, index, 4, const_cast<LPWSTR>(e.status.c_str()));
}

// The last column always stretches to the right edge, so there is no empty strip
// that looks like an extra column.
static void FitLastColumn() {
    if (!g_hListView) return;
    RECT rc;
    GetClientRect(g_hListView, &rc);
    int used = 0;
    for (int c = 0; c < 4; c++) used += ListView_GetColumnWidth(g_hListView, c);
    int w = rc.right - used;
    if (w < Scale(110)) w = Scale(110);
    if (ListView_GetColumnWidth(g_hListView, 4) != w) ListView_SetColumnWidth(g_hListView, 4, w);
}

static const int kDefaultColumnWidths[4] = { 170, 125, 75, 180 };

static void ApplyDefaultColumnWidths() {
    for (int c = 0; c < 4; c++) ListView_SetColumnWidth(g_hListView, c, Scale(kDefaultColumnWidths[c]));
    FitLastColumn();
}

static void AddFileToList(const fs::path& filePath) {
    try {
        std::error_code ec;
        if (!fs::is_regular_file(filePath, ec) || ec) return;

        const std::wstring pathStr = filePath.wstring();
        if (!g_pathSet.insert(ToLower(pathStr)).second) return; // duplicate

        FileEntry entry;
        entry.path = pathStr;
        entry.filename = filePath.filename().wstring();
        entry.extension = filePath.extension().wstring();
        entry.location = filePath.parent_path().wstring();
        entry.format = DetectFileFormat(entry.extension);
        entry.originalSize = fs::file_size(filePath, ec);
        if (ec) entry.originalSize = 0;
        entry.status = (entry.format != FileFormat::Unknown) ? L"Ready" : L"Ready (streams only)";

        g_files.push_back(std::move(entry));
        InsertRow(static_cast<int>(g_files.size()) - 1);
    } catch (...) {
        // Ignore filesystem exceptions
    }
}

static void AddDirectoryToList(const fs::path& dirPath) {
    try {
        std::error_code ec;
        if (!fs::is_directory(dirPath, ec) || ec) return;
        fs::recursive_directory_iterator it(dirPath, fs::directory_options::skip_permission_denied, ec);
        const fs::recursive_directory_iterator end;
        while (!ec && it != end) {
            std::error_code ec2;
            if (it->is_regular_file(ec2) && !ec2) {
                AddFileToList(it->path());
            }
            it.increment(ec);
        }
    } catch (...) {
        // Ignore permission denied or traversal errors
    }
}

static void UpdateStatusBar() {
    size_t supported = 0;
    size_t processed = 0;
    uintmax_t totalBytes = 0;

    for (const auto& item : g_files) {
        if (item.format != FileFormat::Unknown) supported++;
        if (item.processed) processed++;
        totalBytes += item.cleanedSize > 0 ? item.cleanedSize : item.originalSize;
    }

    const std::wstring text = L"Files: " + std::to_wstring(g_files.size()) +
                              L" | Supported: " + std::to_wstring(supported) +
                              L" | Cleaned: " + std::to_wstring(processed) +
                              L" | Total Size: " + FormatFileSize(totalBytes);
    SendMessageW(g_hStatusBar, SB_SETTEXTW, 0, reinterpret_cast<LPARAM>(text.c_str()));
}

// -----------------------------------------------------------------------------
// Update check (GitHub releases)
//
// Runs once per launch on a background thread and stays silent on every kind of
// failure (offline, rate limit, no release published). winhttp.dll is loaded by
// name so the exe keeps its fixed set of static imports, and the check sends
// nothing beyond the GET itself.
// -----------------------------------------------------------------------------
#ifndef WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
#define WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY 4
#endif

static const wchar_t* kUpdateHost = L"api.github.com";
static const wchar_t* kUpdatePath = L"/repos/finnuen/ClearMD/releases/latest";
static const wchar_t* kReleasesPage = L"https://github.com/finnuen/ClearMD/releases/latest";

struct UpdateInfo {
    std::wstring version;   // release tag, e.g. L"v1.1"
    std::wstring url;       // release page to open
};

static std::wstring CurrentVersionString() {
    wchar_t buf[32];
    StringCchPrintfW(buf, ARRAYSIZE(buf), L"%d.%d.%d.%d",
                     VER_FILE_VERSION_MAJOR, VER_FILE_VERSION_MINOR,
                     VER_FILE_VERSION_BUILD, VER_FILE_VERSION_REVISION);
    return buf;
}

// Accepts "v1.1", "1.0.0.6", "release 2.0" etc. Missing components count as 0.
static bool ParseVersion(const std::string& text, int parts[4]) {
    for (int i = 0; i < 4; i++) parts[i] = 0;
    size_t i = 0;
    while (i < text.size() && !(text[i] >= '0' && text[i] <= '9')) i++;
    if (i == text.size()) return false;
    int part = 0;
    while (i < text.size() && part < 4) {
        long v = 0;
        while (i < text.size() && text[i] >= '0' && text[i] <= '9') {
            v = v * 10 + (text[i] - '0');
            if (v > 100000000L) v = 100000000L;     // keep absurd input harmless
            i++;
        }
        parts[part++] = static_cast<int>(v);
        if (i < text.size() && text[i] == '.') i++;
        else break;
    }
    return part > 0;
}

static bool VersionIsNewer(const int remote[4], const int local[4]) {
    for (int i = 0; i < 4; i++) {
        if (remote[i] != local[i]) return remote[i] > local[i];
    }
    return false;
}

static std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring out(static_cast<size_t>(n), L'\\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), &out[0], n);
    return out;
}

// Minimal JSON lookup: the response is small and only two string fields are
// needed, so a full parser would be far more code than the job requires.
static bool JsonStringField(const std::string& json, const char* key, std::string& value) {
    const std::string pattern = std::string("\\"") + key + "\\"";
    size_t i = json.find(pattern);
    if (i == std::string::npos) return false;
    i += pattern.size();
    while (i < json.size() && (json[i] == ' ' || json[i] == '\\t' || json[i] == '\\r' || json[i] == '\\n')) i++;
    if (i >= json.size() || json[i] != ':') return false;
    i++;
    while (i < json.size() && (json[i] == ' ' || json[i] == '\\t' || json[i] == '\\r' || json[i] == '\\n')) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;

    value.clear();
    while (i < json.size()) {
        const char c = json[i++];
        if (c == '"') return true;
        if (c != '\\\\' || i >= json.size()) { value.push_back(c); continue; }
        const char esc = json[i++];
        switch (esc) {
            case 'n': value.push_back('\\n'); break;
            case 'r': value.push_back('\\r'); break;
            case 't': value.push_back('\\t'); break;
            case 'b': value.push_back('\\b'); break;
            case 'f': value.push_back('\\f'); break;
            case 'u':
                // Only ASCII code points can appear in the two fields we read.
                if (i + 4 <= json.size()) {
                    int cp = 0;
                    for (int k = 0; k < 4; k++) {
                        const char h = json[i + static_cast<size_t>(k)];
                        cp <<= 4;
                        if (h >= '0' && h <= '9') cp |= h - '0';
                        else if (h >= 'a' && h <= 'f') cp |= h - 'a' + 10;
                        else if (h >= 'A' && h <= 'F') cp |= h - 'A' + 10;
                    }
                    if (cp > 0 && cp < 0x80) value.push_back(static_cast<char>(cp));
                    i += 4;
                }
                break;
            default: value.push_back(esc); break;
        }
    }
    return false;
}

// GetProcAddress returns FARPROC; going through void* keeps GCC's
// -Wcast-function-type quiet (the prototypes are known from winhttp.h).
template <typename Fn>
static Fn LoadProc(HMODULE dll, const char* name) {
    return reinterpret_cast<Fn>(reinterpret_cast<void*>(GetProcAddress(dll, name)));
}

static bool WinHttpGet(const wchar_t* host, const wchar_t* path, std::string& body) {
    HMODULE dll = LoadLibraryW(L"winhttp.dll");
    if (!dll) return false;

    auto pOpen = LoadProc<decltype(&WinHttpOpen)>(dll, "WinHttpOpen");
    auto pConnect = LoadProc<decltype(&WinHttpConnect)>(dll, "WinHttpConnect");
    auto pOpenRequest = LoadProc<decltype(&WinHttpOpenRequest)>(dll, "WinHttpOpenRequest");
    auto pSend = LoadProc<decltype(&WinHttpSendRequest)>(dll, "WinHttpSendRequest");
    auto pReceive = LoadProc<decltype(&WinHttpReceiveResponse)>(dll, "WinHttpReceiveResponse");
    auto pQuery = LoadProc<decltype(&WinHttpQueryHeaders)>(dll, "WinHttpQueryHeaders");
    auto pAvailable = LoadProc<decltype(&WinHttpQueryDataAvailable)>(dll, "WinHttpQueryDataAvailable");
    auto pRead = LoadProc<decltype(&WinHttpReadData)>(dll, "WinHttpReadData");
    auto pClose = LoadProc<decltype(&WinHttpCloseHandle)>(dll, "WinHttpCloseHandle");
    auto pTimeouts = LoadProc<decltype(&WinHttpSetTimeouts)>(dll, "WinHttpSetTimeouts");

    bool ok = false;
    HINTERNET session = nullptr, connection = nullptr, request = nullptr;
    if (pOpen && pConnect && pOpenRequest && pSend && pReceive && pQuery && pAvailable && pRead && pClose) {
        session = pOpen(L"ClearMD update check", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (session) {
            if (pTimeouts) pTimeouts(session, 5000, 5000, 5000, 8000);
            connection = pConnect(session, host, INTERNET_DEFAULT_HTTPS_PORT, 0);
        }
        if (connection) {
            request = pOpenRequest(connection, L"GET", path, nullptr, WINHTTP_NO_REFERER,
                                   WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
        }
        if (request) {
            const wchar_t* headers = L"Accept: application/vnd.github+json\\r\\n";
            if (pSend(request, headers, static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
                pReceive(request, nullptr)) {
                DWORD status = 0, len = sizeof(status);
                if (pQuery(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                           WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX) &&
                    status == 200) {
                    ok = true;
                    DWORD available = 0;
                    while (ok && pAvailable(request, &available) && available > 0) {
                        char buffer[4096];
                        DWORD read = 0;
                        const DWORD want = available < sizeof(buffer) ? available : static_cast<DWORD>(sizeof(buffer));
                        if (!pRead(request, buffer, want, &read) || read == 0) break;
                        if (body.size() + read > 256 * 1024) { ok = false; break; }
                        body.append(buffer, read);
                    }
                }
            }
        }
    }

    if (request) pClose(request);
    if (connection) pClose(connection);
    if (session) pClose(session);
    FreeLibrary(dll);
    return ok;
}

static void CheckForUpdatesAsync(HWND hwnd) {
    std::thread([hwnd]() {
        std::string body;
        if (!WinHttpGet(kUpdateHost, kUpdatePath, body)) return;

        std::string tag, url;
        if (!JsonStringField(body, "tag_name", tag)) return;
        if (!JsonStringField(body, "html_url", url)) return;

        int remote[4] = {};
        const int local[4] = { VER_FILE_VERSION_MAJOR, VER_FILE_VERSION_MINOR,
                               VER_FILE_VERSION_BUILD, VER_FILE_VERSION_REVISION };
        if (!ParseVersion(tag, remote) || !VersionIsNewer(remote, local)) return;

        auto info = std::make_unique<UpdateInfo>();
        info->version = Utf8ToWide(tag);
        info->url = Utf8ToWide(url);
        if (info->url.rfind(L"https://github.com/", 0) != 0) info->url = kReleasesPage;

        UpdateInfo* raw = info.release();
        if (!PostMessageW(hwnd, WM_APP_UPDATE_FOUND, 0, reinterpret_cast<LPARAM>(raw))) delete raw;
    }).detach();
}

// -----------------------------------------------------------------------------
// Dialog Actions (Multi-select File and Folder Picking)
// -----------------------------------------------------------------------------
static void OnAddFiles() {
    if (g_isProcessing) return;
    IFileOpenDialog* pFileOpen = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&pFileOpen));
    if (SUCCEEDED(hr)) {
        DWORD dwOptions = 0;
        pFileOpen->GetOptions(&dwOptions);
        pFileOpen->SetOptions(dwOptions | FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM);

        static const wchar_t kImages[] = L"*.jpg;*.jpeg;*.jpe;*.jfif;*.png;*.webp;*.gif;*.svg;*.heic;*.heif;*.hif;*.avif";
        static const wchar_t kDocs[] = L"*.pdf;*.docx;*.docm;*.dotx;*.dotm;*.xlsx;*.xlsm;*.xltx;*.xltm;*.pptx;*.pptm;*.potx;*.potm;*.ppsx;*.ppsm;*.odt;*.ods;*.odp;*.odg;*.ott;*.ots;*.otp";
        static const wchar_t kMedia[] = L"*.mp3;*.flac;*.wav;*.aif;*.aiff;*.aifc;*.mp4;*.m4a;*.m4b;*.m4v;*.mov;*.3gp;*.3g2;*.avi;*.mkv;*.mka;*.mk3d;*.webm";
        static const wchar_t kKnown[] =
            L"*.jpg;*.jpeg;*.jpe;*.jfif;*.png;*.webp;*.gif;*.svg;*.heic;*.heif;*.hif;*.avif;"
            L"*.pdf;*.docx;*.docm;*.dotx;*.dotm;*.xlsx;*.xlsm;*.xltx;*.xltm;*.pptx;*.pptm;*.potx;*.potm;*.ppsx;*.ppsm;*.odt;*.ods;*.odp;*.odg;*.ott;*.ots;*.otp;"
            L"*.mp3;*.flac;*.wav;*.aif;*.aiff;*.aifc;*.mp4;*.m4a;*.m4b;*.m4v;*.mov;*.3gp;*.3g2;*.avi;*.mkv;*.mka;*.mk3d;*.webm";
        COMDLG_FILTERSPEC fileTypes[] = {
            { L"All Files (*.*)", L"*.*" },
            { L"Files with embedded-metadata support", kKnown },
            { L"Images (JPEG, PNG, WebP, GIF, SVG, HEIC, AVIF)", kImages },
            { L"Documents (PDF, Office, OpenDocument)", kDocs },
            { L"Audio / Video (MP3, FLAC, WAV, MP4, MKV, AVI ...)", kMedia }
        };
        pFileOpen->SetFileTypes(ARRAYSIZE(fileTypes), fileTypes);
        pFileOpen->SetTitle(L"Select Files to Strip Metadata");

        hr = pFileOpen->Show(g_hWndMain);
        if (SUCCEEDED(hr)) {
            IShellItemArray* pItemArray = nullptr;
            hr = pFileOpen->GetResults(&pItemArray);
            if (SUCCEEDED(hr)) {
                DWORD count = 0;
                pItemArray->GetCount(&count);
                SendMessageW(g_hListView, WM_SETREDRAW, FALSE, 0);
                for (DWORD i = 0; i < count; i++) {
                    IShellItem* pItem = nullptr;
                    if (SUCCEEDED(pItemArray->GetItemAt(i, &pItem))) {
                        PWSTR pszFilePath = nullptr;
                        if (SUCCEEDED(pItem->GetDisplayName(SIGDN_FILESYSPATH, &pszFilePath))) {
                            AddFileToList(fs::path(pszFilePath));
                            CoTaskMemFree(pszFilePath);
                        }
                        pItem->Release();
                    }
                }
                SendMessageW(g_hListView, WM_SETREDRAW, TRUE, 0);
                InvalidateRect(g_hListView, nullptr, TRUE);
                FitLastColumn();
                UpdateStatusBar();
                pItemArray->Release();
            }
        }
        pFileOpen->Release();
    }
}

static void OnAddFolder() {
    if (g_isProcessing) return;
    IFileOpenDialog* pFolderOpen = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&pFolderOpen));
    if (SUCCEEDED(hr)) {
        DWORD dwOptions = 0;
        pFolderOpen->GetOptions(&dwOptions);
        pFolderOpen->SetOptions(dwOptions | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
        pFolderOpen->SetTitle(L"Select Folder to Scan for Supported Files");

        hr = pFolderOpen->Show(g_hWndMain);
        if (SUCCEEDED(hr)) {
            IShellItem* pItem = nullptr;
            hr = pFolderOpen->GetResult(&pItem);
            if (SUCCEEDED(hr)) {
                PWSTR pszFolderPath = nullptr;
                if (SUCCEEDED(pItem->GetDisplayName(SIGDN_FILESYSPATH, &pszFolderPath))) {
                    SetCursor(LoadCursorW(nullptr, IDC_WAIT));
                    SendMessageW(g_hListView, WM_SETREDRAW, FALSE, 0);
                    AddDirectoryToList(fs::path(pszFolderPath));
                    SendMessageW(g_hListView, WM_SETREDRAW, TRUE, 0);
                    InvalidateRect(g_hListView, nullptr, TRUE);
                    SetCursor(LoadCursorW(nullptr, IDC_ARROW));
                    FitLastColumn();
                    UpdateStatusBar();
                    CoTaskMemFree(pszFolderPath);
                }
                pItem->Release();
            }
        }
        pFolderOpen->Release();
    }
}

static void OnClearList() {
    if (g_isProcessing) return;
    g_files.clear();
    g_pathSet.clear();
    ListView_DeleteAllItems(g_hListView);
    FitLastColumn();
    UpdateStatusBar();
}

static void SelectAllRows() {
    if (g_isProcessing || g_files.empty()) return;
    ListView_SetItemState(g_hListView, -1, LVIS_SELECTED, LVIS_SELECTED);
}

// Removes the selected rows from the list only. Files on disk are never touched.
static void RemoveSelected() {
    if (g_isProcessing) return;
    std::vector<int> sel;
    for (int i = -1; (i = ListView_GetNextItem(g_hListView, i, LVNI_SELECTED)) != -1;) sel.push_back(i);
    if (sel.empty()) return;

    SendMessageW(g_hListView, WM_SETREDRAW, FALSE, 0);

    std::vector<bool> drop(g_files.size(), false);
    for (int i : sel) drop[static_cast<size_t>(i)] = true;
    for (size_t i = 0; i < g_files.size(); i++) {
        if (drop[i]) g_pathSet.erase(ToLower(g_files[i].path));
    }

    if (sel.size() > 64) {
        // Large selection: rebuild the list in one pass instead of deleting row by row.
        std::vector<FileEntry> kept;
        kept.reserve(g_files.size() - sel.size());
        for (size_t i = 0; i < g_files.size(); i++) {
            if (!drop[i]) kept.push_back(std::move(g_files[i]));
        }
        g_files = std::move(kept);
        ListView_DeleteAllItems(g_hListView);
        for (size_t i = 0; i < g_files.size(); i++) InsertRow(static_cast<int>(i));
    } else {
        for (auto it = sel.rbegin(); it != sel.rend(); ++it) {
            g_files.erase(g_files.begin() + *it);
            ListView_DeleteItem(g_hListView, *it);
        }
    }

    // Keep keyboard flow: select the row that took the place of the first removed one.
    if (!g_files.empty()) {
        const int next = std::min(sel.front(), static_cast<int>(g_files.size()) - 1);
        ListView_SetItemState(g_hListView, next, LVIS_SELECTED | LVIS_FOCUSED, LVIS_SELECTED | LVIS_FOCUSED);
        ListView_EnsureVisible(g_hListView, next, FALSE);
    }

    SendMessageW(g_hListView, WM_SETREDRAW, TRUE, 0);
    InvalidateRect(g_hListView, nullptr, TRUE);
    FitLastColumn();
    UpdateStatusBar();
}

static void ShowListContextMenu(int screenX, int screenY) {
    const UINT selCount = ListView_GetSelectedCount(g_hListView);

    if (screenX == -1 && screenY == -1) { // opened with the keyboard (Menu / Shift+F10)
        POINT pt = { 0, 0 };
        const int focused = ListView_GetNextItem(g_hListView, -1, LVNI_FOCUSED);
        RECT r;
        if (focused >= 0 && ListView_GetItemRect(g_hListView, focused, &r, LVIR_BOUNDS)) {
            pt.x = r.left + 16;
            pt.y = r.bottom;
        }
        ClientToScreen(g_hListView, &pt);
        screenX = pt.x;
        screenY = pt.y;
    } else {
        // Right-clicking an unselected row selects just that row (like Explorer).
        POINT pt = { screenX, screenY };
        ScreenToClient(g_hListView, &pt);
        LVHITTESTINFO hit = {};
        hit.pt = pt;
        const int idx = ListView_HitTest(g_hListView, &hit);
        if (idx >= 0 && !(ListView_GetItemState(g_hListView, idx, LVIS_SELECTED) & LVIS_SELECTED)) {
            ListView_SetItemState(g_hListView, -1, 0, LVIS_SELECTED);
            ListView_SetItemState(g_hListView, idx, LVIS_SELECTED | LVIS_FOCUSED, LVIS_SELECTED | LVIS_FOCUSED);
        }
    }

    HMENU menu = CreatePopupMenu();
    if (!menu) return;
    const UINT enabledSel = (!g_isProcessing && ListView_GetSelectedCount(g_hListView) > 0) ? MF_ENABLED : MF_GRAYED;
    const UINT enabledAll = (!g_isProcessing && !g_files.empty()) ? MF_ENABLED : MF_GRAYED;
    (void)selCount;
    AppendMenuW(menu, MF_STRING | enabledSel, IDM_REMOVE_SELECTED, L"Remove from list\\tDel");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING | enabledAll, IDM_SELECT_ALL, L"Select all\\tCtrl+A");
    TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_TOPALIGN, screenX, screenY, 0, g_hWndMain, nullptr);
    DestroyMenu(menu);
}

static void SetControlsEnabled(bool enabled) {
    EnableWindow(g_hBtnAddFolder, enabled);
    EnableWindow(g_hBtnAddFile, enabled);
    EnableWindow(g_hBtnClearList, enabled);
    EnableWindow(g_hBtnClearMetadata, enabled);
}

// -----------------------------------------------------------------------------
// Confirmation dialog: warning -> Proceed / Cancel -> 3-second cancellable countdown
// -----------------------------------------------------------------------------
struct ConfirmState {
    HWND hDlg = nullptr;
    HWND hProceed = nullptr;
    HWND hCancel = nullptr;
    HWND hProgress = nullptr;
    HWND hCountdown = nullptr;
    size_t fileCount = 0;
    bool counting = false;
    bool done = false;
    bool result = false;
    ULONGLONG startTick = 0;
    int lastSeconds = -1;
};

static const ULONGLONG kCountdownMs = 3000;

static HWND AddConfirmChild(HWND parent, const wchar_t* cls, const wchar_t* text, DWORD style,
                            int x, int y, int w, int h, int id, HFONT font) {
    HWND c = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, Scale(x), Scale(y), Scale(w), Scale(h),
                             parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), g_hInstance, nullptr);
    if (c && font) SendMessageW(c, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
    return c;
}

static void ConfirmStartCountdown(ConfirmState* st) {
    st->counting = true;
    st->startTick = GetTickCount64();
    st->lastSeconds = -1;
    EnableWindow(st->hProceed, FALSE);
    ShowWindow(st->hProceed, SW_HIDE);
    ShowWindow(st->hProgress, SW_SHOW);
    ShowWindow(st->hCountdown, SW_SHOW);
    SendMessageW(st->hProgress, PBM_SETPOS, 0, 0);
    SetWindowTextW(st->hCountdown, L"Starting in 3 seconds... click Cancel to stop.");
    SetFocus(st->hCancel);
    SetTimer(st->hDlg, 1, 15, nullptr);
}

static LRESULT CALLBACK ConfirmProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    ConfirmState* st = reinterpret_cast<ConfirmState*>(GetWindowLongPtrW(hWnd, GWLP_USERDATA));
    switch (msg) {
        case WM_CREATE: {
            st = static_cast<ConfirmState*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams);
            SetWindowLongPtrW(hWnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(st));
            st->hDlg = hWnd;

            HWND icon = AddConfirmChild(hWnd, L"STATIC", nullptr, SS_ICON, 20, 22, 32, 32, 0, nullptr);
            SendMessageW(icon, STM_SETICON, reinterpret_cast<WPARAM>(LoadIconW(nullptr, IDI_WARNING)), 0);

            AddConfirmChild(hWnd, L"STATIC", L"This app does not automatically create backup", SS_LEFT, 68, 22, 380, 22, 0, g_hFontBold);
            AddConfirmChild(hWnd, L"STATIC", L"Deleted metadata is unrecoverable", SS_LEFT, 68, 46, 380, 22, 0, g_hFontBold);
            const std::wstring info = std::to_wstring(st->fileCount) + (st->fileCount == 1 ? L" file will be modified in place." : L" files will be modified in place.");
            AddConfirmChild(hWnd, L"STATIC", info.c_str(), SS_LEFT, 68, 80, 380, 20, 0, g_hFont);

            st->hCountdown = AddConfirmChild(hWnd, L"STATIC", L"", SS_LEFT, 20, 114, 428, 20, 0, g_hFont);
            st->hProgress = AddConfirmChild(hWnd, PROGRESS_CLASSW, nullptr, PBS_SMOOTH, 20, 138, 428, 18, IDC_CONFIRM_PROGRESS, nullptr);
            SendMessageW(st->hProgress, PBM_SETRANGE32, 0, 1000);
            ShowWindow(st->hProgress, SW_HIDE);
            ShowWindow(st->hCountdown, SW_HIDE);

            st->hProceed = AddConfirmChild(hWnd, WC_BUTTONW, L"Proceed", WS_TABSTOP | BS_PUSHBUTTON, 238, 174, 100, 30, IDC_CONFIRM_PROCEED, g_hFont);
            st->hCancel = AddConfirmChild(hWnd, WC_BUTTONW, L"Cancel", WS_TABSTOP | BS_DEFPUSHBUTTON, 348, 174, 100, 30, IDC_CONFIRM_CANCEL, g_hFont);
            return 0;
        }
        case WM_COMMAND: {
            if (!st || HIWORD(wParam) != BN_CLICKED) break;
            const int id = LOWORD(wParam);
            if (id == IDC_CONFIRM_PROCEED && !st->counting) {
                ConfirmStartCountdown(st);
            } else if (id == IDC_CONFIRM_CANCEL || id == IDCANCEL) {
                KillTimer(hWnd, 1);
                st->counting = false;
                st->result = false;
                st->done = true;
            }
            return 0;
        }
        case WM_TIMER: {
            if (!st || !st->counting) break;
            const ULONGLONG elapsed = GetTickCount64() - st->startTick;
            if (elapsed >= kCountdownMs) {
                KillTimer(hWnd, 1);
                SendMessageW(st->hProgress, PBM_SETPOS, 1000, 0);
                st->counting = false;
                st->result = true;
                st->done = true;
                return 0;
            }
            const int pos = static_cast<int>(elapsed * 1000 / kCountdownMs);
            SendMessageW(st->hProgress, PBM_SETPOS, static_cast<WPARAM>(pos + 1), 0); // skip the slow themed animation
            SendMessageW(st->hProgress, PBM_SETPOS, static_cast<WPARAM>(pos), 0);
            const int seconds = static_cast<int>((kCountdownMs - elapsed + 999) / 1000);
            if (seconds != st->lastSeconds) {
                st->lastSeconds = seconds;
                const std::wstring t = L"Starting in " + std::to_wstring(seconds) + (seconds == 1 ? L" second" : L" seconds") + L"... click Cancel to stop.";
                SetWindowTextW(st->hCountdown, t.c_str());
            }
            return 0;
        }
        case WM_CLOSE: {
            if (st) {
                KillTimer(hWnd, 1);
                st->counting = false;
                st->result = false;
                st->done = true;
            }
            return 0;
        }
    }
    return DefWindowProcW(hWnd, msg, wParam, lParam);
}

// Returns true only if the user pressed Proceed AND did not cancel during the 3-second countdown.
static bool ConfirmAndCountdown(HWND owner, size_t fileCount) {
    static bool registered = false;
    if (!registered) {
        WNDCLASSEXW wc = {};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = ConfirmProc;
        wc.hInstance = g_hInstance;
        wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        wc.hbrBackground = reinterpret_cast<HBRUSH>(static_cast<INT_PTR>(COLOR_BTNFACE + 1));
        wc.lpszClassName = L"ClearMDConfirmWindow";
        if (!RegisterClassExW(&wc)) return false;
        registered = true;
    }

    ConfirmState st;
    st.fileCount = fileCount;

    const DWORD style = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN;
    const DWORD exStyle = WS_EX_DLGMODALFRAME;
    RECT rc = { 0, 0, Scale(468), Scale(218) };
    AdjustWindowRectEx(&rc, style, FALSE, exStyle);
    const int w = rc.right - rc.left, h = rc.bottom - rc.top;

    RECT ow = {};
    GetWindowRect(owner, &ow);
    const int x = ow.left + ((ow.right - ow.left) - w) / 2;
    const int y = ow.top + ((ow.bottom - ow.top) - h) / 2;

    HWND dlg = CreateWindowExW(exStyle, L"ClearMDConfirmWindow", APP_TITLE L" - Confirm", style, x, y, w, h,
                               owner, nullptr, g_hInstance, &st);
    if (!dlg) return false;

    EnableWindow(owner, FALSE);
    ShowWindow(dlg, SW_SHOW);
    UpdateWindow(dlg);
    SetFocus(st.hCancel);   // safest default: Enter / Space cancels

    MSG msg;
    while (!st.done) {
        const BOOL r = GetMessageW(&msg, nullptr, 0, 0);
        if (r == 0) { PostQuitMessage(static_cast<int>(msg.wParam)); st.result = false; break; } // app is quitting
        if (r < 0) break;
        if (!IsDialogMessageW(dlg, &msg)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    EnableWindow(owner, TRUE);
    DestroyWindow(dlg);
    SetActiveWindow(owner);
    return st.result;
}

static void OnClearAllMetadata() {
    if (g_isProcessing) return;
    if (g_files.empty()) {
        MessageBoxW(g_hWndMain, L"Please add files or a folder first.", APP_TITLE, MB_OK | MB_ICONINFORMATION);
        return;
    }

    // Snapshot the work so the worker thread never touches g_files.
    std::vector<Job> jobs;
    for (size_t i = 0; i < g_files.size(); i++) {
        if (!g_files[i].processed) {
            jobs.push_back(Job{ i, g_files[i].path, g_files[i].format });
        }
    }
    if (jobs.empty()) {
        MessageBoxW(g_hWndMain, L"All files in the list have already been cleaned.", APP_TITLE, MB_OK | MB_ICONINFORMATION);
        return;
    }

    // Warning + Proceed/Cancel + 3-second cancellable countdown. Nothing is touched before this returns true.
    if (!ConfirmAndCountdown(g_hWndMain, jobs.size())) return;

    g_isProcessing = true;
    SetControlsEnabled(false);

    const HWND hwnd = g_hWndMain;
    std::thread([jobs = std::move(jobs), hwnd]() {
        WPARAM okCount = 0;
        LPARAM failCount = 0;
        for (const Job& job : jobs) {
            auto res = std::make_unique<JobResult>();
            ProcessFile(job, *res);
            if (res->success) okCount++; else failCount++;
            JobResult* raw = res.release();
            if (!PostMessageW(hwnd, WM_APP_UPDATE_ITEM, 0, reinterpret_cast<LPARAM>(raw))) {
                delete raw;
            }
        }
        PostMessageW(hwnd, WM_APP_BATCH_DONE, okCount, failCount);
    }).detach();
}

static void OnDropFiles(HDROP hDrop) {
    if (g_isProcessing) { // list is locked while a batch runs
        DragFinish(hDrop);
        return;
    }

    const UINT count = DragQueryFileW(hDrop, 0xFFFFFFFF, nullptr, 0);
    SendMessageW(g_hListView, WM_SETREDRAW, FALSE, 0);

    for (UINT i = 0; i < count; i++) {
        const UINT len = DragQueryFileW(hDrop, i, nullptr, 0);
        if (len == 0) continue;
        std::wstring buf(static_cast<size_t>(len) + 1, L'\\0');
        DragQueryFileW(hDrop, i, &buf[0], len + 1);
        buf.resize(len);

        fs::path p(buf);
        std::error_code ec;
        if (fs::is_directory(p, ec)) {
            AddDirectoryToList(p);
        } else {
            AddFileToList(p);
        }
    }

    SendMessageW(g_hListView, WM_SETREDRAW, TRUE, 0);
    InvalidateRect(g_hListView, nullptr, TRUE);
    FitLastColumn();
    UpdateStatusBar();
    DragFinish(hDrop);
}

// -----------------------------------------------------------------------------
// Fonts & Window Sizing / Layout
// -----------------------------------------------------------------------------
static void RebuildFonts() {
    HFONT oldFont = g_hFont;
    HFONT oldBold = g_hFontBold;

    const int h = -MulDiv(9, static_cast<int>(g_dpi), 72); // 9 pt at current DPI
    g_hFont = CreateFontW(h, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                          DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                          CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
    g_hFontBold = CreateFontW(h, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                              DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                              CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");

    if (g_hBtnAddFolder)     SendMessageW(g_hBtnAddFolder, WM_SETFONT, reinterpret_cast<WPARAM>(g_hFont), TRUE);
    if (g_hBtnAddFile)       SendMessageW(g_hBtnAddFile, WM_SETFONT, reinterpret_cast<WPARAM>(g_hFont), TRUE);
    if (g_hBtnClearList)     SendMessageW(g_hBtnClearList, WM_SETFONT, reinterpret_cast<WPARAM>(g_hFont), TRUE);
    if (g_hBtnClearMetadata) SendMessageW(g_hBtnClearMetadata, WM_SETFONT, reinterpret_cast<WPARAM>(g_hFontBold), TRUE);
    if (g_hListView)         SendMessageW(g_hListView, WM_SETFONT, reinterpret_cast<WPARAM>(g_hFont), TRUE);
    if (g_hStatusBar)        SendMessageW(g_hStatusBar, WM_SETFONT, reinterpret_cast<WPARAM>(g_hFont), TRUE);

    if (oldFont) DeleteObject(oldFont);
    if (oldBold) DeleteObject(oldBold);
}

static void UpdateLayout(int width, int height) {
    if (!g_hListView || width <= 0 || height <= 0) return;

    const int margin = Scale(12);
    const int btnTopHeight = Scale(36);
    const int btnBottomHeight = Scale(44);

    // Status bar positions itself
    SendMessageW(g_hStatusBar, WM_SIZE, 0, 0);
    RECT sbRect = {};
    GetWindowRect(g_hStatusBar, &sbRect);
    const int statusBarHeight = sbRect.bottom - sbRect.top;

    int btnWidth = (width - (margin * 4)) / 3;
    if (btnWidth < Scale(80)) btnWidth = Scale(80);

    const int bottomBtnY = height - statusBarHeight - btnBottomHeight - margin;
    const int fullWidth = width - (margin * 2);
    const int listY = margin + btnTopHeight + margin;
    int listHeight = bottomBtnY - listY - margin;
    if (listHeight < Scale(100)) listHeight = Scale(100);

    // One batched move for all controls: a single repaint pass instead of one per control.
    const UINT flags = SWP_NOZORDER | SWP_NOACTIVATE;
    HDWP hdwp = BeginDeferWindowPos(5);
    if (hdwp) hdwp = DeferWindowPos(hdwp, g_hBtnAddFolder, nullptr, margin, margin, btnWidth, btnTopHeight, flags);
    if (hdwp) hdwp = DeferWindowPos(hdwp, g_hBtnAddFile, nullptr, margin * 2 + btnWidth, margin, btnWidth, btnTopHeight, flags);
    if (hdwp) hdwp = DeferWindowPos(hdwp, g_hBtnClearList, nullptr, margin * 3 + btnWidth * 2, margin, btnWidth, btnTopHeight, flags);
    if (hdwp) hdwp = DeferWindowPos(hdwp, g_hListView, nullptr, margin, listY, fullWidth, listHeight, flags);
    if (hdwp) hdwp = DeferWindowPos(hdwp, g_hBtnClearMetadata, nullptr, margin, bottomBtnY, fullWidth, btnBottomHeight, flags);
    if (hdwp) EndDeferWindowPos(hdwp);

    // Only the last column ("status") follows the window width; the others keep their size,
    // so resizing never forces the whole list to re-layout.
    FitLastColumn();
}

// -----------------------------------------------------------------------------
// Window Procedure
// -----------------------------------------------------------------------------
static LRESULT CALLBACK WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CREATE: {
            g_dpi = QueryWindowDpi(hWnd);

            g_hBtnAddFolder = CreateWindowExW(0, WC_BUTTONW, L"add folder",
                                              WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                              0, 0, 0, 0, hWnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BTN_ADD_FOLDER)),
                                              g_hInstance, nullptr);

            g_hBtnAddFile = CreateWindowExW(0, WC_BUTTONW, L"add file",
                                            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                            0, 0, 0, 0, hWnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BTN_ADD_FILE)),
                                            g_hInstance, nullptr);

            g_hBtnClearList = CreateWindowExW(0, WC_BUTTONW, L"clear list",
                                              WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                              0, 0, 0, 0, hWnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BTN_CLEAR_LIST)),
                                              g_hInstance, nullptr);

            // Plain push button (not DEFPUSHBUTTON): pressing Enter anywhere must never
            // trigger the destructive in-place action by accident.
            g_hBtnClearMetadata = CreateWindowExW(0, WC_BUTTONW, L"clear all metadata",
                                                  WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                                  0, 0, 0, 0, hWnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BTN_CLEAR_METADATA)),
                                                  g_hInstance, nullptr);

            g_hListView = CreateWindowExW(WS_EX_CLIENTEDGE, WC_LISTVIEWW, L"",
                                          WS_CHILD | WS_VISIBLE | WS_TABSTOP | LVS_REPORT | LVS_SHOWSELALWAYS,
                                          0, 0, 0, 0, hWnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_MAIN_LISTVIEW)),
                                          g_hInstance, nullptr);

            ListView_SetExtendedListViewStyle(g_hListView, LVS_EX_FULLROWSELECT | LVS_EX_GRIDLINES | LVS_EX_DOUBLEBUFFER);

            LVCOLUMNW lvc = {};
            lvc.mask = LVCF_TEXT | LVCF_WIDTH | LVCF_SUBITEM;
            const wchar_t* names[5] = { L"filename", L"type", L"file size", L"location", L"status" };
            const int widths[5] = { kDefaultColumnWidths[0], kDefaultColumnWidths[1], kDefaultColumnWidths[2], kDefaultColumnWidths[3], 120 };
            for (int c = 0; c < 5; c++) {
                lvc.pszText = const_cast<LPWSTR>(names[c]);
                lvc.cx = Scale(widths[c]);
                lvc.iSubItem = c;
                ListView_InsertColumn(g_hListView, c, &lvc);
            }

            g_hStatusBar = CreateWindowExW(0, STATUSCLASSNAMEW, nullptr,
                                           WS_CHILD | WS_VISIBLE | SBARS_SIZEGRIP,
                                           0, 0, 0, 0, hWnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_STATUSBAR)),
                                           g_hInstance, nullptr);

            RebuildFonts();
            DragAcceptFiles(hWnd, TRUE);
            UpdateStatusBar();
            return 0;
        }

        case WM_SIZE: {
            if (wParam != SIZE_MINIMIZED) UpdateLayout(LOWORD(lParam), HIWORD(lParam));
            return 0;
        }

        case WM_DPICHANGED: {
            g_dpi = HIWORD(wParam);
            RebuildFonts();
            ApplyDefaultColumnWidths();
            const RECT* r = reinterpret_cast<const RECT*>(lParam);
            SetWindowPos(hWnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                         SWP_NOZORDER | SWP_NOACTIVATE);
            RECT rc;
            GetClientRect(hWnd, &rc);
            UpdateLayout(rc.right, rc.bottom);
            return 0;
        }

        case WM_GETMINMAXINFO: {
            LPMINMAXINFO lpMMI = reinterpret_cast<LPMINMAXINFO>(lParam);
            lpMMI->ptMinTrackSize.x = Scale(700);
            lpMMI->ptMinTrackSize.y = Scale(480);
            return 0;
        }

        case WM_DROPFILES: {
            OnDropFiles(reinterpret_cast<HDROP>(wParam));
            return 0;
        }

        case WM_COMMAND: {
            if (HIWORD(wParam) != BN_CLICKED) break;
            switch (LOWORD(wParam)) {
                case IDC_BTN_ADD_FOLDER:     OnAddFolder();        break;
                case IDC_BTN_ADD_FILE:       OnAddFiles();         break;
                case IDC_BTN_CLEAR_LIST:     OnClearList();        break;
                case IDC_BTN_CLEAR_METADATA: OnClearAllMetadata(); break;
                case IDM_REMOVE_SELECTED:    RemoveSelected();     break;
                case IDM_SELECT_ALL:         SelectAllRows();      break;
            }
            return 0;
        }

        case WM_CONTEXTMENU: {
            if (reinterpret_cast<HWND>(wParam) == g_hListView) {
                ShowListContextMenu(static_cast<short>(LOWORD(lParam)), static_cast<short>(HIWORD(lParam)));
                return 0;
            }
            break;
        }

        case WM_APP_UPDATE_ITEM: {
            std::unique_ptr<JobResult> res(reinterpret_cast<JobResult*>(lParam));
            if (res && res->index < g_files.size()) {
                FileEntry& item = g_files[res->index];
                item.status = res->status;
                item.success = res->success;
                item.processed = res->success;
                item.originalSize = res->originalSize ? res->originalSize : item.originalSize;
                item.cleanedSize = res->success ? res->cleanedSize : 0;

                const int idx = static_cast<int>(res->index);
                ListView_SetItemText(g_hListView, idx, 4, const_cast<LPWSTR>(item.status.c_str()));
                const std::wstring sizeStr = FormatFileSize(res->success ? res->cleanedSize : item.originalSize);
                ListView_SetItemText(g_hListView, idx, 2, const_cast<LPWSTR>(sizeStr.c_str()));
                UpdateStatusBar();
            }
            return 0;
        }

        case WM_APP_BATCH_DONE: {
            g_isProcessing = false;
            SetControlsEnabled(true);
            UpdateStatusBar();

            const size_t ok = static_cast<size_t>(wParam);
            const size_t failed = static_cast<size_t>(lParam);
            std::wstring text = L"Processed " + std::to_wstring(ok + failed) + L" file(s).\\n\\nSucceeded: " +
                                std::to_wstring(ok);
            if (failed) text += L"\\nFailed: " + std::to_wstring(failed) + L" (see the status column)";
            MessageBoxW(hWnd, text.c_str(), APP_TITLE, MB_OK | (failed ? MB_ICONWARNING : MB_ICONINFORMATION));
            return 0;
        }

        case WM_APP_UPDATE_FOUND: {
            std::unique_ptr<UpdateInfo> info(reinterpret_cast<UpdateInfo*>(lParam));
            if (info && !info->version.empty()) {
                const std::wstring text = L"A newer ClearMD release is available: " + info->version +
                                          L"\\n\\nYou are running " + CurrentVersionString() + L".\\n\\n" +
                                          L"Open the release page to download it?";
                if (MessageBoxW(hWnd, text.c_str(), L"Update available",
                                MB_YESNO | MB_ICONINFORMATION | MB_DEFBUTTON1) == IDYES) {
                    ShellExecuteW(hWnd, L"open", info->url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                }
            }
            return 0;
        }

        case WM_CLOSE: {
            if (g_isProcessing) {
                MessageBoxW(hWnd, L"Files are still being cleaned. Please wait for the batch to finish.",
                            APP_TITLE, MB_OK | MB_ICONINFORMATION);
                return 0;
            }
            DestroyWindow(hWnd);
            return 0;
        }

        case WM_DESTROY: {
            DragAcceptFiles(hWnd, FALSE);
            if (g_hFont) DeleteObject(g_hFont);
            if (g_hFontBold) DeleteObject(g_hFontBold);
            PostQuitMessage(0);
            return 0;
        }
    }

    return DefWindowProcW(hWnd, msg, wParam, lParam);
}

// -----------------------------------------------------------------------------
// Application Entry Point
// -----------------------------------------------------------------------------
int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPWSTR lpCmdLine, int nCmdShow) {
    UNREFERENCED_PARAMETER(hPrevInstance);
    UNREFERENCED_PARAMETER(lpCmdLine);

    g_hInstance = hInstance;

    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr)) return 1;

    INITCOMMONCONTROLSEX icex;
    icex.dwSize = sizeof(INITCOMMONCONTROLSEX);
    icex.dwICC = ICC_LISTVIEW_CLASSES | ICC_BAR_CLASSES | ICC_PROGRESS_CLASS | ICC_STANDARD_CLASSES;
    InitCommonControlsEx(&icex);

    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(WNDCLASSEXW);
    wc.style = 0; // no CS_HREDRAW/CS_VREDRAW: they force a full repaint of every control on each resize step
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.hIcon = static_cast<HICON>(LoadImageW(hInstance, MAKEINTRESOURCEW(IDI_APP_ICON), IMAGE_ICON,
                                             GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), LR_DEFAULTCOLOR));
    wc.hIconSm = static_cast<HICON>(LoadImageW(hInstance, MAKEINTRESOURCEW(IDI_APP_ICON), IMAGE_ICON,
                                               GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));
    if (!wc.hIcon) wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    if (!wc.hIconSm) wc.hIconSm = wc.hIcon;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = reinterpret_cast<HBRUSH>(static_cast<INT_PTR>(COLOR_BTNFACE + 1));
    wc.lpszClassName = L"ClearMDWindowClass";

    if (!RegisterClassExW(&wc)) {
        CoUninitialize();
        return 1;
    }

    g_hWndMain = CreateWindowExW(
        WS_EX_ACCEPTFILES,
        wc.lpszClassName,
        APP_TITLE,
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
        CW_USEDEFAULT, CW_USEDEFAULT, 820, 620,
        nullptr, nullptr, hInstance, nullptr
    );

    if (!g_hWndMain) {
        CoUninitialize();
        return 1;
    }

    // Initial size is in 96-DPI units; scale it for the monitor we landed on.
    SetWindowPos(g_hWndMain, nullptr, 0, 0, Scale(820), Scale(620), SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);

    ShowWindow(g_hWndMain, nCmdShow);
    UpdateWindow(g_hWndMain);

    // Every launch, off the UI thread. Failures are silent.
    CheckForUpdatesAsync(g_hWndMain);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        if (msg.message == WM_KEYDOWN && (msg.hwnd == g_hWndMain || IsChild(g_hWndMain, msg.hwnd))) {
            if (msg.wParam == VK_DELETE) { RemoveSelected(); continue; }                       // Delete = remove selected rows
            if (msg.wParam == 'A' && (GetKeyState(VK_CONTROL) & 0x8000)) { SelectAllRows(); continue; } // Ctrl+A
        }
        if (IsDialogMessageW(g_hWndMain, &msg)) continue; // Tab / arrow-key navigation
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    CoUninitialize();
    return static_cast<int>(msg.wParam);
}
`;

const RESOURCE_RC = `#include <windows.h>
#include "resource.h"

// Application icon (first icon resource is the one Explorer shows for the .exe)
IDI_APP_ICON ICON "ClearMD.ico"

// Enable Windows Common Controls v6 (Visual Styles)
1 24 "manifest.xml"

// Version Information
VS_VERSION_INFO VERSIONINFO
FILEVERSION     VER_FILE_VERSION
PRODUCTVERSION  VER_PRODUCT_VERSION
FILEFLAGSMASK   0x3fL
#ifdef _DEBUG
FILEFLAGS       0x1L
#else
FILEFLAGS       0x0L
#endif
FILEOS          0x40004L
FILETYPE        0x1L
FILESUBTYPE     0x0L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName",      VER_COMPANYNAME_STR
            VALUE "FileDescription",  VER_FILEDESCRIPTION_STR
            VALUE "FileVersion",      VER_FILE_VERSION_STR
            VALUE "InternalName",     VER_INTERNALNAME_STR
            VALUE "LegalCopyright",   VER_LEGALCOPYRIGHT_STR
            VALUE "OriginalFilename", VER_ORIGINALFILENAME_STR
            VALUE "ProductName",      VER_PRODUCTNAME_STR
            VALUE "ProductVersion",   VER_PRODUCT_VERSION_STR
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x409, 1200
    END
END
`;

const BUILD_MSVC = `@echo off
setlocal
echo =======================================================
echo Building ClearMD (MSVC / cl.exe - 100%% Standalone C++)
echo =======================================================

where cl >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: cl.exe not found in PATH.
    echo Please open the "x64 Native Tools Command Prompt for VS 2022 / 2019" and re-run.
    exit /b 1
)

rc /nologo /fo ClearMD.res ClearMD.rc
if %errorlevel% neq 0 (
    echo Resource compilation failed.
    exit /b %errorlevel%
)

cl /W4 /std:c++17 /EHsc /O2 /DUNICODE /D_UNICODE /permissive- /utf-8 ^
   ClearMD.cpp ClearMD.res ^
   /link /SUBSYSTEM:WINDOWS /MACHINE:X64 ^
   user32.lib gdi32.lib comctl32.lib ole32.lib shell32.lib oleaut32.lib ^
   /OUT:ClearMD.exe

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] Built ClearMD.exe cleanly with /W4 and zero warnings.
) else (
    echo.
    echo [ERROR] Build failed.
)
endlocal
`;

const BUILD_MINGW = `@echo off
setlocal
echo =======================================================
echo Building ClearMD (MinGW-w64 / g++ - 100%% Standalone C++)
echo =======================================================

where g++ >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: g++ not found in PATH.
    exit /b 1
)

windres ClearMD.rc -O coff -o ClearMD.res.o
if %errorlevel% neq 0 (
    echo Resource compilation failed.
    exit /b %errorlevel%
)

g++ -Wall -Wextra -std=c++17 -O2 -s -municode -mwindows -static -static-libgcc -static-libstdc++ ^
    ClearMD.cpp ClearMD.res.o ^
    -lcomctl32 -lole32 -lshell32 -loleaut32 -lgdi32 -luser32 -luuid ^
    -o ClearMD.exe

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] Built ClearMD.exe cleanly with -Wall -Wextra.
) else (
    echo.
    echo [ERROR] Build failed.
)
endlocal
`;

const RESOURCE_H = `#pragma once

#define IDC_MAIN_LISTVIEW       1001
#define IDC_BTN_ADD_FOLDER      1002
#define IDC_BTN_ADD_FILE        1003
#define IDC_BTN_CLEAR_LIST      1004
#define IDC_BTN_CLEAR_METADATA  1005
#define IDC_STATUSBAR           1006
#define IDC_PROGRESSBAR         1007

#define IDI_APP_ICON            2001

#define IDC_CONFIRM_PROCEED     4001
#define IDC_CONFIRM_CANCEL      4002
#define IDC_CONFIRM_PROGRESS    4003

// Title bar text (shows the app version)
#define APP_TITLE               L"ClearMD v1.0"

#define IDM_REMOVE_SELECTED     3001
#define IDM_SELECT_ALL          3002

// File Versioning: bump 4th digit on each prompt
#define VER_FILE_VERSION_MAJOR      1
#define VER_FILE_VERSION_MINOR      0
#define VER_FILE_VERSION_BUILD      0
#define VER_FILE_VERSION_REVISION   6

#define VER_FILE_VERSION            1,0,0,6
#define VER_FILE_VERSION_STR        "1.0.0.6"

#define VER_PRODUCT_VERSION_MAJOR    1
#define VER_PRODUCT_VERSION_MINOR    0
#define VER_PRODUCT_VERSION_BUILD    0
#define VER_PRODUCT_VERSION_REVISION 6

#define VER_PRODUCT_VERSION         1,0,0,6
#define VER_PRODUCT_VERSION_STR     "1.0.0.6"

#define VER_COMPANYNAME_STR         "ClearMD Open Source"
#define VER_FILEDESCRIPTION_STR     "ClearMD - Lossless Metadata Stripper"
#define VER_INTERNALNAME_STR        "ClearMD"
#define VER_LEGALCOPYRIGHT_STR      "Copyright (C) 2026 ClearMD Contributors"
#define VER_ORIGINALFILENAME_STR    "ClearMD.exe"
#define VER_PRODUCTNAME_STR         "ClearMD"
`;

const MANIFEST_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity
      version="1.0.0.6"
      processorArchitecture="*"
      name="ClearMD.ClearMDApp"
      type="win32"
  />
  <description>ClearMD - Lossless Metadata Stripper</description>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
          type="win32"
          name="Microsoft.Windows.Common-Controls"
          version="6.0.0.0"
          processorArchitecture="*"
          publicKeyToken="6595b64144ccf1df"
          language="*"
      />
    </dependentAssembly>
  </dependency>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <!-- Windows 10 and 11 DPI Awareness + long path support -->
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
`;

const CMAKE_TXT = `cmake_minimum_required(VERSION 3.16)
project(ClearMD VERSION 1.0.0.6 LANGUAGES CXX RC)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
    add_compile_options(/W4 /permissive- /utf-8 /DUNICODE /D_UNICODE)
else()
    add_compile_options(-Wall -Wextra -DUNICODE -D_UNICODE)
endif()

add_executable(ClearMD WIN32
    ClearMD.cpp
    ClearMD.rc
    resource.h
    ClearMD.ico
)
# manifest.xml is embedded via ClearMD.rc; do NOT also list it as a source (duplicate-manifest link error on MSVC)

if(NOT MSVC)
    target_link_options(ClearMD PRIVATE -municode -static -static-libgcc -static-libstdc++)
endif()

target_link_libraries(ClearMD PRIVATE
    user32
    gdi32
    comctl32
    ole32
    shell32
    oleaut32
    uuid
)
`;

const ICON_B64 = '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';

export const CppSourceViewer: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'cpp' | 'rc' | 'msvc' | 'mingw'>('cpp');
  const [copied, setCopied] = useState(false);

  const getActiveCode = () => {
    switch (activeTab) {
      case 'cpp': return CPP_CODE;
      case 'rc': return RESOURCE_RC;
      case 'msvc': return BUILD_MSVC;
      case 'mingw': return BUILD_MINGW;
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(getActiveCode());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadZip = () => {
    const zip = new SimpleZip();
    zip.addFile('ClearMD.cpp', CPP_CODE);
    zip.addFile('ClearMD.rc', RESOURCE_RC);
    zip.addFile('build_msvc.bat', BUILD_MSVC);
    zip.addFile('build_mingw.bat', BUILD_MINGW);
    zip.addFile('resource.h', RESOURCE_H);
    zip.addFile('ClearMD.ico', Uint8Array.from(atob(ICON_B64), (c) => c.charCodeAt(0)));
    zip.addFile('manifest.xml', MANIFEST_XML);
    zip.addFile('CMakeLists.txt', CMAKE_TXT);
    zip.addFile('README.md', '# ClearMD C++17 Project\n\nCompile with build_msvc.bat or build_mingw.bat (run from this folder).\n');

    const blob = zip.generateBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ClearMD_Cpp17_Standalone_v1.0.0.6.zip';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl text-slate-100">
      {/* Top Banner */}
      <div className="p-4 bg-slate-950/80 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-600/10 border border-blue-500/30 flex items-center justify-center text-blue-400">
            <FileCode className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-100 flex items-center gap-2">
              Standalone C++17 Windows Source Project
              <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                v1.0.0.6
              </span>
            </h3>
            <p className="text-xs text-slate-400">
              Zero external dependencies &bull; MSVC /W4 clean &bull; MinGW-w64 -Wall -Wextra clean
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition-colors cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy File'}
          </button>
          <button
            onClick={handleDownloadZip}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors shadow-sm cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Download Complete C++ Project (.zip)
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 bg-slate-950/40 px-3 pt-2">
        <button
          onClick={() => setActiveTab('cpp')}
          className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-2 ${
            activeTab === 'cpp'
              ? 'border-blue-500 text-blue-400 bg-slate-800/40'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <FileCode className="w-3.5 h-3.5" /> ClearMD.cpp
        </button>
        <button
          onClick={() => setActiveTab('rc')}
          className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-2 ${
            activeTab === 'rc'
              ? 'border-blue-500 text-blue-400 bg-slate-800/40'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <FileCode className="w-3.5 h-3.5" /> ClearMD.rc
        </button>
        <button
          onClick={() => setActiveTab('msvc')}
          className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-2 ${
            activeTab === 'msvc'
              ? 'border-blue-500 text-blue-400 bg-slate-800/40'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" /> build_msvc.bat
        </button>
        <button
          onClick={() => setActiveTab('mingw')}
          className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-2 ${
            activeTab === 'mingw'
              ? 'border-blue-500 text-blue-400 bg-slate-800/40'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" /> build_mingw.bat
        </button>
      </div>

      {/* Code Editor Body */}
      <div className="p-4 bg-slate-950 font-mono text-xs text-slate-300 overflow-x-auto max-h-[520px] overflow-y-auto leading-relaxed select-text">
        <pre>{getActiveCode()}</pre>
      </div>

      {/* Footer Info */}
      <div className="p-3 bg-slate-950/80 border-t border-slate-800 text-xs text-slate-400 flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          Native Win32 WinMain &bull; Common Controls v6 &bull; Shell IFileOpenDialog &bull; DragAcceptFiles
        </span>
        <span className="font-mono text-slate-500">
          File Version: 1.0.0.6
        </span>
      </div>
    </div>
  );
};
