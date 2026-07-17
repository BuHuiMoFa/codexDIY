import { useFileStore } from '../stores/fileStore';
import { usePreviewStore } from '../stores/previewStore';
import { useSettingsStore } from '../stores/settingsStore';

const WEB_PREVIEW_FILE_EXTS = new Set(['html', 'htm', 'svg']);
const FILE_PREVIEW_EXTS = new Set([
  'md', 'mdx', 'html', 'htm', 'xhtml', 'svg',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
  'pdf', 'mp4', 'webm', 'mov', 'avi', 'mp3', 'wav', 'ogg', 'aac', 'm4a',
  'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
  'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'json', 'css', 'scss', 'less',
  'java', 'kt', 'c', 'cpp', 'h', 'hpp', 'sql', 'xml', 'yaml', 'yml',
  'go', 'sh', 'bash', 'zsh', 'rb', 'swift', 'lua', 'toml', 'txt', 'log',
]);

function getFileExt(target: string): string {
  const clean = target.split('?')[0].split('#')[0];
  const lastDot = clean.lastIndexOf('.');
  return lastDot >= 0 ? clean.slice(lastDot + 1).toLowerCase() : '';
}

export function isLikelyPreviewUrl(target: string): boolean {
  const trimmed = target.trim();
  return /^(https?:\/\/|file:\/\/|about:|data:)/i.test(trimmed)
    || /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed);
}

export function canOpenInWebPreview(target: string): boolean {
  if (!target) return false;
  if (isLikelyPreviewUrl(target)) return true;
  return WEB_PREVIEW_FILE_EXTS.has(getFileExt(target));
}

export function canOpenInFilePreview(target: string): boolean {
  if (!target || isLikelyPreviewUrl(target)) return false;
  const ext = getFileExt(target);
  return !!ext && FILE_PREVIEW_EXTS.has(ext) || /^[A-Za-z]:[/\\]/.test(target) || target.startsWith('/') || target.startsWith('./') || target.startsWith('../');
}

export function toAbsolutePath(target: string, basePath = ''): string {
  if (!target) return target;
  if (target.startsWith('/') || /^[A-Za-z]:[/\\]/.test(target)) return target;
  if (!basePath) return target;
  return `${basePath.replace(/[\\/]+$/, '')}/${target}`;
}

export function toFilePreviewUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    return encodeURI(`file:///${normalized}`);
  }
  if (normalized.startsWith('/')) {
    return encodeURI(`file://${normalized}`);
  }
  return encodeURI(`file://${normalized}`);
}

export function openFilePreview(target: string, basePath = ''): void {
  const resolved = toAbsolutePath(target, basePath);
  useFileStore.getState().selectFile(resolved);
}

export function openWebPreview(target: string, basePath = ''): void {
  const resolved = isLikelyPreviewUrl(target)
    ? target.trim()
    : toFilePreviewUrl(toAbsolutePath(target, basePath));
  useSettingsStore.getState().setSecondaryTab('preview');
  usePreviewStore.getState().openUrl(resolved);
}

export function fileUrlToPath(fileUrl: string): string | null {
  if (!fileUrl.startsWith('file://')) return null;
  try {
    const parsed = new URL(fileUrl);
    let pathname = decodeURIComponent(parsed.pathname || '');
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname.replace(/\//g, '\\');
  } catch {
    return null;
  }
}
