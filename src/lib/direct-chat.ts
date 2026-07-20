import { bridge } from './tauri-bridge';
import { type Locale, normalizeWorkspacePath } from '../stores/settingsStore';

export const DIRECT_CHAT_DIR_NAME = '.tokenicode-direct-chat';
export const DIRECT_CHAT_GROUP_KEY = '__direct_chat__';

let cachedDirectChatPath: string | null = null;

function trimTrailingSeparators(value: string): string {
  return String(value || '').replace(/[\\/]+$/, '');
}

export function isDirectChatWorkspacePath(path?: string | null): boolean {
  const normalized = trimTrailingSeparators(normalizeWorkspacePath(String(path || ''))).toLowerCase();
  if (!normalized) return false;
  return normalized.endsWith(`\\${DIRECT_CHAT_DIR_NAME}`) || normalized.endsWith(`/${DIRECT_CHAT_DIR_NAME}`);
}

export async function ensureDirectChatWorkspacePath(): Promise<string> {
  if (cachedDirectChatPath) return cachedDirectChatPath;

  const homeDir = trimTrailingSeparators(await bridge.getHomeDir());
  const directChatPath = homeDir.includes('\\')
    ? `${homeDir}\\${DIRECT_CHAT_DIR_NAME}`
    : `${homeDir}/${DIRECT_CHAT_DIR_NAME}`;

  try {
    await bridge.createDirectory(directChatPath);
  } catch {
    // Ignore "already exists" or permission edge cases and let spawn report a clear error if needed.
  }

  cachedDirectChatPath = directChatPath;
  return directChatPath;
}

export function getDirectChatLabel(locale: Locale): string {
  return locale === 'zh' ? '\u76f4\u63a5\u5bf9\u8bdd' : 'Direct Chat';
}

export function getDirectChatHint(locale: Locale): string {
  return locale === 'zh'
    ? '\u672a\u9009\u62e9\u5de5\u4f5c\u533a\uff0c\u9002\u5408\u666e\u901a\u804a\u5929\u4e0e\u65b9\u6848\u8ba8\u8bba'
    : 'No workspace selected. Great for plain chat and brainstorming.';
}

export function getDirectChatCta(locale: Locale): string {
  return locale === 'zh' ? '\u76f4\u63a5\u5f00\u59cb\u5bf9\u8bdd' : 'Start Chatting';
}

export function getSelectWorkspaceCta(locale: Locale): string {
  return locale === 'zh' ? '\u9009\u62e9\u5de5\u4f5c\u533a' : 'Select Workspace';
}
