import { create } from 'zustand';
import { bridge, FileNode, RecentProject } from '../lib/tauri-bridge';

export type FileChangeKind = 'created' | 'modified' | 'removed';
export type PreviewMode = 'preview' | 'source' | 'edit' | 'review';
export type LiveReviewSource = 'watcher' | 'tool';

export interface LiveReviewEntry {
  filePath: string;
  kind: FileChangeKind;
  previousContent: string | null;
  currentContent: string | null;
  added: number;
  removed: number;
  updatedAt: number;
  source: LiveReviewSource;
}

const OFFICE_REVIEW_EXTS = new Set(['docx', 'xlsx', 'pptx']);
const DATA_URL_PREVIEW_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
  'pdf', 'mp4', 'webm', 'mov', 'avi',
  'mp3', 'wav', 'ogg', 'aac', 'm4a',
]);
const BINARY_PLACEHOLDER_EXTS = new Set([
  'doc', 'xls', 'ppt', 'zip', 'tar', 'gz', 'rar', '7z', 'exe', 'dmg', 'pkg',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'db', 'sqlite',
]);
const XLSX_PREVIEW_PREFIX = '__TOKENICODE_XLSX_PREVIEW__';

function isArchivePreviewPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.zip')
    || lower.endsWith('.tar')
    || lower.endsWith('.rar')
    || lower.endsWith('.7z')
    || lower.endsWith('.gz')
    || lower.endsWith('.tgz')
    || lower.endsWith('.tar.gz');
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error ?? '').trim();
  return text || fallback;
}

function getPreferredPreviewMode(path: string): PreviewMode {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return OFFICE_REVIEW_EXTS.has(ext) ? 'review' : 'preview';
}

function splitLines(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/\r?\n/);
}

function computeDiffStats(oldString?: string | null, newString?: string | null) {
  const oldLines = splitLines(oldString);
  const newLines = splitLines(newString);
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen
    && suffixLen < newLines.length - prefixLen
    && oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  return {
    added: Math.max(0, newLines.length - prefixLen - suffixLen),
    removed: Math.max(0, oldLines.length - prefixLen - suffixLen),
  };
}

function isLiveReviewSupported(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return !DATA_URL_PREVIEW_EXTS.has(ext) && !BINARY_PLACEHOLDER_EXTS.has(ext) && !isArchivePreviewPath(path);
}

