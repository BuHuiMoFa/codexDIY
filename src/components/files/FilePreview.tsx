import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { go } from '@codemirror/legacy-modes/mode/go';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { useFileStore } from '../../stores/fileStore';
import { bridge } from '../../lib/tauri-bridge';
import type { SkillTranslationConfig } from '../../lib/tauri-bridge';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { FileIcon } from '../shared/FileIcon';
import { tokenicodeTheme, tokenicodeHighlight } from '../../lib/codemirror-theme';
import { useT } from '../../lib/i18n';
import { canOpenInWebPreview, openWebPreview } from '../../lib/preview-target';

/* ================================================================
   Helpers
   ================================================================ */

function getExt(path: string): string {
  const parts = path.split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Return CodeMirror language extension for the given file extension */
function getLanguageExtension(ext: string) {
  switch (ext) {
    case 'ts': case 'tsx': return javascript({ jsx: true, typescript: true });
    case 'js': case 'jsx': return javascript({ jsx: true });
    case 'py': return python();
    case 'rs': return rust();
    case 'json': return json();
    case 'html': case 'htm': case 'xhtml': return html();
    case 'css': case 'scss': case 'less': return css();
    case 'md': case 'mdx': return markdown();
    case 'java': case 'kt': return java();
    case 'c': case 'cpp': case 'h': case 'hpp': return cpp();
    case 'sql': return sql();
    case 'xml': case 'svg': return xml();
    case 'yaml': case 'yml': return yaml();
    case 'go': return StreamLanguage.define(go);
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell);
    case 'rb': return StreamLanguage.define(ruby);
    case 'swift': return StreamLanguage.define(swift);
    case 'lua': return StreamLanguage.define(lua);
    case 'toml': return StreamLanguage.define(toml);
    case 'dockerfile': return StreamLanguage.define(dockerFile);
    default: return [];
  }
}

/**
 * Inject a <base> tag into HTML content so relative paths (CSS, JS, images)
 * resolve relative to the file's directory on disk.
 */
function injectBaseTag(html: string, filePath: string): string {
  // Get directory of the file (handle both / and \ separators)
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dir = lastSep >= 0 ? filePath.substring(0, lastSep + 1) : '';
  // Escape HTML special chars to prevent attribute injection (P0-7 fix)
  const safeDir = dir.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const baseTag = `<base href="file://${safeDir}">`;

  // Insert into <head> if present, otherwise prepend
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([\s>])/i, `<head$1${baseTag}`);
  }
  return baseTag + html;
}

