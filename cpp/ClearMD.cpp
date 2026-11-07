/**
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
                std::memcmp(&src[i + 2], "ICC_PROFILE\0", 12) == 0) {
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

// Removes self-closing XML elements that start with `startTag` and whose text contains `needle`.
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
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n"
        "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" "
        "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" "
        "xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"/>";
    static const char kApp[] =
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n"
        "<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" "
        "xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"/>";
    static const char kCustom[] =
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n"
        "<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/custom-properties\" "
        "xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"/>";

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
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<office:document-meta xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" "
        "office:version=\"1.2\"><office:meta/></office:document-meta>";

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
            while (i < to && d[i] != '\n' && d[i] != '\r') i++;
        } else if (c == '(') {
            int depth = 1;
            i++;
            while (i < to && depth > 0) {
                const uint8_t ch = d[i];
                if (ch == '\\' && i + 1 < to) { d[i] = ' '; d[i + 1] = ' '; i += 2; continue; }
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
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">"
        "<rdf:Description rdf:about=\"\"/></rdf:RDF></x:xmpmeta>";
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

    auto isSpace = [](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
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
            else if (c == '"' || c == '\'') quote = c;
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
                if (ve < q && (s[ve] == '"' || s[ve] == '\'')) {
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
    std::wstring out(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), &out[0], n);
    return out;
}

// Minimal JSON lookup: the response is small and only two string fields are
// needed, so a full parser would be far more code than the job requires.
static bool JsonStringField(const std::string& json, const char* key, std::string& value) {
    const std::string pattern = std::string("\"") + key + "\"";
    size_t i = json.find(pattern);
    if (i == std::string::npos) return false;
    i += pattern.size();
    while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\r' || json[i] == '\n')) i++;
    if (i >= json.size() || json[i] != ':') return false;
    i++;
    while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\r' || json[i] == '\n')) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;

    value.clear();
    while (i < json.size()) {
        const char c = json[i++];
        if (c == '"') return true;
        if (c != '\\' || i >= json.size()) { value.push_back(c); continue; }
        const char esc = json[i++];
        switch (esc) {
            case 'n': value.push_back('\n'); break;
            case 'r': value.push_back('\r'); break;
            case 't': value.push_back('\t'); break;
            case 'b': value.push_back('\b'); break;
            case 'f': value.push_back('\f'); break;
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
            const wchar_t* headers = L"Accept: application/vnd.github+json\r\n";
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
    AppendMenuW(menu, MF_STRING | enabledSel, IDM_REMOVE_SELECTED, L"Remove from list\tDel");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING | enabledAll, IDM_SELECT_ALL, L"Select all\tCtrl+A");
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
        std::wstring buf(static_cast<size_t>(len) + 1, L'\0');
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
            std::wstring text = L"Processed " + std::to_wstring(ok + failed) + L" file(s).\n\nSucceeded: " +
                                std::to_wstring(ok);
            if (failed) text += L"\nFailed: " + std::to_wstring(failed) + L" (see the status column)";
            MessageBoxW(hWnd, text.c_str(), APP_TITLE, MB_OK | (failed ? MB_ICONWARNING : MB_ICONINFORMATION));
            return 0;
        }

        case WM_APP_UPDATE_FOUND: {
            std::unique_ptr<UpdateInfo> info(reinterpret_cast<UpdateInfo*>(lParam));
            if (info && !info->version.empty()) {
                const std::wstring text = L"A newer ClearMD release is available: " + info->version +
                                          L"\n\nYou are running " + CurrentVersionString() + L".\n\n" +
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