function parseXlsxPreviewContent(content: string) {
  if (!content.startsWith(XLSX_PREVIEW_PREFIX)) return null;
  try {
    const parsed = JSON.parse(content.slice(XLSX_PREVIEW_PREFIX.length)) as {
      kind?: string;
      sheets?: Array<{
        name: string;
        rows: Array<Array<{ text: string; images: string[] }>>;
      }>;
    };
    if (parsed.kind !== 'xlsx' || !Array.isArray(parsed.sheets)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeReviewContent(path: string, content: string | null | undefined): string | null {
  if (content == null) return null;
  if (!isLiveReviewSupported(path)) return null;

  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (ext !== 'xlsx') return content;

  const parsed = parseXlsxPreviewContent(content);
  if (!parsed) return content;

  const sheets = parsed.sheets ?? [];

  return sheets.flatMap((sheet) => {
    const lines = [`# ${sheet.name}`];
    for (const row of sheet.rows) {
      const values = row.map((cell) => {
        const text = cell.text.trim();
        const imageTag = cell.images.length ? ` [images:${cell.images.length}]` : '';
        return `${text}${imageTag}`.trim();
      });
      lines.push(values.join(' | '));
    }
    return lines;
  }).join('\n');
}

function upsertMapEntry<T>(map: Map<string, T>, key: string, value: T): Map<string, T> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

// Batch buffer for markFileChanged — collect changes within a single frame, flush once via rAF
const _pendingChanges = new Map<string, FileChangeKind>();
let _changeFlushRaf = 0;
const _liveReviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _liveReviewVersions = new Map<string, number>();

interface FileState {
  tree: FileNode[];
  isLoading: boolean;
  selectedFile: string | null;
  fileContent: string | null;
  isLoadingContent: boolean;
  previewMode: PreviewMode;
  rootPath: string;

  // Editing state
  editContent: string | null;     // buffer for edits (null = not dirty)
  isSaving: boolean;

  // Unsaved changes navigation guard
  pendingNavigation: string | null;
  showUnsavedDialog: boolean;

  // Project management
  recentProjects: RecentProject[];
  isLoadingProjects: boolean;

  // File change tracking
  changedFiles: Map<string, FileChangeKind>;
  liveReviewEntries: Map<string, LiveReviewEntry>;
  knownFileContents: Map<string, string>;
  lastChangeAt?: number;

  // Directory missing detection
  directoryMissing: boolean;

  // External drag-drop state
  isDragOverTree: boolean;

  loadTree: (path: string) => Promise<void>;
  /** Refresh the tree without clearing change markers. Optional path overrides rootPath. */
  refreshTree: (overridePath?: string) => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  clearSelection: () => void;
  closePreview: () => void;
  setPreviewMode: (mode: PreviewMode) => void;
  setEditContent: (content: string) => void;
  saveFile: () => Promise<void>;
  discardEdits: () => void;
  setRootPath: (path: string) => void;
  fetchRecentProjects: () => Promise<void>;
  /** Reload the currently previewed file content without toggling selection */
  reloadContent: () => Promise<void>;
  markFileChanged: (path: string, kind: FileChangeKind) => void;
  seedLiveReviewEntry: (entry: {
    filePath: string;
    kind: FileChangeKind;
    previousContent?: string | null;
    currentContent?: string | null;
    source?: LiveReviewSource;
  }) => void;
  syncLiveReviewEntry: (path: string, kind: FileChangeKind) => Promise<void>;
  clearChangedFiles: () => void;
  // Unsaved changes actions
  confirmDiscard: () => void;
  confirmSaveAndSwitch: () => Promise<void>;
  cancelNavigation: () => void;
  // New file/folder actions
  createFile: (parentDir: string, name: string) => Promise<void>;
  createFolder: (parentDir: string, name: string) => Promise<void>;
  // External drag state
  setDragOverTree: (v: boolean) => void;
}

export const useFileStore = create<FileState>()((set, get) => ({
  tree: [],
  isLoading: false,
  selectedFile: null,
  fileContent: null,
  isLoadingContent: false,
  previewMode: 'preview' as PreviewMode,
  rootPath: '',
  editContent: null,
  isSaving: false,
  pendingNavigation: null,
  showUnsavedDialog: false,
  recentProjects: [],
  isLoadingProjects: false,
  changedFiles: new Map(),
  liveReviewEntries: new Map(),
  knownFileContents: new Map(),
  lastChangeAt: undefined,
  directoryMissing: false,
  isDragOverTree: false,

  loadTree: async (path: string) => {
    if (!path) return;
    const prevRoot = get().rootPath;
    const isNewDir = path !== prevRoot;
    // Always show loading on first load or directory change
    set({
      rootPath: path,
      isLoading: true,
      // Clear stale tree immediately when switching directories
      ...(isNewDir ? { tree: [] } : {}),
    });
    try {
      const tree = await bridge.readFileTree(path, 8);
      // Guard: only apply if rootPath hasn't changed during async load
      if (get().rootPath === path) {
        set({
          tree,
          isLoading: false,
          changedFiles: new Map(),
          liveReviewEntries: new Map(),
          knownFileContents: new Map(),
          directoryMissing: false,
        });
      }
    } catch (err) {
      if (get().rootPath === path) {
        const missing = String(err).includes('does not exist');
        set({ isLoading: false, directoryMissing: missing });
      }
    }
  },

  refreshTree: async (overridePath?: string) => {
    const dir = overridePath || get().rootPath;
    if (!dir) return;
    try {
      const tree = await bridge.readFileTree(dir, 8);
      // Sync rootPath if override was used and differs
      if (overridePath && overridePath !== get().rootPath) {
        set({ tree, rootPath: overridePath });
      } else {
        set({ tree });
      }
    } catch (err) {
      if (String(err).includes('does not exist')) {
        set({ directoryMissing: true, tree: [] });
      }
    }
  },

  selectFile: async (path: string) => {
    const { selectedFile, editContent, fileContent } = get();
    const isDirty = editContent !== null && editContent !== fileContent;

    // If dirty and trying to navigate to a different file, show dialog
    if (isDirty && path !== selectedFile) {
      set({ pendingNavigation: path, showUnsavedDialog: true });
      return;
    }

    // Toggle selection: click again to deselect
    if (selectedFile === path) {
      set({ selectedFile: null, fileContent: null, isLoadingContent: false, editContent: null });
    } else {
      set({
        selectedFile: path,
        fileContent: null,
        isLoadingContent: true,
        previewMode: getPreferredPreviewMode(path),
        editContent: null,
      });

      // Binary-preview files: skip text reading, render with file:// URL in FilePreview
      const ext = path.split('.').pop()?.toLowerCase() || '';

      if (DATA_URL_PREVIEW_EXTS.has(ext)) {
        // Load binary files as base64 data URL for rendering in webview
        try {
          const dataUrl = await bridge.readFileBase64(path);
          if (get().selectedFile === path) {
            set({ fileContent: dataUrl, isLoadingContent: false });
          }
        } catch {
          if (get().selectedFile === path) {
            set({ fileContent: null, isLoadingContent: false });
          }
        }
      } else if (isArchivePreviewPath(path)) {
        try {
          const content = await bridge.readFileContent(path);
          if (get().selectedFile === path) {
            set({ fileContent: content, isLoadingContent: false });
          }
        } catch (error) {
          if (get().selectedFile === path) {
            set({ fileContent: `// ${toErrorMessage(error, 'Error loading archive preview')}`, isLoadingContent: false });
          }
        }
      } else if (BINARY_PLACEHOLDER_EXTS.has(ext)) {
        if (get().selectedFile === path) {
          set({ fileContent: '', isLoadingContent: false });
        }
      } else {
        try {
          const content = await bridge.readFileContent(path);
          const normalized = normalizeReviewContent(path, content);
          // Only update if selectedFile hasn't changed during the async call
          if (get().selectedFile === path) {
            set((state) => ({
              fileContent: content,
              isLoadingContent: false,
              knownFileContents: normalized == null
                ? state.knownFileContents
                : upsertMapEntry(state.knownFileContents, path, normalized),
            }));
          }
        } catch (error) {
          if (get().selectedFile === path) {
            set({ fileContent: `// ${toErrorMessage(error, 'Error loading file')}`, isLoadingContent: false });
          }
        }
      }
    }
  },

  clearSelection: () => set({ selectedFile: null, fileContent: null, isLoadingContent: false, editContent: null }),

  closePreview: () => set({ selectedFile: null, fileContent: null, isLoadingContent: false, editContent: null }),

  setPreviewMode: (mode: PreviewMode) => {
    const state = get();
    if (mode === 'edit') {
      // Entering edit mode: initialize editContent from fileContent
      set({ previewMode: mode, editContent: state.fileContent });
    } else {
      set({ previewMode: mode });
    }
  },

  setEditContent: (content: string) => set({ editContent: content }),

  saveFile: async () => {
    const { selectedFile, editContent } = get();
    if (!selectedFile || editContent === null) return;
    set({ isSaving: true });
    try {
      await bridge.writeFileContent(selectedFile, editContent);
      const normalized = normalizeReviewContent(selectedFile, editContent);
      // Update fileContent to match saved content
      set((state) => ({
        fileContent: editContent,
        editContent: null,
        isSaving: false,
        previewMode: 'preview',
        knownFileContents: normalized == null
          ? state.knownFileContents
          : upsertMapEntry(state.knownFileContents, selectedFile, normalized),
      }));
    } catch (error) {
      set({ isSaving: false });
    }
  },

  discardEdits: () => {
    set({ editContent: null, previewMode: 'preview' });
  },

  setRootPath: (path: string) => set({ rootPath: path }),

  fetchRecentProjects: async () => {
    set({ isLoadingProjects: true });
    try {
      const projects = await bridge.listRecentProjects();
      set({ recentProjects: projects, isLoadingProjects: false });
    } catch {
      set({ isLoadingProjects: false });
    }
  },

  reloadContent: async () => {
    const path = get().selectedFile;
    if (!path) return;
    // Don't reload while user is editing
    if (get().editContent !== null) return;
    try {
      const ext = path.split('.').pop()?.toLowerCase() || '';
      if (DATA_URL_PREVIEW_EXTS.has(ext)) {
        const dataUrl = await bridge.readFileBase64(path);
        if (get().selectedFile === path) set({ fileContent: dataUrl });
      } else if (isArchivePreviewPath(path)) {
        const content = await bridge.readFileContent(path);
        if (get().selectedFile === path) {
          set({ fileContent: content });
        }
      } else if (BINARY_PLACEHOLDER_EXTS.has(ext)) {
        if (get().selectedFile === path) set({ fileContent: '' });
      } else {
        const content = await bridge.readFileContent(path);
        const normalized = normalizeReviewContent(path, content);
        if (get().selectedFile === path) {
          set((state) => ({
            fileContent: content,
            knownFileContents: normalized == null
              ? state.knownFileContents
              : upsertMapEntry(state.knownFileContents, path, normalized),
          }));
        }
      }
    } catch {
      // Silently fail — keep existing content
    }
  },

  seedLiveReviewEntry: ({ filePath, kind, previousContent, currentContent, source = 'tool' }) => {
    if (!isLiveReviewSupported(filePath)) return;

    const normalizedBefore = normalizeReviewContent(filePath, previousContent);
    const normalizedAfter = normalizeReviewContent(filePath, currentContent);
    const existing = get().liveReviewEntries.get(filePath);
    const baseline = existing?.previousContent
      ?? normalizedBefore
      ?? get().knownFileContents.get(filePath)
      ?? (kind === 'created' ? null : existing?.currentContent ?? normalizedAfter ?? null);
    const latest = normalizedAfter ?? existing?.currentContent ?? null;
    const diff = computeDiffStats(baseline, latest);

    set((state) => ({
      liveReviewEntries: upsertMapEntry(state.liveReviewEntries, filePath, {
        filePath,
        kind,
        previousContent: baseline,
        currentContent: latest,
        added: diff.added,
        removed: diff.removed,
        updatedAt: Date.now(),
        source,
      }),
      knownFileContents: latest == null
        ? state.knownFileContents
        : upsertMapEntry(state.knownFileContents, filePath, latest),
    }));
  },

  syncLiveReviewEntry: async (path: string, kind: FileChangeKind) => {
    const timer = _liveReviewTimers.get(path);
    if (timer) clearTimeout(timer);

    const version = (_liveReviewVersions.get(path) ?? 0) + 1;
    _liveReviewVersions.set(path, version);

    _liveReviewTimers.set(path, setTimeout(async () => {
      _liveReviewTimers.delete(path);
      if (_liveReviewVersions.get(path) !== version) return;

      const state = get();
      const selectedSnapshot = state.selectedFile === path
        ? normalizeReviewContent(path, state.fileContent)
        : null;
      const existing = state.liveReviewEntries.get(path);
      const known = state.knownFileContents.get(path) ?? selectedSnapshot ?? existing?.currentContent ?? null;

      if (kind === 'removed') {
        const baseline = existing?.previousContent ?? known;
        const diff = computeDiffStats(baseline, null);
        set((nextState) => ({
          liveReviewEntries: upsertMapEntry(nextState.liveReviewEntries, path, {
            filePath: path,
            kind,
            previousContent: baseline,
            currentContent: null,
            added: diff.added,
            removed: diff.removed,
            updatedAt: Date.now(),
            source: 'watcher',
          }),
        }));
        return;
      }

      if (!isLiveReviewSupported(path)) return;

      try {
        const content = await bridge.readFileContent(path);
        if (_liveReviewVersions.get(path) !== version) return;

        const normalized = normalizeReviewContent(path, content);
        if (normalized == null) return;

        const latestState = get();
        const latestExisting = latestState.liveReviewEntries.get(path);
        const latestSelectedSnapshot = latestState.selectedFile === path
          ? normalizeReviewContent(path, latestState.fileContent)
          : null;
        const latestKnown = latestState.knownFileContents.get(path) ?? latestSelectedSnapshot ?? latestExisting?.currentContent ?? null;
        const baseline = latestExisting?.previousContent
          ?? (kind === 'created' ? null : latestKnown ?? normalized);
        const diff = computeDiffStats(baseline, normalized);

        set((nextState) => ({
          liveReviewEntries: upsertMapEntry(nextState.liveReviewEntries, path, {
            filePath: path,
            kind,
            previousContent: baseline,
            currentContent: normalized,
            added: diff.added,
            removed: diff.removed,
            updatedAt: Date.now(),
            source: 'watcher',
          }),
          knownFileContents: upsertMapEntry(nextState.knownFileContents, path, normalized),
        }));
      } catch {
        // Best-effort live review update.
      }
    }, 220));
  },

  markFileChanged: (path: string, kind: FileChangeKind) => {
    _pendingChanges.set(path, kind);
    if (!_changeFlushRaf) {
      _changeFlushRaf = requestAnimationFrame(() => {
        _changeFlushRaf = 0;
        if (_pendingChanges.size === 0) return;
        const next = new Map(get().changedFiles);
        for (const [p, k] of _pendingChanges) {
          next.set(p, k);
          void get().syncLiveReviewEntry(p, k);
        }
        _pendingChanges.clear();
        set({ changedFiles: next, lastChangeAt: Date.now() });
      });
    }
  },

  clearChangedFiles: () => set({ changedFiles: new Map(), liveReviewEntries: new Map() }),

  // --- Unsaved changes dialog actions ---

  confirmDiscard: () => {
    const pending = get().pendingNavigation;
    set({ editContent: null, showUnsavedDialog: false, pendingNavigation: null });
    if (pending) get().selectFile(pending);
  },

  confirmSaveAndSwitch: async () => {
    const pending = get().pendingNavigation;
    await get().saveFile();
    set({ showUnsavedDialog: false, pendingNavigation: null });
    if (pending) get().selectFile(pending);
  },

  cancelNavigation: () => {
    set({ pendingNavigation: null, showUnsavedDialog: false });
  },

  // --- New file/folder actions ---

  createFile: async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await bridge.writeFileContent(path, '');
      await get().refreshTree();
      get().selectFile(path);
    } catch {
      // Silently fail
    }
  },

  createFolder: async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await bridge.createDirectory(path);
      await get().refreshTree();
    } catch {
      // Silently fail
    }
  },

  // --- External drag state ---

  setDragOverTree: (v: boolean) => set({ isDragOverTree: v }),
}));