const MARKDOWN_EXTS = new Set(['md', 'mdx']);
const HTML_EXTS = new Set(['html', 'htm', 'xhtml']);
const SVG_EXT = 'svg';
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'aac', 'm4a']);
const PDF_EXT = 'pdf';
const OFFICE_REVIEW_EXTS = new Set(['docx', 'xlsx', 'pptx']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'rar', '7z']);
const BINARY_EXTS = new Set(['zip', 'tar', 'gz', 'rar', '7z', 'exe', 'dmg', 'pkg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'doc', 'xls', 'ppt', 'db', 'sqlite']);

const TRANSLATION_CONFIG_KEY = 'tokenicode-skill-translation-config-v1';
const MARKDOWN_TRANSLATION_CACHE_KEY = 'tokenicode-skill-markdown-translations-v1';

const DEFAULT_TRANSLATION_CONFIG: SkillTranslationConfig = {
  baseUrl: '',
  apiFormat: 'anthropic',
  apiKey: '',
  model: '',
  proxyUrl: '',
};

type MarkdownTranslationCache = Record<string, string>;
type XlsxPreviewCell = {
  text: string;
  images: string[];
};
type XlsxPreviewSheet = {
  name: string;
  rows: XlsxPreviewCell[][];
  total_rows: number;
  total_columns: number;
  truncated_rows: boolean;
  truncated_columns: boolean;
};
type XlsxPreviewPayload = {
  kind: 'xlsx';
  sheets: XlsxPreviewSheet[];
  total_rows: number;
};

const XLSX_PREVIEW_PREFIX = '__TOKENICODE_XLSX_PREVIEW__';
const ARCHIVE_PREVIEW_PREFIX = '__TOKENICODE_ARCHIVE_PREVIEW__';
const CELL_IMAGE_URL_RE = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?\S*)?$/i;

type ArchivePreviewEntry = {
  path: string;
  kind: string;
  size: number | null;
  compressed_size: number | null;
};

type ArchivePreviewPayload = {
  kind: 'archive';
  format: string;
  entries: ArchivePreviewEntry[];
  total_entries: number;
  truncated: boolean;
  note?: string | null;
};

function loadTranslationConfig(): SkillTranslationConfig {
  try {
    const raw = localStorage.getItem(TRANSLATION_CONFIG_KEY);
    if (!raw) return DEFAULT_TRANSLATION_CONFIG;
    return { ...DEFAULT_TRANSLATION_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_TRANSLATION_CONFIG;
  }
}

function loadMarkdownTranslationCache(): MarkdownTranslationCache {
  try {
    const raw = localStorage.getItem(MARKDOWN_TRANSLATION_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveMarkdownTranslationCache(cache: MarkdownTranslationCache) {
  try {
    localStorage.setItem(MARKDOWN_TRANSLATION_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Cache is best-effort only.
  }
}

function parseXlsxPreviewPayload(content: string | null): XlsxPreviewPayload | null {
  if (!content?.startsWith(XLSX_PREVIEW_PREFIX)) return null;
  try {
    const parsed = JSON.parse(content.slice(XLSX_PREVIEW_PREFIX.length)) as XlsxPreviewPayload;
    if (parsed?.kind !== 'xlsx' || !Array.isArray(parsed.sheets)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseArchivePreviewPayload(content: string | null): ArchivePreviewPayload | null {
  if (!content?.startsWith(ARCHIVE_PREVIEW_PREFIX)) return null;
  try {
    const parsed = JSON.parse(content.slice(ARCHIVE_PREVIEW_PREFIX.length)) as ArchivePreviewPayload;
    if (parsed?.kind !== 'archive' || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function isArchivePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.zip')
    || lower.endsWith('.tar')
    || lower.endsWith('.rar')
    || lower.endsWith('.7z')
    || lower.endsWith('.gz')
    || lower.endsWith('.tgz')
    || lower.endsWith('.tar.gz');
}

function getPreviewCellImages(cell: XlsxPreviewCell): string[] {
  const trimmedText = cell.text.trim();
  const inlineUrls = CELL_IMAGE_URL_RE.test(trimmedText) ? [trimmedText] : [];
  return Array.from(new Set([...cell.images, ...inlineUrls]));
}

/* ================================================================
   FilePreview component
   ================================================================ */
export function FilePreview() {
  const t = useT();
  const selectedFile = useFileStore((s) => s.selectedFile);
  const fileContent = useFileStore((s) => s.fileContent);
  const isLoadingContent = useFileStore((s) => s.isLoadingContent);
  const previewMode = useFileStore((s) => s.previewMode);
  const setPreviewMode = useFileStore((s) => s.setPreviewMode);
  const closePreview = useFileStore((s) => s.closePreview);
  const editContent = useFileStore((s) => s.editContent);
  const setEditContent = useFileStore((s) => s.setEditContent);
  const saveFile = useFileStore((s) => s.saveFile);
  const discardEdits = useFileStore((s) => s.discardEdits);
  const isSaving = useFileStore((s) => s.isSaving);
  const changedFiles = useFileStore((s) => s.changedFiles);
  const reloadContent = useFileStore((s) => s.reloadContent);
  const showUnsavedDialog = useFileStore((s) => s.showUnsavedDialog);
  const confirmDiscard = useFileStore((s) => s.confirmDiscard);
  const confirmSaveAndSwitch = useFileStore((s) => s.confirmSaveAndSwitch);
  const cancelNavigation = useFileStore((s) => s.cancelNavigation);
  const [showTranslatedSkill, setShowTranslatedSkill] = useState(false);
  const [translatedSkillContent, setTranslatedSkillContent] = useState<MarkdownTranslationCache>(() => loadMarkdownTranslationCache());
  const [isTranslatingSkill, setIsTranslatingSkill] = useState(false);
  const [skillTranslationError, setSkillTranslationError] = useState<string | null>(null);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);

  // Auto-refresh preview when the selected file is modified externally
  const reloadRef = useRef(reloadContent);
  reloadRef.current = reloadContent;
  useEffect(() => {
    if (!selectedFile) return;
    const change = changedFiles.get(selectedFile);
    if (change === 'modified') {
      reloadRef.current();
    }
  }, [selectedFile, changedFiles]);

  const ext = useMemo(() => selectedFile ? getExt(selectedFile) : '', [selectedFile]);
  const fileName = useMemo(() => selectedFile ? getFileName(selectedFile) : '', [selectedFile]);
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const isHtml = HTML_EXTS.has(ext);
  const isSvg = ext === SVG_EXT;
  const isImage = IMAGE_EXTS.has(ext);
  const isVideo = VIDEO_EXTS.has(ext);
  const isAudio = AUDIO_EXTS.has(ext);
  const isPdf = ext === PDF_EXT;
  const isArchive = selectedFile ? isArchivePath(selectedFile) : ARCHIVE_EXTS.has(ext);
  const isOfficeReview = OFFICE_REVIEW_EXTS.has(ext);
  const isBinary = BINARY_EXTS.has(ext);
  const hasPreview = isMarkdown || isHtml || isSvg;
  const canSendToWebPreview = !!selectedFile && canOpenInWebPreview(selectedFile);
  const isEditing = previewMode === 'edit';
  const isDirty = editContent !== null && editContent !== fileContent;
  const isSkillMarkdown = isMarkdown && fileName.toLowerCase() === 'skill.md';
  const xlsxPreview = useMemo(() => ext === 'xlsx' ? parseXlsxPreviewPayload(fileContent) : null, [ext, fileContent]);
  const archivePreview = useMemo(() => parseArchivePreviewPayload(fileContent), [fileContent]);
  const displayedMarkdownContent = selectedFile && showTranslatedSkill
    ? (translatedSkillContent[selectedFile] || fileContent)
    : fileContent;

  useEffect(() => {
    if (!isPdf || !fileContent) {
      setPdfPreviewUrl(null);
      return;
    }

    if (!fileContent.startsWith('data:application/pdf')) {
      setPdfPreviewUrl(fileContent);
      return;
    }

    let revokedUrl: string | null = null;
    let alive = true;

    fetch(fileContent)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        if (!alive) return;
        const blob = new Blob([buffer], { type: 'application/pdf' });
        revokedUrl = URL.createObjectURL(blob);
        setPdfPreviewUrl(revokedUrl);
      })
      .catch(() => {
        if (alive) setPdfPreviewUrl(fileContent);
      });

    return () => {
      alive = false;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [isPdf, fileContent]);

  const lineCount = useMemo(() => {
    const content = isEditing ? editContent : fileContent;
    if (!content) return 0;
    return content.split('\n').length;
  }, [fileContent, editContent, isEditing]);
  const displayLineCount = xlsxPreview?.total_rows ?? lineCount;

  const langExtension = useMemo(() => getLanguageExtension(ext), [ext]);
  const stopHeaderMouseDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  /* Cmd+S to save */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (isDirty) saveFile();
    }
  }, [isDirty, saveFile]);

  const handleToggleSkillTranslation = useCallback(async () => {
    if (!selectedFile || fileContent === null) return;
    if (showTranslatedSkill) {
      setShowTranslatedSkill(false);
      setSkillTranslationError(null);
      return;
    }

    setShowTranslatedSkill(true);
    setSkillTranslationError(null);
    if (translatedSkillContent[selectedFile]) return;

    const config = loadTranslationConfig();
    const normalizedConfig: SkillTranslationConfig = {
      ...config,
      baseUrl: config.baseUrl.trim(),
      apiKey: config.apiKey.trim(),
      model: config.model.trim(),
      proxyUrl: config.proxyUrl?.trim() || undefined,
    };
    if (!normalizedConfig.baseUrl || !normalizedConfig.apiKey || !normalizedConfig.model) {
      setSkillTranslationError('请先在技能面板齿轮里配置翻译 API');
      return;
    }

    setIsTranslatingSkill(true);
    try {
      const translated = await bridge.translateSkillMarkdown(fileContent, normalizedConfig);
      const next = { ...translatedSkillContent, [selectedFile]: translated };
      setTranslatedSkillContent(next);
      saveMarkdownTranslationCache(next);
    } catch (e) {
      setSkillTranslationError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsTranslatingSkill(false);
    }
  }, [selectedFile, fileContent, showTranslatedSkill, translatedSkillContent]);

  useEffect(() => {
    setShowTranslatedSkill(false);
    setSkillTranslationError(null);
  }, [selectedFile]);

  /* Mode tabs for the header */
  const modeTabs = useMemo(() => {
    if (isMarkdown) {
      // Markdown — preview + edit only
      return [
        { id: 'preview' as const, label: t('files.preview') },
        { id: 'edit' as const, label: t('files.edit') },
      ];
    }
    if (isOfficeReview) {
      return [
        { id: 'review' as const, label: t('files.review') },
      ];
    }
    if (hasPreview) {
      // HTML, SVG — preview + source + edit
      return [
        { id: 'preview' as const, label: t('files.preview') },
        { id: 'source' as const, label: t('files.source') },
        { id: 'edit' as const, label: t('files.edit') },
      ];
    }
    if (!isBinary && !isImage && !isPdf && !isVideo && !isAudio && !isArchive) {
      return [
        { id: 'source' as const, label: t('files.source') },
        { id: 'edit' as const, label: t('files.edit') },
      ];
    }
    return [];
  }, [hasPreview, isMarkdown, isBinary, isImage, isOfficeReview, isArchive, t]);

  if (!selectedFile) return null;

  return (
    <div className="flex flex-col h-full bg-bg-primary" onKeyDown={handleKeyDown}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2.5
        border-b border-border-subtle bg-bg-secondary/50 flex-shrink-0 relative z-10">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileIcon name={fileName} size={16} className="flex-shrink-0 text-text-muted" />
          <span className="text-[13px] font-medium text-text-primary truncate">
            {fileName}
          </span>
          {displayLineCount > 0 && (
            <span className="text-xs text-text-muted flex-shrink-0">
              {displayLineCount} {t('files.lineCount')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Save / Discard buttons — visible when editing with unsaved changes */}
          {isEditing && isDirty && (
            <div className="flex items-center gap-1 animate-fade-in">
              <button
                onClick={discardEdits}
                className="px-2.5 py-1 rounded-lg text-xs font-medium
                  text-text-muted hover:text-text-primary hover:bg-bg-tertiary
                  transition-smooth"
              >
                {t('files.discard')}
              </button>
              <button
                onClick={saveFile}
                disabled={isSaving}
                className="px-2.5 py-1 rounded-lg text-xs font-medium
                  bg-accent text-text-inverse hover:bg-accent-hover
                  transition-smooth disabled:opacity-50"
              >
                {isSaving ? t('files.saving') : t('files.save')}
              </button>
            </div>
          )}

          {/* Mode toggle tabs */}
          {modeTabs.length > 0 && (
            <div className="flex gap-0.5 bg-bg-tertiary/50 rounded-xl p-1">
              {modeTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setPreviewMode(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium
                    transition-smooth cursor-pointer
                    ${previewMode === tab.id
                      ? 'bg-bg-card text-accent shadow-sm'
                      : 'text-text-muted hover:text-text-primary hover:bg-bg-card/50'
                    }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {isSkillMarkdown && previewMode === 'preview' && (
            <button
              type="button"
              onClick={handleToggleSkillTranslation}
              disabled={isTranslatingSkill}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium
                transition-smooth cursor-pointer disabled:opacity-60
                ${showTranslatedSkill
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary'
                }`}
              title="翻译 SKILL.md 预览"
            >
              {isTranslatingSkill ? '...' : '译'}
            </button>
          )}

          {/* Refresh button */}
          {canSendToWebPreview && (
            <button
              type="button"
              onClick={() => selectedFile && openWebPreview(selectedFile)}
              className="px-2.5 py-1 rounded-lg text-xs font-medium
                text-text-muted hover:text-text-primary hover:bg-bg-tertiary
                transition-smooth cursor-pointer"
              title={t('panel.preview')}
            >
              {t('panel.preview')}
            </button>
          )}

          <button
            type="button"
            onMouseDown={stopHeaderMouseDown}
            onClick={reloadContent}
            className="p-2 rounded-lg hover:bg-bg-tertiary
              text-text-tertiary transition-smooth cursor-pointer"
            title={t('files.refresh')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2.5 8a5.5 5.5 0 019.3-4M13.5 8a5.5 5.5 0 01-9.3 4" />
              <path d="M12 1v3h-3M4 12v3h3" />
            </svg>
          </button>

          {/* Close button — larger hit area for easy clicking */}
          <button
            type="button"
            onMouseDown={stopHeaderMouseDown}
            onClick={closePreview}
            className="p-2 rounded-lg hover:bg-bg-tertiary
              text-text-tertiary transition-smooth cursor-pointer"
            title={t('files.closePreview')}
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none"
              stroke="currentColor" strokeWidth="2">
              <path d="M4 4l6 6M10 4l-6 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {isLoadingContent ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex items-center gap-2 text-text-muted text-xs">
              <svg className="animate-spin-slow" width="14" height="14"
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
              {t('files.loading')}
            </div>
          </div>
        ) : isImage && selectedFile && fileContent ? (
          /* Image preview: use Tauri asset URL so large files do not need base64 encoding */
          <div className="flex items-center justify-center h-full p-4 overflow-auto">
            <img
              src={fileContent}
              alt={fileName}
              className="max-w-full max-h-full object-contain rounded"
              draggable={false}
            />
          </div>
        ) : isPdf && selectedFile && fileContent ? (
          /* PDF preview: blob/object is more reliable than iframe in Tauri WebView */
          <div className="flex flex-col h-full">
            {pdfPreviewUrl ? (
              <object
                data={pdfPreviewUrl}
                type="application/pdf"
                className="flex-1 w-full bg-white"
                aria-label={fileName}
              >
                <embed
                  src={pdfPreviewUrl}
                  type="application/pdf"
                  className="h-full w-full bg-white"
                />
              </object>
            ) : (
              <div className="flex flex-1 items-center justify-center bg-white text-xs text-text-muted">
                {t('files.loading')}
              </div>
            )}
            <div className="flex items-center justify-center py-2 border-t border-border-subtle">
              <button
                onClick={() => bridge.openWithDefaultApp(selectedFile)}
                className="px-3 py-1 rounded-lg text-[11px] font-medium
                  text-text-muted hover:text-text-primary hover:bg-bg-tertiary
                  transition-smooth"
              >
                {t('files.openExternal')}
              </button>
            </div>
          </div>
        ) : isVideo && selectedFile && fileContent ? (
          /* Video preview: native <video> with local asset URL */
          <div className="flex items-center justify-center h-full p-4">
            <video
              src={fileContent}
              controls
              className="max-w-full max-h-full rounded"
            />
          </div>
        ) : isAudio && selectedFile && fileContent ? (
          /* Audio preview: icon + native <audio> with local asset URL */
          <div className="flex flex-col items-center justify-center h-full gap-4 p-4">
            <FileIcon name={fileName} size={48} className="text-text-tertiary" />
            <audio
              src={fileContent}
              controls
              className="w-full max-w-md"
            />
          </div>
        ) : isArchive ? (
          <div className="flex flex-col h-full overflow-hidden">
            <div className="px-4 py-3 border-b border-border-subtle bg-bg-secondary/35">
              <div className="text-[11px] text-text-muted">
                内置压缩包预览会显示压缩包内的文件列表、目录结构和大小信息。
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <div className="max-w-5xl mx-auto rounded-2xl border border-border-subtle bg-bg-card/70 shadow-sm">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">
                      {fileName}
                    </div>
                    <div className="text-[11px] text-text-muted mt-1">
                      {(archivePreview?.format || ext || 'archive').toUpperCase()} · {archivePreview?.total_entries ?? 0} 项
                    </div>
                  </div>
                  {selectedFile && (
                    <button
                      onClick={() => bridge.openWithDefaultApp(selectedFile)}
                      className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary
                        text-text-muted hover:bg-bg-tertiary hover:text-text-primary
                        transition-smooth cursor-pointer"
                    >
                      {t('files.openDefault')}
                    </button>
                  )}
                </div>
                <div className="px-4 py-4">
                  {archivePreview ? (
                    <div className="space-y-4">
                      {archivePreview.note && (
                        <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-3 py-2 text-xs text-text-muted">
                          {archivePreview.note}
                        </div>
                      )}
                      <div className="overflow-hidden rounded-2xl border border-border-subtle/80 bg-bg-primary/55">
                        <div className="grid grid-cols-[minmax(0,1fr)_96px_120px_120px] gap-3 border-b border-border-subtle bg-bg-secondary/35 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                          <div>路径</div>
                          <div>类型</div>
                          <div>大小</div>
                          <div>压缩后</div>
                        </div>
                        <div className="max-h-[560px] overflow-auto">
                          {archivePreview.entries.map((entry, index) => (
                            <div
                              key={`${entry.path}-${index}`}
                              className="grid grid-cols-[minmax(0,1fr)_96px_120px_120px] gap-3 border-b border-border-subtle/60 px-4 py-3 text-[12px] text-text-primary last:border-b-0"
                            >
                              <div className="min-w-0 break-all font-mono">{entry.path}</div>
                              <div className="text-text-muted">{entry.kind === 'dir' ? '文件夹' : '文件'}</div>
                              <div className="text-text-muted">{formatBytes(entry.size)}</div>
                              <div className="text-text-muted">{formatBytes(entry.compressed_size)}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      {archivePreview.truncated && (
                        <div className="text-[11px] text-text-tertiary">
                          仅显示前 {archivePreview.entries.length} 项，剩余内容已折叠以保持预览流畅。
                        </div>
                      )}
                    </div>
                  ) : fileContent?.startsWith('//') ? (
                    <div className="rounded-2xl border border-error/20 bg-error/5 px-4 py-4 text-sm text-error">
                      {fileContent.replace(/^\/\/\s*/, '')}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-border-subtle bg-bg-secondary/40 px-4 py-4 text-sm text-text-muted">
                      暂时无法解析这个压缩包的内部结构。
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : isBinary ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-xl rounded-2xl border border-border-subtle bg-bg-card/70 p-6 text-center shadow-sm">
              <div className="flex flex-col items-center gap-3">
                <FileIcon name={fileName} size={40} className="text-text-tertiary" />
                <div className="text-sm font-medium text-text-primary">{fileName}</div>
                <div className="text-xs text-text-muted">
                  该文件已进入内置预览面板，当前格式暂不支持完整渲染。
                </div>
                {selectedFile && (
                  <div className="w-full rounded-xl border border-border-subtle bg-bg-secondary/55 px-4 py-3 text-left">
                    <div className="text-[11px] uppercase tracking-[0.14em] text-text-tertiary">File</div>
                    <div className="mt-1 break-all text-xs text-text-primary">{selectedFile}</div>
                    <div className="mt-2 text-[11px] text-text-muted">
                      {ext ? ext.toUpperCase() : 'FILE'} · 可在软件内查看信息，并可用默认应用继续打开
                    </div>
                  </div>
                )}
                {selectedFile && (
                  <button
                    onClick={() => bridge.openWithDefaultApp(selectedFile)}
                    className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary
                      text-text-muted hover:bg-bg-tertiary hover:text-text-primary
                      transition-smooth cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M10 6.5v3a1 1 0 01-1 1H2.5a1 1 0 01-1-1V3a1 1 0 011-1H6" />
                      <path d="M7.5 1.5h3v3M7 5.5l3.5-4" />
                    </svg>
                    {t('files.openDefault')}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : isEditing ? (
          /* Edit mode: CodeMirror 6 editor */
          <CodeMirror
            value={editContent ?? fileContent ?? ''}
            extensions={[...(Array.isArray(langExtension) ? langExtension : [langExtension]), EditorView.lineWrapping, tokenicodeHighlight]}
            theme={tokenicodeTheme}
            onChange={(value) => setEditContent(value)}
            height="100%"
            style={{ height: '100%', fontSize: '13px' }}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              highlightActiveLine: true,
              foldGutter: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              indentOnInput: true,
              searchKeymap: true,
              tabSize: 2,
            }}
          />
        ) : previewMode === 'review' && isOfficeReview && fileContent !== null && selectedFile ? (
          <div className="flex flex-col h-full overflow-hidden">
            <div className="px-4 py-3 border-b border-border-subtle bg-bg-secondary/35">
              <div className="text-[11px] text-text-muted">
                {t('files.reviewHint')}
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <div className="max-w-4xl mx-auto rounded-2xl border border-border-subtle bg-bg-card/70 shadow-sm">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">
                      {fileName}
                    </div>
                    <div className="text-[11px] text-text-muted mt-1">
                      {ext.toUpperCase()} · {displayLineCount} {t('files.lineCount')}
                    </div>
                  </div>
                  <button
                    onClick={() => bridge.openWithDefaultApp(selectedFile)}
                    className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary
                      text-text-muted hover:bg-bg-tertiary hover:text-text-primary
                      transition-smooth cursor-pointer"
                  >
                    {t('files.openDefault')}
                  </button>
                </div>
                <div className="px-4 py-4">
                  {xlsxPreview ? (
                    <div className="space-y-5">
                      {xlsxPreview.sheets.map((sheet) => (
                        <section key={sheet.name} className="overflow-hidden rounded-2xl border border-border-subtle/80 bg-bg-primary/55">
                          <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-bg-secondary/35 px-4 py-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-text-primary">{sheet.name}</div>
                              <div className="mt-1 text-[11px] text-text-muted">
                                {sheet.total_rows} 行 · {sheet.total_columns} 列
                              </div>
                            </div>
                            {(sheet.truncated_rows || sheet.truncated_columns) && (
                              <div className="text-right text-[11px] text-text-tertiary">
                                {sheet.truncated_rows ? '已省略部分行' : '已省略部分列'}
                              </div>
                            )}
                          </div>
                          {sheet.rows.length > 0 ? (
                            <div className="overflow-auto">
                              <table className="min-w-full border-collapse text-[13px] leading-6 text-text-primary">
                                <tbody>
                                  {sheet.rows.map((row, rowIndex) => (
                                    <tr key={`${sheet.name}-${rowIndex}`} className="align-top">
                                      {row.map((cell, cellIndex) => {
                                        const imageSources = getPreviewCellImages(cell);
                                        const trimmedText = cell.text.trim();
                                        const cellContent = !trimmedText && imageSources.length === 0 ? '\u00A0' : trimmedText;
                                        const cellClassName = `min-w-[120px] max-w-[360px] whitespace-pre-wrap break-words border border-border-subtle px-3 py-2 text-left ${
                                          rowIndex === 0 ? 'bg-bg-secondary/55 font-semibold' : 'bg-bg-card/55'
                                        }`;
                                        const contentNode = (
                                          <div className="flex flex-col gap-2">
                                            <div>{cellContent}</div>
                                            {imageSources.length > 0 && (
                                              <div className="flex flex-wrap gap-2">
                                                {imageSources.map((src, imageIndex) => (
                                                  <img
                                                    key={`${sheet.name}-${rowIndex}-${cellIndex}-${imageIndex}`}
                                                    src={src}
                                                    alt={trimmedText || `${sheet.name}-${rowIndex + 1}-${cellIndex + 1}`}
                                                    className="max-h-24 max-w-[140px] rounded-lg border border-border-subtle bg-white object-contain p-1"
                                                    loading="lazy"
                                                    draggable={false}
                                                  />
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        );
                                        return rowIndex === 0 ? (
                                          <th key={`${sheet.name}-${rowIndex}-${cellIndex}`} className={cellClassName}>
                                            {contentNode}
                                          </th>
                                        ) : (
                                          <td key={`${sheet.name}-${rowIndex}-${cellIndex}`} className={cellClassName}>
                                            {contentNode}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <div className="px-4 py-5 text-sm text-text-muted">
                              这个工作表里暂时没有可预览的数据
                            </div>
                          )}
                        </section>
                      ))}
                    </div>
                  ) : fileContent.startsWith('//') ? (
                    <div className="rounded-2xl border border-error/20 bg-error/5 px-4 py-4 text-sm text-error">
                      {fileContent.replace(/^\/\/\s*/, '')}
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap break-words text-[13px] leading-6 text-text-primary font-mono">
                      {fileContent}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : previewMode === 'preview' && isHtml && fileContent !== null && selectedFile ? (
          /* HTML preview: inject <base> tag so relative CSS/JS/images resolve correctly */
          <iframe
            srcDoc={injectBaseTag(fileContent, selectedFile)}
            sandbox="allow-scripts"
            className="w-full h-full bg-white border-0"
            title={fileName}
          />
        ) : previewMode === 'preview' && isSvg && fileContent !== null ? (
          /* SVG preview: render inside a locked-down iframe (no scripts, no
             same-origin) so a malicious <script>/<foreignObject> inside an SVG
             can never reach the app's IPC bridge. */
          <div className="flex items-center justify-center h-full p-4 overflow-auto">
            <iframe
              srcDoc={fileContent}
              sandbox=""
              title={fileName}
              className="max-w-full max-h-full bg-white border-0"
            />
          </div>
        ) : previewMode === 'preview' && isMarkdown && displayedMarkdownContent !== null ? (
          /* Markdown preview: rendered */
          <div className="overflow-auto h-full p-4">
            <div className="text-sm leading-relaxed selectable max-w-3xl mx-auto">
              {(() => {
                // Extract YAML frontmatter if present
                const fmMatch = displayedMarkdownContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
                const frontmatter = fmMatch ? fmMatch[1] : null;
                const body = fmMatch ? displayedMarkdownContent.slice(fmMatch[0].length) : displayedMarkdownContent;
                return (
                  <>
                    {skillTranslationError && (
                      <div className="mb-3 rounded-lg border border-error/30
                        bg-error/10 px-3 py-2 text-xs text-error">
                        {skillTranslationError}
                      </div>
                    )}
                    {frontmatter && (
                      <div className="mb-4 rounded-lg border border-border-subtle
                        bg-bg-secondary/50 overflow-hidden text-xs font-mono">
                        <div className="px-3 py-1 border-b border-border-subtle/50
                          bg-bg-tertiary/30 text-[10px] text-text-tertiary font-sans">
                          frontmatter
                        </div>
                        <div className="px-3 py-2 text-text-muted whitespace-pre-wrap">
                          {frontmatter}
                        </div>
                      </div>
                    )}
                    <MarkdownRenderer content={body} />
                  </>
                );
              })()}
            </div>
          </div>
        ) : fileContent !== null ? (
          /* Source view: read-only CodeMirror */
          <CodeMirror
            value={fileContent}
            extensions={[...(Array.isArray(langExtension) ? langExtension : [langExtension]), EditorView.lineWrapping, tokenicodeHighlight]}
            theme={tokenicodeTheme}
            editable={false}
            readOnly={true}
            height="100%"
            style={{ height: '100%', fontSize: '13px' }}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: false,
              foldGutter: true,
              bracketMatching: true,
              tabSize: 2,
            }}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-xs text-text-muted">{t('files.errorLoading')}</div>
          </div>
        )}
      </div>

      {/* Unsaved changes dialog */}
      {showUnsavedDialog && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
          onClick={cancelNavigation}>
          <div className="bg-bg-card border border-border-subtle rounded-xl p-5
            shadow-lg max-w-sm w-full mx-4 animate-fade-in"
            onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-text-primary mb-1 font-medium">
              {t('files.unsavedTitle')}
            </p>
            <p className="text-xs text-text-muted mb-4">
              {t('files.unsavedMessage')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={confirmDiscard}
                className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary
                  text-text-muted hover:bg-bg-tertiary transition-smooth cursor-pointer">
                {t('files.discardChanges')}
              </button>
              <button
                onClick={cancelNavigation}
                className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary
                  text-text-muted hover:bg-bg-tertiary transition-smooth cursor-pointer">
                {t('common.cancel')}
              </button>
              <button
                onClick={confirmSaveAndSwitch}
                className="px-3 py-1.5 text-xs rounded-lg bg-accent
                  text-text-inverse hover:bg-accent-hover transition-smooth cursor-pointer">
                {t('files.saveAndSwitch')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
