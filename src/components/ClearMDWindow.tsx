import React, { useState, useRef, DragEvent, ChangeEvent } from 'react';
import {
  FolderPlus,
  FilePlus,
  Trash2,
  Sparkles,
  Download,
  Eye,
  CheckCircle2,
  AlertCircle,
  FileImage,
  UploadCloud,
  Minus,
  Square,
  X
} from 'lucide-react';
import {
  processLosslessStripping,
  StrippingResult,
  ExtractedMetadata,
} from '../utils/losslessStripper';
import { createSampleJpeg, createSamplePng } from '../utils/sampleImages';
import { SimpleZip } from '../utils/zipWriter';
import { MetadataInspector } from './MetadataInspector';

export interface FileItem {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  location: string;
  format: 'JPEG' | 'PNG' | 'WebP' | 'Other';
  status: 'Ready' | 'Processing' | 'Cleaned' | 'Error';
  cleanedBlob?: Blob;
  cleanedSize?: number;
  bytesSaved?: number;
  metadata?: ExtractedMetadata;
  error?: string;
}

export const ClearMDWindow: React.FC = () => {
  const [items, setItems] = useState<FileItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [inspectorItem, setInspectorItem] = useState<FileItem | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const getFormat = (filename: string): 'JPEG' | 'PNG' | 'WebP' | 'Other' => {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'JPEG';
    if (lower.endsWith('.png')) return 'PNG';
    if (lower.endsWith('.webp')) return 'WebP';
    return 'Other';
  };

  const getFormatLabel = (fmt: 'JPEG' | 'PNG' | 'WebP' | 'Other') => {
    switch (fmt) {
      case 'JPEG': return 'JPEG image';
      case 'PNG': return 'PNG image';
      case 'WebP': return 'WebP image';
      default: return 'Image / File';
    }
  };

  const addFilesToState = (newFiles: File[], defaultLocation = 'C:\\Users\\User\\Pictures') => {
    const newItems: FileItem[] = [];

    for (const f of newFiles) {
      // Determine simulated location from webkitRelativePath if available
      let loc = defaultLocation;
      if (f.webkitRelativePath) {
        const parts = f.webkitRelativePath.split('/');
        parts.pop(); // Remove filename
        if (parts.length > 0) {
          loc = `C:\\${parts.join('\\')}`;
        }
      }

      // Avoid duplicates
      const exists = items.some(
        (existing) => existing.name === f.name && existing.size === f.size && existing.location === loc
      );
      if (!exists) {
        newItems.push({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          file: f,
          name: f.name,
          type: getFormatLabel(getFormat(f.name)),
          size: f.size,
          location: loc,
          format: getFormat(f.name),
          status: 'Ready',
        });
      }
    }

    if (newItems.length > 0) {
      setItems((prev) => [...prev, ...newItems]);
    }
  };

  // Handle Drag & Drop
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFiles: File[] = Array.from(e.dataTransfer.files);
      addFilesToState(droppedFiles, 'C:\\Users\\User\\Downloads\\DropFolder');
    }
  };

  // Add Files (multi-select)
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selected = Array.from(e.target.files);
      addFilesToState(selected, 'C:\\Users\\User\\Pictures');
    }
    // Reset input so same file can be re-selected
    e.target.value = '';
  };

  // Add Folder (webkitdirectory)
  const handleFolderChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selected = Array.from(e.target.files);
      addFilesToState(selected, 'C:\\Users\\User\\FolderImport');
    }
    e.target.value = '';
  };

  // Load Built-in Test Samples
  const handleLoadSamples = () => {
    const sample1 = createSampleJpeg('IMG_2026_Vacation_GPS.jpg', 'C:\\DCIM\\100APPLE');
    const sample2 = createSampleJpeg('Camera_Raw_Landscape.jpeg', 'C:\\Photos\\Export_2026');
    const sample3 = createSamplePng('Confidential_Diagram.png', 'C:\\Projects\\ClearMD');

    const file1 = new File([sample1.blob], sample1.name, { type: 'image/jpeg' });
    const file2 = new File([sample2.blob], sample2.name, { type: 'image/jpeg' });
    const file3 = new File([sample3.blob], sample3.name, { type: 'image/png' });

    addFilesToState([file1, file2, file3], 'C:\\DCIM\\Samples');
  };

  // Clear list
  const handleClearList = () => {
    if (isProcessing) return;
    setItems([]);
    setSelectedItemId(null);
  };

  // Clear All Metadata (Lossless Batch Execution)
  const handleClearAllMetadata = async () => {
    if (items.length === 0 || isProcessing) return;

    setIsProcessing(true);
    setProgress(0);

    const total = items.length;
    const updated = [...items];

    for (let i = 0; i < total; i++) {
      const item = updated[i];
      if (item.status === 'Cleaned') {
        setProgress(Math.round(((i + 1) / total) * 100));
        continue;
      }

      item.status = 'Processing';
      setItems([...updated]);

      // Small async tick for responsive UI
      await new Promise((r) => setTimeout(r, 40));

      const result: StrippingResult = await processLosslessStripping(item.file);
      if (result.success) {
        item.status = 'Cleaned';
        item.cleanedBlob = result.cleanedBlob;
        item.cleanedSize = result.cleanedSize;
        item.bytesSaved = result.bytesSaved;
        item.metadata = result.metadataFound;
      } else {
        item.status = 'Error';
        item.error = result.error;
      }

      setProgress(Math.round(((i + 1) / total) * 100));
      setItems([...updated]);
    }

    setIsProcessing(false);
  };

  // Download single cleaned file
  const handleDownloadSingle = (item: FileItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.cleanedBlob) return;
    const url = URL.createObjectURL(item.cleanedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cleared_${item.name}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Download all cleaned as ZIP
  const handleDownloadAllZip = () => {
    const cleanedItems = items.filter((i) => i.cleanedBlob);
    if (cleanedItems.length === 0) return;

    const zip = new SimpleZip();
    for (const item of cleanedItems) {
      if (item.cleanedBlob) {
        // Blob to Uint8Array in async helper
        item.cleanedBlob.arrayBuffer().then((buffer) => {
          zip.addFile(item.name, new Uint8Array(buffer));
        });
      }
    }

    // Wait short tick then generate
    setTimeout(async () => {
      const zipSync = new SimpleZip();
      for (const item of cleanedItems) {
        if (item.cleanedBlob) {
          const buf = await item.cleanedBlob.arrayBuffer();
          zipSync.addFile(`cleared_${item.name}`, new Uint8Array(buf));
        }
      }
      const blob = zipSync.generateBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ClearMD_Cleaned_Images.zip';
      a.click();
      URL.revokeObjectURL(url);
    }, 100);
  };

  // Statistics
  const totalCount = items.length;
  const cleanedCount = items.filter((i) => i.status === 'Cleaned').length;
  const totalOriginalBytes = items.reduce((acc, i) => acc + i.size, 0);
  const totalSavedBytes = items.reduce((acc, i) => acc + (i.bytesSaved || 0), 0);

  return (
    <div className="w-full max-w-4xl mx-auto select-none">
      {/* Hidden file inputs with multi-select */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        onChange={handleFileChange}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is standard for folder picker in modern browsers
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleFolderChange}
        className="hidden"
      />

      {/* Main Native Window Frame */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="bg-white border-2 border-slate-900 rounded-lg shadow-2xl overflow-hidden flex flex-col relative transition-all"
        style={{ minHeight: '560px' }}
      >
        {/* Drag Overlay Indicator */}
        {isDragging && (
          <div className="absolute inset-0 z-30 bg-blue-600/90 backdrop-blur-xs flex flex-col items-center justify-center text-white border-4 border-dashed border-white m-2 rounded-md pointer-events-none animate-in fade-in duration-100">
            <UploadCloud className="w-16 h-16 animate-bounce mb-3" />
            <h3 className="text-xl font-bold">Drop Images or Folders Here</h3>
            <p className="text-sm opacity-90 mt-1">Multi-file drag and drop enabled</p>
          </div>
        )}

        {/* Windows Classic / Modern Title Bar */}
        <div className="bg-slate-100 border-b border-slate-300 px-3 py-1.5 flex items-center justify-between text-slate-800 select-none">
          <div className="flex items-center gap-2">
            {/* Window Icon */}
            <div className="w-4 h-4 rounded-xs bg-slate-900 flex items-center justify-center text-[10px] font-bold text-white leading-none">
              C
            </div>
            <span className="font-semibold text-xs tracking-wide">ClearMD v1.0</span>
            <span className="text-[10px] text-slate-500 font-mono ml-2 border border-slate-300 px-1 rounded-xs">
              v1.0.0.6 &bull; Lossless Mode
            </span>
          </div>

          {/* Window control glyphs (Min, Max, Close) */}
          <div className="flex items-center">
            <button className="w-8 h-6 flex items-center justify-center text-slate-600 hover:bg-slate-200 transition-colors">
              <Minus className="w-3 h-3" />
            </button>
            <button className="w-8 h-6 flex items-center justify-center text-slate-600 hover:bg-slate-200 transition-colors">
              <Square className="w-2.5 h-2.5" />
            </button>
            <button className="w-8 h-6 flex items-center justify-center text-slate-600 hover:bg-red-500 hover:text-white transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Top Control Bar matching user sketch: [add folder] [add file] [clear list] */}
        <div className="p-3 bg-slate-50 border-b border-slate-300 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {/* [add folder] */}
            <button
              onClick={() => folderInputRef.current?.click()}
              disabled={isProcessing}
              className="px-4 py-1.5 bg-white hover:bg-slate-100 active:bg-slate-200 border-2 border-slate-900 rounded-full font-medium text-xs text-slate-900 shadow-xs flex items-center gap-1.5 transition-transform active:scale-95 cursor-pointer disabled:opacity-50"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              add folder
            </button>

            {/* [add file] */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessing}
              className="px-4 py-1.5 bg-white hover:bg-slate-100 active:bg-slate-200 border-2 border-slate-900 rounded-full font-medium text-xs text-slate-900 shadow-xs flex items-center gap-1.5 transition-transform active:scale-95 cursor-pointer disabled:opacity-50"
            >
              <FilePlus className="w-3.5 h-3.5" />
              add file
            </button>

            {/* [clear list] */}
            <button
              onClick={handleClearList}
              disabled={isProcessing || items.length === 0}
              className="px-4 py-1.5 bg-white hover:bg-red-50 active:bg-red-100 border-2 border-slate-900 rounded-full font-medium text-xs text-slate-900 shadow-xs flex items-center gap-1.5 transition-transform active:scale-95 cursor-pointer disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5 text-red-600" />
              clear list
            </button>
          </div>

          {/* Quick Test Helper */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleLoadSamples}
              disabled={isProcessing}
              title="Loads sample images with GPS and EXIF tags for instant testing"
              className="px-3 py-1 bg-blue-50 hover:bg-blue-100 border border-blue-400 rounded-full text-[11px] text-blue-700 font-medium flex items-center gap-1 transition-colors cursor-pointer"
            >
              <Sparkles className="w-3 h-3 text-blue-600" />
              + Load Sample Images
            </button>
            {cleanedCount > 0 && (
              <button
                onClick={handleDownloadAllZip}
                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full text-[11px] font-medium flex items-center gap-1 transition-colors shadow-xs cursor-pointer"
              >
                <Download className="w-3 h-3" />
                Download All ({cleanedCount})
              </button>
            )}
          </div>
        </div>

        {/* Main List Table matching user's sketch columns:
            [filename] | [type] | [file size] | [location]
        */}
        <div className="flex-1 overflow-auto bg-white min-h-[340px]">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-slate-100 border-b-2 border-slate-900 text-slate-800 sticky top-0 z-10 font-semibold select-none">
              <tr>
                <th className="py-2 px-3 border-r-2 border-slate-900 w-[30%]">filename</th>
                <th className="py-2 px-3 border-r-2 border-slate-900 w-[15%]">type</th>
                <th className="py-2 px-3 border-r-2 border-slate-900 w-[15%]">file size</th>
                <th className="py-2 px-3 border-r-2 border-slate-900 w-[25%]">location</th>
                <th className="py-2 px-3 w-[15%] text-right">status / action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-16 text-center text-slate-400">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <div className="w-12 h-12 rounded-full bg-slate-100 border border-slate-300 flex items-center justify-center text-slate-400">
                        <FileImage className="w-6 h-6" />
                      </div>
                      <p className="font-medium text-slate-600 text-sm">No files in queue</p>
                      <p className="text-xs text-slate-400 max-w-sm">
                        Use <span className="font-semibold text-slate-600">add file</span>,{' '}
                        <span className="font-semibold text-slate-600">add folder</span>, or drag and drop image files directly onto this window.
                      </p>
                      <button
                        onClick={handleLoadSamples}
                        className="mt-2 text-xs text-blue-600 hover:underline font-medium cursor-pointer"
                      >
                        Try with sample images &rarr;
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const isSelected = selectedItemId === item.id;
                  return (
                    <tr
                      key={item.id}
                      onClick={() => setSelectedItemId(item.id)}
                      onDoubleClick={() => setInspectorItem(item)}
                      className={`hover:bg-blue-50/70 transition-colors cursor-pointer group ${
                        isSelected ? 'bg-blue-100/70 font-medium' : ''
                      }`}
                    >
                      {/* Filename */}
                      <td className="py-2.5 px-3 border-r-2 border-slate-900 font-mono text-slate-900 truncate max-w-[200px]">
                        <div className="flex items-center gap-1.5">
                          <FileImage className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          <span className="truncate" title={item.name}>
                            {item.name}
                          </span>
                        </div>
                      </td>

                      {/* Type */}
                      <td className="py-2.5 px-3 border-r-2 border-slate-900 text-slate-700">
                        {item.type}
                      </td>

                      {/* File Size */}
                      <td className="py-2.5 px-3 border-r-2 border-slate-900 font-mono text-slate-700">
                        <div>
                          {formatBytes(item.size)}
                          {item.bytesSaved && item.bytesSaved > 0 ? (
                            <span className="block text-[10px] text-emerald-600 font-semibold">
                              -{formatBytes(item.bytesSaved)}
                            </span>
                          ) : null}
                        </div>
                      </td>

                      {/* Location */}
                      <td className="py-2.5 px-3 border-r-2 border-slate-900 text-slate-500 font-mono text-[11px] truncate max-w-[160px]" title={item.location}>
                        {item.location}
                      </td>

                      {/* Status / Action */}
                      <td className="py-2.5 px-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {item.status === 'Ready' && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-700 border border-slate-300">
                              Ready
                            </span>
                          )}

                          {item.status === 'Processing' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-700 animate-pulse">
                              Stripping...
                            </span>
                          )}

                          {item.status === 'Cleaned' && (
                            <div className="flex items-center gap-1">
                              <span
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setInspectorItem(item);
                                }}
                                title="Inspect stripped metadata"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200 transition-colors cursor-pointer"
                              >
                                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                Cleaned
                              </span>
                              <button
                                onClick={(e) => handleDownloadSingle(item, e)}
                                title="Download lossless cleaned file"
                                className="p-1 rounded text-slate-500 hover:text-blue-600 hover:bg-white transition-colors cursor-pointer"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}

                          {item.status === 'Error' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700">
                              <AlertCircle className="w-3 h-3 text-red-600" />
                              Error
                            </span>
                          )}

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setInspectorItem(item);
                            }}
                            title="Inspect file headers"
                            className="p-1 rounded text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Progress Bar (Visible during batch processing) */}
        {isProcessing && (
          <div className="w-full bg-slate-200 h-1.5 overflow-hidden">
            <div
              className="bg-blue-600 h-full transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* Bottom Big Action Button matching user's sketch: [clear all metadata] */}
        <div className="p-3 bg-white border-t-2 border-slate-900">
          <button
            onClick={handleClearAllMetadata}
            disabled={isProcessing || items.length === 0}
            className="w-full py-2.5 bg-white hover:bg-slate-100 active:bg-slate-200 border-2 border-slate-900 rounded-sm font-semibold text-sm text-slate-900 shadow-sm transition-all transform active:translate-y-0.5 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isProcessing ? (
              <>
                <div className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin" />
                <span>clearing metadata ({progress}%)...</span>
              </>
            ) : (
              <>
                <span>clear all metadata</span>
              </>
            )}
          </button>
        </div>

        {/* Status Bar / Bottom summary */}
        <div className="px-3 py-1.5 bg-slate-100 border-t border-slate-300 text-[11px] text-slate-600 flex items-center justify-between select-none font-mono">
          <div className="flex items-center gap-4">
            <span>Files: {totalCount}</span>
            <span>Cleaned: {cleanedCount}</span>
            <span>Total: {formatBytes(totalOriginalBytes)}</span>
            {totalSavedBytes > 0 && (
              <span className="text-emerald-700 font-semibold">
                Saved: {formatBytes(totalSavedBytes)}
              </span>
            )}
          </div>
          <div>
            <span className="text-slate-400">Lossless DCT stream copy &bull; Zero recompression</span>
          </div>
        </div>
      </div>

      {/* Metadata Inspector Modal */}
      {inspectorItem && (
        <MetadataInspector
          filename={inspectorItem.name}
          fileSize={inspectorItem.size}
          cleanedSize={inspectorItem.cleanedSize}
          metadata={inspectorItem.metadata}
          isCleaned={inspectorItem.status === 'Cleaned'}
          onClose={() => setInspectorItem(null)}
        />
      )}
    </div>
  );
};
