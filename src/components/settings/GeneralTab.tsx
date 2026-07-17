import { useCallback, useRef, useState } from 'react';
import {
  useSettingsStore,
  MODEL_OPTIONS,
  type ColorTheme,
  type BackgroundTheme,
  type FontFamily,
  type ContextWindowMode,
  getAutoCompactThreshold,
  getContextWindowForModel,
} from '../../stores/settingsStore';
import { useProviderStore } from '../../stores/providerStore';
import { useT } from '../../lib/i18n';
import { displayProviderModelName } from '../../lib/deepseek-models';
import { bridge } from '../../lib/tauri-bridge';
import { optimizeBackgroundImageFile } from '../../lib/background-image';
import { AiAvatar } from '../shared/AiAvatar';
import { UserAvatar } from '../shared/UserAvatar';
import { AvatarCropModal } from './AvatarCropModal';

const MAX_BACKGROUND_DIMENSION = 1920;
const RECOMMENDED_BACKGROUND_RATIO = '16:9 / 16:10';
const RECOMMENDED_BACKGROUND_RESOLUTION = '1600x900';

const TIER_MAP: Record<string, string> = {
  'claude-opus-4-6': 'opus',
  'claude-opus-4-6-1m': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
};

const COLOR_THEMES: Array<{ id: ColorTheme; label: string; color: string }> = [
  { id: 'black', label: '经典黑', color: '#333333' },
  { id: 'blue', label: '清透蓝', color: '#4E80F7' },
  { id: 'orange', label: '暖橙', color: '#C47252' },
  { id: 'green', label: '松针绿', color: '#57A64B' },
];

const BACKGROUND_THEMES: Array<{ id: BackgroundTheme; label: string; accent: string; preview: string }> = [
  {
    id: 'garden',
    label: '花园',
    accent: '#D9857A',
    preview: 'radial-gradient(circle at 15% 90%, #AFCB8C 0 18%, transparent 20%), linear-gradient(135deg, #FFF8EA, #F7D9C6)',
  },
  {
    id: 'sakura',
    label: '樱雾',
    accent: '#C97D98',
    preview: 'radial-gradient(circle at 85% 18%, #F2B7C9 0 20%, transparent 22%), linear-gradient(135deg, #FFF4F7, #F7E6CF)',
  },
  {
    id: 'lake',
    label: '湖蓝',
    accent: '#6D9CB8',
    preview: 'radial-gradient(circle at 15% 85%, #A9CFBF 0 18%, transparent 20%), linear-gradient(135deg, #F3FBF8, #DCEEF4)',
  },
  {
    id: 'dusk',
    label: '暮紫',
    accent: '#9A83B8',
    preview: 'radial-gradient(circle at 82% 18%, #D8B6C9 0 20%, transparent 22%), linear-gradient(135deg, #F7F1FB, #E9DFD1)',
  },
  {
    id: 'ink',
    label: '墨纸',
    accent: '#7E8792',
    preview: 'radial-gradient(circle at 18% 90%, #C4CABA 0 18%, transparent 20%), linear-gradient(135deg, #F8F5EC, #E6E2D5)',
  },
  {
    id: 'vscode',
    label: 'VS Code 深色',
    accent: '#007ACC',
    preview: 'linear-gradient(90deg, #252526 0 24%, #1E1E1E 24% 100%)',
  },
  {
    id: 'minimal',
    label: '极简留白',
    accent: '#111827',
    preview: 'linear-gradient(90deg, #F7F7F8 0 24%, #FFFFFF 24% 100%)',
  },
];

const FONT_FAMILY_OPTIONS: Array<{ id: FontFamily; label: string; sample: string }> = [
  { id: 'microsoft', label: '微软雅黑 UI', sample: '中文 Aa 123' },
  { id: 'system', label: '系统默认', sample: '中文 Aa 123' },
  { id: 'sourceHan', label: '思源黑体 / Noto', sample: '中文 Aa 123' },
  { id: 'lxgw', label: '霞鹜文楷', sample: '中文 Aa 123' },
  { id: 'mono', label: '等宽字体', sample: '中文 Aa 123' },
];

const CONTEXT_WINDOW_OPTIONS: Array<{ id: ContextWindowMode; label: string; hint: string }> = [
  { id: 'default', label: '标准 200K', hint: '自动 compact 阈值 160K' },
  { id: 'large1m', label: '扩展 1M', hint: '自动 compact 阈值 800K' },
];

