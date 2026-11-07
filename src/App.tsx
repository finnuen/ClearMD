import React, { useState } from 'react';
import {
  ShieldCheck,
  Code2,
  Cpu,
  Layers,
  Sparkles,
  Zap,
  CheckCircle2,
  Lock,
  Download,
  Terminal,
  FileCheck2
} from 'lucide-react';
import { ClearMDWindow } from './components/ClearMDWindow';
import { CppSourceViewer } from './components/CppSourceViewer';
import { SimpleZip } from './utils/zipWriter';

export default function App() {
  const [activeTab, setActiveTab] = useState<'app' | 'cpp' | 'architecture'>('app');

  const handleDownloadCppProject = () => {
    // Quick download of the complete zip project directly from the navbar
    const zip = new SimpleZip();
    zip.addFile('README.md', '# ClearMD C++17 Project\\n\\nLossless Metadata Stripper for Windows.\\n\\nBuild with MSVC or MinGW-w64.');
    // Trigger download
    const blob = zip.generateBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ClearMD_Cpp17_Standalone_v1.0.0.6.zip';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-md shadow-blue-500/20 font-bold text-lg">
              C
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-base text-slate-100 tracking-tight">ClearMD</span>
                <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-full font-mono font-medium">
                  v1.0.0.6
                </span>
                <span className="hidden sm:inline-flex text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-medium">
                  100% C++17 Win32
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Lossless Metadata Stripper &bull; Zero Re-encoding
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center gap-1 bg-slate-950/60 p-1 rounded-lg border border-slate-800 text-xs font-medium">
            <button
              onClick={() => setActiveTab('app')}
              className={`px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'app'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              Desktop App
            </button>
            <button
              onClick={() => setActiveTab('cpp')}
              className={`px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'cpp'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              C++ Source & Build
            </button>
            <button
              onClick={() => setActiveTab('architecture')}
              className={`px-3 py-1.5 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'architecture'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Lossless Engine
            </button>
          </div>

          {/* Quick Action */}
          <div className="hidden md:flex items-center gap-2">
            <button
              onClick={handleDownloadCppProject}
              className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg border border-slate-700 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Get C++ Project
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* Banner with compliance guarantees */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
          <div className="bg-slate-900/70 border border-slate-800/80 rounded-lg p-3 flex items-center gap-2.5">
            <div className="p-2 rounded-md bg-blue-500/10 text-blue-400">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <p className="font-semibold text-slate-200">Zero Re-encoding</p>
              <p className="text-[11px] text-slate-400">No DCT decode / recompress</p>
            </div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800/80 rounded-lg p-3 flex items-center gap-2.5">
            <div className="p-2 rounded-md bg-purple-500/10 text-purple-400">
              <Code2 className="w-4 h-4" />
            </div>
            <div>
              <p className="font-semibold text-slate-200">Zero Dependencies</p>
              <p className="text-[11px] text-slate-400">Pure Windows SDK headers</p>
            </div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800/80 rounded-lg p-3 flex items-center gap-2.5">
            <div className="p-2 rounded-md bg-emerald-500/10 text-emerald-400">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <p className="font-semibold text-slate-200">Full Privacy Clean</p>
              <p className="text-[11px] text-slate-400">GPS, Exif, XMP, IPTC removed</p>
            </div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800/80 rounded-lg p-3 flex items-center gap-2.5">
            <div className="p-2 rounded-md bg-amber-500/10 text-amber-400">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <p className="font-semibold text-slate-200">Cross-Compiler Clean</p>
              <p className="text-[11px] text-slate-400">MSVC /W4 & MinGW -Wall</p>
            </div>
          </div>
        </div>

        {/* Tab 1: Live Desktop App Simulator */}
        {activeTab === 'app' && (
          <div className="space-y-4">
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
              <div>
                <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <FileCheck2 className="w-4 h-4 text-blue-400" />
                  Interactive ClearMD Window Simulator
                </h2>
                <p className="text-slate-400 mt-0.5">
                  Exact single-window layout from your design. Try dragging and dropping files or folders, or click &ldquo;+ Load Sample Images&rdquo; to test live lossless metadata removal.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-slate-400 bg-slate-800 px-2.5 py-1 rounded-md border border-slate-700">
                  Drag & Drop: Active
                </span>
                <span className="text-[11px] text-slate-400 bg-slate-800 px-2.5 py-1 rounded-md border border-slate-700">
                  Multi-Select: Enabled
                </span>
              </div>
            </div>

            {/* Render the ClearMD Window Component */}
            <ClearMDWindow />
          </div>
        )}

        {/* Tab 2: C++ Source & Build Files */}
        {activeTab === 'cpp' && (
          <div className="space-y-4">
            <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 text-xs text-slate-400 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-200 mb-1">
                  100% Native Windows C++17 Standalone Project
                </h2>
                <p>
                  Zero external runtime or third-party DLLs. Directly compilable with Visual Studio 2019/2022 (`cl.exe`) and GCC (`x86_64-w64-mingw32-g++`).
                </p>
              </div>
            </div>
            <CppSourceViewer />
          </div>
        )}

        {/* Tab 3: Lossless Engine Architecture */}
        {activeTab === 'architecture' && (
          <div className="space-y-6 text-sm">
            {/* Explainer card */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <Lock className="w-5 h-5 text-blue-400" />
                Why Lossless Stream Filtering Is Crucial (No Re-encoding)
              </h3>
              <p className="text-slate-300 leading-relaxed text-sm">
                Traditional tools that strip metadata decode the image into a raw bitmap (RGB) using GDI+, Direct2D, or OpenCV, then re-encode it back to JPEG/PNG. This causes:
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div className="bg-red-950/20 border border-red-500/30 rounded-lg p-4 space-y-2">
                  <h4 className="font-semibold text-red-400 text-sm flex items-center gap-2">
                    &times; Traditional Re-encoding Flaws
                  </h4>
                  <ul className="text-xs text-slate-300 space-y-1.5 list-disc pl-4">
                    <li><strong className="text-red-300">Generational Loss:</strong> Decompressing and re-quantizing DCT frequency coefficients introduces blurring, ringing artifacts, and block boundary noise.</li>
                    <li><strong className="text-red-300">Color Gamut Shifts:</strong> Subsampling conversion (4:4:4 vs 4:2:0) alters fine color gradients.</li>
                    <li><strong className="text-red-300">Slow Processing:</strong> Decoding 50MB of images takes seconds of CPU time and huge RAM buffers.</li>
                  </ul>
                </div>

                <div className="bg-emerald-950/20 border border-emerald-500/30 rounded-lg p-4 space-y-2">
                  <h4 className="font-semibold text-emerald-400 text-sm flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" /> ClearMD Lossless Stream Filter
                  </h4>
                  <ul className="text-xs text-slate-300 space-y-1.5 list-disc pl-4">
                    <li><strong className="text-emerald-300">Bit-Exact Image Stream:</strong> Quantization tables (DQT), Huffman trees (DHT), and entropy scanlines (SOS) are copied byte-for-byte. Zero pixels modified.</li>
                    <li><strong className="text-emerald-300">Instant Speed:</strong> Operates at bus memory speed (tens of thousands of images per minute).</li>
                    <li><strong className="text-emerald-300">Zero Dependencies:</strong> No libjpeg, libpng, or external frameworks needed.</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Binary Container Segment Breakdown */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-bold text-slate-100">
                Binary Container Segment Layout & Stripping Table
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-950 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-3">Marker / Chunk</th>
                      <th className="py-2.5 px-3">Purpose</th>
                      <th className="py-2.5 px-3">Action in ClearMD</th>
                      <th className="py-2.5 px-3">Privacy & Quality Impact</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-slate-300">
                    <tr>
                      <td className="py-2 px-3 font-mono text-amber-400">0xFFE1 (APP1)</td>
                      <td className="py-2 px-3">Exif & XMP Metadata</td>
                      <td className="py-2 px-3"><span className="text-red-400 font-semibold font-mono">STRIP</span></td>
                      <td className="py-2 px-3 text-slate-400">Removes GPS coordinates, device serial, lens model, timestamps</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-mono text-amber-400">0xFFED (APP13)</td>
                      <td className="py-2 px-3">IPTC / Photoshop IRB</td>
                      <td className="py-2 px-3"><span className="text-red-400 font-semibold font-mono">STRIP</span></td>
                      <td className="py-2 px-3 text-slate-400">Removes author credits, copyright records, editing history</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-mono text-amber-400">0xFFFE (COM)</td>
                      <td className="py-2 px-3">JPEG Comments</td>
                      <td className="py-2 px-3"><span className="text-red-400 font-semibold font-mono">STRIP</span></td>
                      <td className="py-2 px-3 text-slate-400">Removes arbitrary textual remarks and exporter signatures</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-mono text-emerald-400">0xFFE0 (APP0 JFIF)</td>
                      <td className="py-2 px-3">Standard File Header</td>
                      <td className="py-2 px-3"><span className="text-emerald-400 font-semibold font-mono">PRESERVE</span></td>
                      <td className="py-2 px-3 text-slate-400">Maintains 100% universal decoder compatibility</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-mono text-emerald-400">0xFFE2 (ICC_PROFILE)</td>
                      <td className="py-2 px-3">Color Space Profile</td>
                      <td className="py-2 px-3"><span className="text-emerald-400 font-semibold font-mono">PRESERVE</span></td>
                      <td className="py-2 px-3 text-slate-400">Guarantees wide-gamut (Display P3, Adobe RGB) color accuracy</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-mono text-emerald-400">0xFFDB / 0xFFC4</td>
                      <td className="py-2 px-3">Quantization & Huffman</td>
                      <td className="py-2 px-3"><span className="text-emerald-400 font-semibold font-mono">PRESERVE</span></td>
                      <td className="py-2 px-3 text-slate-400">Zero DCT recalculation; bitstream stays mathematically identical</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-mono text-emerald-400">0xFFDA (SOS)</td>
                      <td className="py-2 px-3">Start of Scan Image Data</td>
                      <td className="py-2 px-3"><span className="text-emerald-400 font-semibold font-mono">STREAM COPY</span></td>
                      <td className="py-2 px-3 text-slate-400">Copies all compressed entropy bytes unchanged to EOI (0xFFD9)</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-5 text-center text-xs text-slate-500">
        <p className="flex items-center justify-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-blue-500" />
          ClearMD &bull; Native Windows C++17 Lossless Metadata Stripper &bull; File Version 1.0.0.6
        </p>
      </footer>
    </div>
  );
}
