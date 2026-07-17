export const DEEPSEEK_V4_PRO = 'deepseek-v4-pro';
export const DEEPSEEK_V4_FLASH = 'deepseek-v4-flash';
export const DEEPSEEK_V4_PRO_LABEL = 'Primary';
export const DEEPSEEK_V4_FLASH_LABEL = 'Fast';

export function normalizeDeepSeekModelName(model: string | undefined | null): string {
  if (!model) return '';

  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  const compact = lower.replace(/[\s_.()[\]-]/g, '');

  if (compact.includes('deepseekv4pro')) return DEEPSEEK_V4_PRO;
  if (compact.includes('deepseekv4flash')) return DEEPSEEK_V4_FLASH;

  return trimmed;
}

export function normalizeProviderModelName(model: string | undefined | null): string {
  if (!model) return '';

  const trimmed = model.trim();
  const compact = trimmed.toLowerCase().replace(/[\s_.()[\]-]/g, '');

  if (compact.includes('deepseekv4pro')) return DEEPSEEK_V4_PRO;
  if (compact.includes('deepseekv4flash')) return DEEPSEEK_V4_FLASH;

  return trimmed;
}

export function displayDeepSeekModelName(model: string | undefined | null): string {
  return normalizeDeepSeekModelName(model);
}

export function displayProviderModelName(model: string | undefined | null): string {
  return normalizeProviderModelName(model);
}