export async function optimizeImageFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择图片文件');
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('图片读取失败'));
      element.src = url;
    });

    const scale = Math.min(1, MAX_BACKGROUND_DIMENSION / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ThemePreview({ color }: { color: string }) {
  return (
    <div className="w-full aspect-[5/3] rounded-lg overflow-hidden border border-black/[0.06] bg-[#f5f5f5] dark:bg-[#1a1a1a] dark:border-white/[0.06] flex">
      <div className="w-[22%] border-r border-black/[0.06] dark:border-white/[0.06] p-2 flex flex-col gap-1.5">
        <div className="w-full h-2 rounded-full bg-black/[0.07] dark:bg-white/[0.08]" />
        <div className="w-[80%] h-2 rounded-full" style={{ background: color, opacity: 0.32 }} />
        <div className="w-[60%] h-2 rounded-full bg-black/[0.05] dark:bg-white/[0.06]" />
      </div>
      <div className="flex-1 flex flex-col p-2.5 gap-2">
        <div className="flex-1 flex flex-col gap-1.5 justify-center">
          <div className="w-[65%] h-2.5 rounded bg-black/[0.06] dark:bg-white/[0.07]" />
          <div className="w-[45%] h-2.5 rounded bg-black/[0.06] dark:bg-white/[0.07]" />
          <div className="w-[75%] h-2.5 rounded bg-black/[0.04] dark:bg-white/[0.05] self-end" />
        </div>
        <div className="flex items-center gap-1">
          <div className="flex-1 h-3.5 rounded bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08]" />
          <div className="w-3.5 h-3.5 rounded flex-shrink-0" style={{ background: color }} />
        </div>
      </div>
    </div>
  );
}

export function GeneralTab() {
  const t = useT();
  const activeProvider = useProviderStore((s) => {
    if (!s.activeProviderId) return null;
    return s.providers.find((p) => p.id === s.activeProviderId) ?? null;
  });

  const theme = useSettingsStore((s) => s.theme);
  const colorTheme = useSettingsStore((s) => s.colorTheme);
  const backgroundTheme = useSettingsStore((s) => s.backgroundTheme);
  const locale = useSettingsStore((s) => s.locale);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const autoCompactThresholdTokens = useSettingsStore((s) => s.autoCompactThresholdTokens);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const monoFontFollowsInterface = useSettingsStore((s) => s.monoFontFollowsInterface);
  const aiAvatarUrl = useSettingsStore((s) => s.aiAvatarUrl);
  const userAvatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const customBackgroundImageUrl = useSettingsStore((s) => s.customBackgroundImageUrl);
  const backgroundSurfaceOpacity = useSettingsStore((s) => s.backgroundSurfaceOpacity);
  const backgroundEnhanceEnabled = useSettingsStore((s) => s.backgroundEnhanceEnabled);
  const userDisplayName = useSettingsStore((s) => s.userDisplayName);

  const setTheme = useSettingsStore((s) => s.setTheme);
  const setColorTheme = useSettingsStore((s) => s.setColorTheme);
  const setBackgroundTheme = useSettingsStore((s) => s.setBackgroundTheme);
  const setLocale = useSettingsStore((s) => s.setLocale);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const setContextWindowMode = useSettingsStore((s) => s.setContextWindowMode);
  const setAutoCompactThresholdTokens = useSettingsStore((s) => s.setAutoCompactThresholdTokens);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const setMonoFontFollowsInterface = useSettingsStore((s) => s.setMonoFontFollowsInterface);
  const setAiAvatarUrl = useSettingsStore((s) => s.setAiAvatarUrl);
  const setUserAvatarUrl = useSettingsStore((s) => s.setUserAvatarUrl);
  const setCustomBackgroundImageUrl = useSettingsStore((s) => s.setCustomBackgroundImageUrl);
  const setBackgroundSurfaceOpacity = useSettingsStore((s) => s.setBackgroundSurfaceOpacity);
  const setBackgroundEnhanceEnabled = useSettingsStore((s) => s.setBackgroundEnhanceEnabled);
  const setUserDisplayName = useSettingsStore((s) => s.setUserDisplayName);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const userFileInputRef = useRef<HTMLInputElement>(null);
  const backgroundFileInputRef = useRef<HTMLInputElement>(null);

  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropTarget, setCropTarget] = useState<'ai' | 'user'>('ai');
  const [backgroundUploading, setBackgroundUploading] = useState(false);
  const [backgroundUploadError, setBackgroundUploadError] = useState('');

  const selectedTier = TIER_MAP[selectedModel];
  const selectedMapping = selectedTier
    ? activeProvider?.modelMappings.find((mapping) => mapping.tier === selectedTier)
    : undefined;
  const actualModel = selectedMapping?.providerModel || selectedModel;
  const contextWindow = getContextWindowForModel(actualModel, contextWindowMode);
  const compactThreshold = getAutoCompactThreshold(actualModel, contextWindowMode, autoCompactThresholdTokens);
  const clampedBackgroundSurfaceOpacity = Math.max(0, Math.min(100, backgroundSurfaceOpacity));
  const previewSidebarOpacity = backgroundEnhanceEnabled
    ? Math.min(98, Math.max(clampedBackgroundSurfaceOpacity, 18) + 14)
    : clampedBackgroundSurfaceOpacity;
  const previewChatOpacity = backgroundEnhanceEnabled
    ? Math.min(99, Math.max(clampedBackgroundSurfaceOpacity, 16) + 18)
    : clampedBackgroundSurfaceOpacity;
  const tierMappings = activeProvider?.modelMappings
    .filter((mapping) => ['opus', 'sonnet', 'haiku'].includes(mapping.tier) && mapping.providerModel)
    .map((mapping) => `${mapping.tier}=${displayProviderModelName(mapping.providerModel)}`)
    .join(' / ');

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>, target: 'ai' | 'user') => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCropTarget(target);
    setCropFile(file);
  }, []);

  const applyBackgroundDataUrl = useCallback((dataUrl: string) => {
    const currentBackground = useSettingsStore.getState().customBackgroundImageUrl;
    if (currentBackground === dataUrl) {
      setCustomBackgroundImageUrl('');
      requestAnimationFrame(() => setCustomBackgroundImageUrl(dataUrl));
      return;
    }
    setCustomBackgroundImageUrl(dataUrl);
  }, [setCustomBackgroundImageUrl]);

  const handleBackgroundFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setBackgroundUploading(true);
    setBackgroundUploadError('');
    try {
      const dataUrl = await optimizeBackgroundImageFile(file);
      applyBackgroundDataUrl(dataUrl);

      try {
        const bytes = Array.from(new Uint8Array(await (await fetch(dataUrl)).arrayBuffer()));
        await bridge.saveBackgroundImage(file.name || 'background.jpg', bytes);
      } catch {
        // Best-effort backup only.
      }
    } catch (error) {
      setBackgroundUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setBackgroundUploading(false);
    }
  }, [applyBackgroundDataUrl]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-3">头像与昵称</h3>
        <div className="flex items-start gap-6 flex-wrap">
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="group relative cursor-pointer"
              title={t('settings.aiAvatarChange')}
            >
              <AiAvatar size="w-14 h-14" rounded="rounded-2xl" />
              <div className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100 transition-smooth flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 9v4H4V9M8 3v7M5 6l3-3 3 3" />
                </svg>
              </div>
            </button>
            <span className="text-[11px] text-text-tertiary">AI</span>
            {aiAvatarUrl && (
              <button
                onClick={() => setAiAvatarUrl('')}
                className="text-[11px] text-text-muted hover:text-red-500 transition-smooth"
              >
                重置
              </button>
            )}
          </div>

          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => userFileInputRef.current?.click()}
              className="group relative cursor-pointer"
              title={t('settings.userAvatarChange')}
            >
              <UserAvatar size="w-14 h-14" rounded="rounded-2xl" />
              <div className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100 transition-smooth flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 9v4H4V9M8 3v7M5 6l3-3 3 3" />
                </svg>
              </div>
            </button>
            <input
              type="text"
              value={userDisplayName}
              onChange={(e) => setUserDisplayName(e.target.value)}
              placeholder={t('settings.userNamePlaceholder')}
              maxLength={20}
              className="w-28 px-2 py-1 rounded-lg text-[11px] text-center bg-bg-secondary border border-border-subtle text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-smooth"
            />
            {userAvatarUrl && (
              <button
                onClick={() => setUserAvatarUrl('')}
                className="text-[11px] text-text-muted hover:text-red-500 transition-smooth"
              >
                重置
              </button>
            )}
          </div>

          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleFileSelect(e, 'ai')} />
          <input ref={userFileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleFileSelect(e, 'user')} />
        </div>
      </div>

      {cropFile && (
        <AvatarCropModal
          imageFile={cropFile}
          onSave={(dataUrl) => {
            if (cropTarget === 'ai') setAiAvatarUrl(dataUrl);
            else setUserAvatarUrl(dataUrl);
            setCropFile(null);
          }}
          onCancel={() => setCropFile(null)}
        />
      )}

      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-3">主题颜色</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {COLOR_THEMES.map((item) => (
            <button
              key={item.id}
              onClick={() => setColorTheme(item.id)}
              className={`rounded-xl p-2 text-left transition-smooth ${
                colorTheme === item.id
                  ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-card bg-accent/[0.03]'
                  : 'border border-border-subtle hover:border-black/10 dark:hover:border-white/10 hover:scale-[1.02]'
              }`}
            >
              <ThemePreview color={item.color} />
              <div className="mt-2 text-center text-[12px] font-medium text-text-muted">{item.label}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-3">背景风格</h3>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {BACKGROUND_THEMES.map((item) => (
            <button
              key={item.id}
              onClick={() => setBackgroundTheme(item.id)}
              className={`rounded-xl p-2 text-left transition-smooth ${
                backgroundTheme === item.id
                  ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-card bg-accent/[0.03]'
                  : 'border border-border-subtle hover:border-black/10 dark:hover:border-white/10 hover:scale-[1.02]'
              }`}
            >
              <div className="w-full aspect-[5/3] rounded-lg overflow-hidden border border-black/[0.06] relative" style={{ background: item.preview }}>
                <div className="absolute inset-x-2 top-2 h-2 rounded-full bg-white/45" />
                <div className="absolute left-2 bottom-2 w-10 h-5 rounded-md bg-white/45" />
                <div className="absolute right-2 bottom-2 w-5 h-5 rounded-md" style={{ background: item.accent }} />
              </div>
              <div className="mt-2 text-center text-[12px] font-medium text-text-muted">{item.label}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-border-subtle bg-bg-secondary/40 p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-medium text-text-primary">自定义背景图</h3>
            <p className="mt-1 text-xs text-text-tertiary leading-relaxed">
              上传后会立即应用背景图，并同时保存一份本地优化备份。
            </p>
            <div className="mt-3 rounded-xl border border-border-subtle bg-bg-card/60 px-3 py-2 text-[11px] leading-5 text-text-tertiary">
              <div>支持格式：JPG / PNG / WebP</div>
              <div>推荐比例：{RECOMMENDED_BACKGROUND_RATIO}</div>
              <div>推荐最小尺寸：{RECOMMENDED_BACKGROUND_RESOLUTION}</div>
              <div>其他比例也可使用，但界面采用 cover 模式，边缘可能会被裁切。</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => backgroundFileInputRef.current?.click()}
                className="px-3 py-2 rounded-lg text-[13px] font-medium bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
              >
                {customBackgroundImageUrl ? '更换图片' : '上传图片'}
              </button>
              <button
                onClick={() => setCustomBackgroundImageUrl('')}
                disabled={!customBackgroundImageUrl}
                className="px-3 py-2 rounded-lg text-[13px] font-medium border border-border-subtle text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-smooth disabled:opacity-40 disabled:cursor-not-allowed"
              >
                清除背景
              </button>
            </div>
            {backgroundUploading && <p className="mt-2 text-xs text-text-tertiary">正在处理图片...</p>}
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[12px] font-medium text-text-primary">界面蒙层透明度</label>
                <span className="text-[11px] text-text-tertiary">{clampedBackgroundSurfaceOpacity}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={clampedBackgroundSurfaceOpacity}
                onChange={(e) => setBackgroundSurfaceOpacity(Number(e.target.value))}
                className="mt-2 w-full accent-accent"
              />
              <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
                数值越低，聊天区和侧栏越透明，背景图就会显示得更完整。
              </p>
            </div>
            <div className="mt-4 rounded-xl border border-border-subtle bg-bg-card/60 px-3 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[12px] font-medium text-text-primary">背景增强模式</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">
                    适合花纹复杂或对比度较高的背景图，在尽量保留完整背景的同时提升文字可读性。
                  </p>
                </div>
                <button
                  onClick={() => setBackgroundEnhanceEnabled(!backgroundEnhanceEnabled)}
                  className="inline-flex items-center gap-2 text-[12px] text-text-secondary hover:text-text-primary transition-smooth flex-shrink-0"
                >
                  <span className={`relative w-8 h-4 rounded-full transition-smooth ${
                    backgroundEnhanceEnabled ? 'bg-accent/80' : 'bg-bg-tertiary border border-border-subtle'
                  }`}
                  >
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
                      backgroundEnhanceEnabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                    />
                  </span>
                  {backgroundEnhanceEnabled ? '已开启' : '已关闭'}
                </button>
              </div>
            </div>
            {backgroundUploadError && <p className="mt-2 text-xs text-red-500">{backgroundUploadError}</p>}
          </div>

          <div className="w-[240px] max-w-full flex-shrink-0">
            <div
              className="relative aspect-[16/10] overflow-hidden rounded-xl border border-border-subtle bg-bg-primary"
              style={customBackgroundImageUrl
                ? {
                    backgroundImage: `url("${customBackgroundImageUrl}")`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                  }
                : undefined}
            >
              {!customBackgroundImageUrl && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-text-tertiary">
                  暂未设置背景图
                </div>
              )}
              {customBackgroundImageUrl && (
                <>
                  <div
                    className="absolute inset-0"
                    style={backgroundEnhanceEnabled
                      ? {
                          background: 'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.08)), radial-gradient(circle at 20% 16%, rgba(255,255,255,0.20), transparent 34%), radial-gradient(circle at 84% 12%, rgba(255,255,255,0.12), transparent 30%)',
                        }
                      : { backgroundColor: `rgba(0, 0, 0, ${0.02 + (clampedBackgroundSurfaceOpacity / 100) * 0.06})` }}
                  />
                  <div
                    className="absolute left-3 top-3 bottom-3 w-[28%] rounded-lg border border-white/15 shadow-sm backdrop-blur-xl"
                    style={{
                      backgroundColor: `color-mix(in srgb, var(--color-bg-sidebar) ${previewSidebarOpacity}%, transparent)`,
                      boxShadow: backgroundEnhanceEnabled ? '0 12px 30px rgba(15, 23, 42, 0.14)' : undefined,
                    }}
                  >
                    <div className="space-y-2 p-2.5">
                      <div className="h-2.5 rounded-full bg-white/40" />
                      <div className="h-2 rounded-full bg-white/25" />
                      <div className="h-2 rounded-full bg-white/20" />
                    </div>
                  </div>
                  <div
                    className="absolute inset-y-3 right-3 left-[36%] rounded-lg border border-white/12 shadow-sm backdrop-blur-xl"
                    style={{
                      backgroundColor: `color-mix(in srgb, var(--color-bg-chat) ${previewChatOpacity}%, transparent)`,
                      boxShadow: backgroundEnhanceEnabled ? '0 12px 30px rgba(15, 23, 42, 0.14)' : undefined,
                    }}
                  >
                    <div className="flex h-full flex-col justify-between p-3">
                      <div className="space-y-2">
                        <div className="h-2.5 w-[62%] rounded-full bg-white/40" />
                        <div className="ml-auto h-9 w-[56%] rounded-2xl bg-white/28" />
                        <div className="h-8 w-[72%] rounded-2xl bg-white/22" />
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-8 flex-1 rounded-full bg-white/20" />
                        <div className="h-8 w-8 rounded-full bg-white/35" />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
            <p className="mt-2 text-[11px] text-text-tertiary">
              这里的预览会和当前背景图及蒙层透明度保持同步。
            </p>
          </div>
        </div>
        <input
          ref={backgroundFileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleBackgroundFileSelect}
        />
      </div>

      <div className="flex items-start gap-8 flex-wrap">
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.appearance')}</h3>
          <div className="inline-flex rounded-lg border border-border-subtle overflow-hidden">
            {(['light', 'dark', 'system'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setTheme(mode)}
                className={`py-1.5 px-3 text-[13px] font-medium transition-smooth border-r border-border-subtle last:border-r-0 whitespace-nowrap ${
                  theme === mode ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-bg-secondary'
                }`}
              >
                {t(`settings.${mode}`)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.language')}</h3>
          <div className="inline-flex rounded-lg border border-border-subtle overflow-hidden">
            {(['zh', 'en'] as const).map((lang) => (
              <button
                key={lang}
                onClick={() => setLocale(lang)}
                className={`py-1.5 px-3 text-[13px] font-medium transition-smooth border-r border-border-subtle last:border-r-0 ${
                  locale === lang ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-bg-secondary'
                }`}
              >
                {lang === 'zh' ? '中文' : 'EN'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.fontSize')}</h3>
          <div className="inline-flex items-center rounded-lg border border-border-subtle overflow-hidden">
            <button
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= 10}
              className="w-8 h-8 text-[13px] font-bold text-text-primary hover:bg-bg-secondary transition-smooth disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center border-r border-border-subtle"
            >
              -
            </button>
            <span className="w-14 text-center text-[13px] font-semibold text-text-primary">{fontSize}px</span>
            <button
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= 36}
              className="w-8 h-8 text-[13px] font-bold text-text-primary hover:bg-bg-secondary transition-smooth disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center border-l border-border-subtle"
            >
              +
            </button>
          </div>
        </div>

        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.fontFamily')}</h3>
          <select
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value as FontFamily)}
            className="h-8 min-w-48 px-2 rounded-lg bg-bg-secondary border border-border-subtle text-[13px] text-text-primary outline-none focus:border-accent/60"
          >
            {FONT_FAMILY_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} · {option.sample}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-text-tertiary">{t('settings.fontFamilyHint')}</p>
          <button
            onClick={() => setMonoFontFollowsInterface(!monoFontFollowsInterface)}
            className="mt-2 inline-flex items-center gap-2 text-[12px] text-text-secondary hover:text-text-primary transition-smooth"
          >
            <span className={`relative w-8 h-4 rounded-full transition-smooth ${
              monoFontFollowsInterface ? 'bg-accent/80' : 'bg-bg-tertiary border border-border-subtle'
            }`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
                monoFontFollowsInterface ? 'translate-x-4' : 'translate-x-0.5'
              }`}
              />
            </span>
            {t('settings.monoFontFollowsInterface')}
          </button>
        </div>

        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.defaultModel')}</h3>
          <div className="flex flex-wrap gap-2">
            {MODEL_OPTIONS.map((model) => (
              <button
                key={model.id}
                onClick={() => setSelectedModel(model.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-smooth ${
                  selectedModel === model.id
                    ? 'bg-accent/10 text-accent border border-accent/30'
                    : 'text-text-muted hover:bg-bg-secondary border border-border-subtle'
                }`}
              >
                {selectedModel === model.id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M3 8l4 4 6-7" />
                  </svg>
                )}
                {(() => {
                  if (!activeProvider) return model.short;
                  const tier = TIER_MAP[model.id];
                  const mapping = activeProvider.modelMappings.find((item) => item.tier === tier);
                  return mapping?.providerModel ? displayProviderModelName(mapping.providerModel) : model.short;
                })()}
              </button>
            ))}
          </div>
          <div className="mt-2 text-xs text-text-tertiary leading-relaxed">
            当前实际模型：<span className="font-mono text-text-muted">{displayProviderModelName(actualModel)}</span>
            {activeProvider && tierMappings && <span className="ml-2">映射：{tierMappings}</span>}
          </div>
        </div>

        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">上下文窗口</h3>
          <div className="grid grid-cols-2 gap-2">
            {CONTEXT_WINDOW_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => setContextWindowMode(option.id)}
                className={`text-left px-3 py-2 rounded-lg border transition-smooth ${
                  contextWindowMode === option.id
                    ? 'bg-accent/10 text-accent border-accent/30'
                    : 'text-text-muted hover:bg-bg-secondary border-border-subtle'
                }`}
              >
                <div className="text-[13px] font-medium">{option.label}</div>
                <div className="mt-0.5 text-[11px] text-text-tertiary">{option.hint}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-tertiary leading-relaxed">
            当前窗口：{contextWindow.toLocaleString()} tokens。自动 compact 阈值：{compactThreshold.toLocaleString()} tokens。
            如果你的路由确实支持 1M 上下文，可以切换到上方的 1M 模式。
          </p>
        </div>

        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">自动 compact 阈值</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="number"
              min={10}
              max={1000}
              step={10}
              value={Math.round(autoCompactThresholdTokens / 1000)}
              onChange={(e) => setAutoCompactThresholdTokens(Number(e.target.value) * 1000)}
              className="w-28 px-3 py-2 text-[13px] bg-bg-chat border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-xs text-text-tertiary">K tokens</span>
            <div className="flex flex-wrap gap-1.5">
              {[160, 400, 800, 950].map((value) => (
                <button
                  key={value}
                  onClick={() => setAutoCompactThresholdTokens(value * 1000)}
                  className={`px-2 py-1 rounded-md text-[11px] border transition-smooth ${
                    Math.round(autoCompactThresholdTokens / 1000) === value
                      ? 'bg-accent/10 text-accent border-accent/30'
                      : 'text-text-muted hover:bg-bg-secondary border-border-subtle'
                  }`}
                >
                  {value}K
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-text-tertiary leading-relaxed">
            这个值会直接决定自动触发 `/compact` 的时机，修改后会立刻作用到当前会话。
          </p>
        </div>
      </div>
    </div>
  );
}
