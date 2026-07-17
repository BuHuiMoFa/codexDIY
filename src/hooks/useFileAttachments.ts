import { useState, useCallback, useEffect, useRef } from 'react';
import { bridge } from '../lib/tauri-bridge';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTreeDragActive } from '../lib/drag-state';
import { useSettingsStore } from '../stores/settingsStore';
import { useFileStore } from '../stores/fileStore';

// --- Types ---

export interface FileAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  type: string;
  isImage: boolean;
  preview?: string;
}

// --- Helper ---

let fileCounter = 0;
function generateFileId(): string {
  fileCounter += 1;
  return `file_${Date.now()}_${fileCounter}`;
}

function isImageMime(type: string): boolean {
  return type.startsWith('image/');
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', js: 'text/javascript', ts: 'text/typescript',
    html: 'text/html', css: 'text/css', csv: 'text/csv',
    zip: 'application/zip', gz: 'application/gzip',
  };
  return map[ext] || 'application/octet-stream';
}

function isImageExt(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
}

async function generateThumbnail(file: File): Promise<string | undefined> {
  if (!isImageMime(file.type)) return undefined;

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 64;
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        } else {
          resolve(undefined);
        }
      };
      img.onerror = () => resolve(undefined);
      img.src = reader.result as string;
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

async function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

async function partitionDroppedPaths(paths: string[]): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];

  for (const path of paths) {
    try {
      if (await bridge.isDirectoryPath(path)) {
        directories.push(path);
      } else {
        files.push(path);
      }
    } catch {
      files.push(path);
    }
  }

  return { files, directories };
}

// --- Hook ---

export function useFileAttachments() {
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    setIsProcessing(true);
    try {
      const newFiles: FileAttachment[] = [];
      const fileArray = Array.from(fileList);

      for (const file of fileArray) {
        try {
          const preview = await generateThumbnail(file);
          const bytes = await readFileAsBytes(file);
          const cwd = useSettingsStore.getState().workingDirectory;
          const tempPath = await bridge.saveTempFile(
            file.name,
            Array.from(bytes),
            cwd || undefined,
          );

          newFiles.push({
            id: generateFileId(),
            name: file.name,
            path: tempPath,
            size: file.size,
            type: file.type || 'application/octet-stream',
            isImage: isImageMime(file.type),
            preview,
          });
        } catch (err) {
          console.error('Failed to add file:', file.name, err);
        }
      }

      if (newFiles.length > 0) {
        setFiles((prev) => [...prev, ...newFiles]);
      }
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const addFilePaths = useCallback(async (paths: string[]) => {
    setIsProcessing(true);
    try {
      const newFiles: FileAttachment[] = [];
      for (const filePath of paths) {
        try {
          const name = filePath.split(/[\\/]/).pop() || filePath;
          const mime = guessMime(name);
          const isImg = isImageExt(name);

          let fileSize = 0;
          try {
            fileSize = await bridge.getFileSize(filePath);
          } catch {
            fileSize = 0;
          }

          let preview: string | undefined;
          if (isImg) {
            try {
              const b64 = await bridge.readFileBase64(filePath);
              const dataUrl = `data:${mime};base64,${b64}`;
              preview = await new Promise<string | undefined>((resolve) => {
                const img = new Image();
                img.onload = () => {
                  const canvas = document.createElement('canvas');
                  const maxSize = 64;
                  const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
                  canvas.width = img.width * scale;
                  canvas.height = img.height * scale;
                  const ctx = canvas.getContext('2d');
                  if (ctx) {
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', 0.7));
                  } else {
                    resolve(undefined);
                  }
                };
                img.onerror = () => resolve(undefined);
                img.src = dataUrl;
              });
            } catch {
              preview = undefined;
            }
          }

          newFiles.push({
            id: generateFileId(),
            name,
            path: filePath,
            size: fileSize,
            type: mime,
            isImage: isImg,
            preview,
          });
        } catch (err) {
          console.error('Failed to add dropped file:', filePath, err);
        }
      }
      if (newFiles.length > 0) {
        setFiles((prev) => [...prev, ...newFiles]);
      }
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const lastDropRef = useRef<{ time: number; key: string }>({ time: 0, key: '' });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onDragDropEvent((event) => {
      const { type } = event.payload;

      if (type === 'over' || type === 'enter') {
        if (isTreeDragActive()) return;
        const pos = (event.payload as any).position;
        if (pos) {
          const el = document.elementFromPoint(pos.x, pos.y);
          const overTree = !!el?.closest('[data-file-tree]');
          useFileStore.getState().setDragOverTree(overTree);
        }
        return;
      }

      if (type === 'leave') {
        useFileStore.getState().setDragOverTree(false);
        return;
      }

      if (type !== 'drop') return;

      const wasOverTree = useFileStore.getState().isDragOverTree;
      useFileStore.getState().setDragOverTree(false);

      if (isTreeDragActive()) return;
      const paths = (event.payload as any).paths as string[] | undefined;
      if (!paths || paths.length === 0) return;

      const now = Date.now();
      const key = [...paths].sort().join('|');
      if (now - lastDropRef.current.time < 500 && key === lastDropRef.current.key) return;
      lastDropRef.current = { time: now, key };

      void (async () => {
        const { files: droppedFiles } = await partitionDroppedPaths(paths);

        if (wasOverTree) {
          const rootPath = useSettingsStore.getState().workingDirectory
            || useFileStore.getState().rootPath;
          if (rootPath) {
            for (const srcPath of droppedFiles) {
              const name = srcPath.split(/[\\/]/).pop() || srcPath;
              const dest = `${rootPath}/${name}`;
              try {
                await bridge.copyFile(srcPath, dest);
              } catch (err) {
                console.error('Failed to copy file to project:', name, err);
              }
            }
            useFileStore.getState().refreshTree(rootPath);
          }
          return;
        }

        const imagePaths: string[] = [];
        const otherPaths: string[] = [];
        for (const path of droppedFiles) {
          const name = path.split(/[\\/]/).pop() || '';
          if (isImageExt(name)) {
            imagePaths.push(path);
          } else {
            otherPaths.push(path);
          }
        }

        if (imagePaths.length > 0) {
          await addFilePaths(imagePaths);
        }

        for (const path of otherPaths) {
          window.dispatchEvent(new CustomEvent('tokenicode:tree-file-inline', { detail: path }));
        }
      })();
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [addFilePaths]);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearFiles = useCallback(() => {
    setFiles([]);
  }, []);

  return { files, setFiles, isProcessing, addFiles, addFilePaths, removeFile, clearFiles };
}
