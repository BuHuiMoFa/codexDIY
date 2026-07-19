import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEEPSEEK_V4_FLASH,
  DEEPSEEK_V4_PRO,
  normalizeDeepSeekModelName,
} from '../lib/deepseek-models';

// --- Types ---

export type Theme = 'light' | 'dark' | 'system';
export type ColorTheme = 'black' | 'blue' | 'orange' | 'green';
export type BackgroundTheme = 'garden' | 'sakura' | 'lake' | 'dusk' | 'ink' | 'vscode' | 'minimal';
export type SecondaryPanelTab = 'overview' | 'files' | 'preview' | 'skills' | 'plugins';
export type ModelId = 'claude-opus-4-6' | 'claude-opus-4-6-1m' | 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';
export type SessionMode = 'code' | 'ask' | 'plan' | 'bypass';
export type FontFamily = 'system' | 'microsoft' | 'sourceHan' | 'lxgw' | 'mono';
export interface CustomThemeColors {
  background: string;
  surface: string;
  surfaceAlt: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  text: string;
  textMuted: string;
  border: string;
}
export interface CustomThemeConfig {
  id: string;
  name: string;
  headline: string;
  tagline: string;
  projectLabel: string;
  projectButtonText: string;
  statusText: string;
  quoteText: string;
  colors: CustomThemeColors;
}
export interface WorkspaceEntry {
  path: string;
  lastUsed: number;
}
/** CLI permission mode for the SDK control protocol */
export type CliPermissionMode = 'acceptEdits' | 'default' | 'plan' | 'bypassPermissions';
export type Locale = 'zh' | 'en';

/** Map frontend session mode to CLI permission mode */
export function mapSessionModeToPermissionMode(mode: SessionMode): CliPermissionMode {
  switch (mode) {
    case 'code': return 'acceptEdits';
    case 'ask': return 'default';
    case 'plan': return 'plan';
    case 'bypass': return 'bypassPermissions';
  }
}
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';
export type ContextWindowMode = 'default' | 'large1m';

function defaultAutoCompactThreshold(mode: ContextWindowMode): number {
  return mode === 'large1m' ? 800_000 : 160_000;
}

function clampAutoCompactThreshold(tokens: number): number {
  if (!Number.isFinite(tokens)) return 160_000;
  return Math.max(10_000, Math.min(1_000_000, Math.round(tokens)));
}

function clampBackgroundSurfaceOpacity(value: number): number {
  if (!Number.isFinite(value)) return 82;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function trimThemeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return (trimmed || fallback).slice(0, maxLength);
}

function normalizeThemeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 32);
}

export const DEFAULT_CUSTOM_THEME: CustomThemeConfig = {
  id: 'custom-tokenicode-theme',
  name: '我的自定义主题',
  headline: 'TOKENICODE DREAM SKIN',
  tagline: '把喜欢的背景、颜色和文字组合成你自己的工作台。',
  projectLabel: '当前工作区',
  projectButtonText: '选择项目',
  statusText: 'CUSTOM THEME ONLINE',
  quoteText: 'MAKE SOMETHING WONDERFUL',
  colors: {
    background: '#F7F4F5',
    surface: '#FFFFFF',
    surfaceAlt: '#FFF7F8',
    accent: '#F07A86',
    accentStrong: '#C93D4C',
    accentSoft: '#F3A8AF',
    text: '#2B2224',
    textMuted: '#8A7A7D',
    border: '#E7C7CB',
  },
};

function sanitizeCustomTheme(input: unknown): CustomThemeConfig {
  const source = (input && typeof input === 'object' ? input : {}) as Partial<CustomThemeConfig>;
  const colors = (source.colors && typeof source.colors === 'object' ? source.colors : {}) as Partial<CustomThemeColors>;
  return {
    id: trimThemeText(source.id, DEFAULT_CUSTOM_THEME.id, 48),
    name: trimThemeText(source.name, DEFAULT_CUSTOM_THEME.name, 32),
    headline: trimThemeText(source.headline, DEFAULT_CUSTOM_THEME.headline, 60),
    tagline: trimThemeText(source.tagline, DEFAULT_CUSTOM_THEME.tagline, 120),
    projectLabel: trimThemeText(source.projectLabel, DEFAULT_CUSTOM_THEME.projectLabel, 32),
    projectButtonText: trimThemeText(source.projectButtonText, DEFAULT_CUSTOM_THEME.projectButtonText, 24),
    statusText: trimThemeText(source.statusText, DEFAULT_CUSTOM_THEME.statusText, 40),
    quoteText: trimThemeText(source.quoteText, DEFAULT_CUSTOM_THEME.quoteText, 48),
    colors: {
      background: normalizeThemeColor(colors.background, DEFAULT_CUSTOM_THEME.colors.background),
      surface: normalizeThemeColor(colors.surface, DEFAULT_CUSTOM_THEME.colors.surface),
      surfaceAlt: normalizeThemeColor(colors.surfaceAlt, DEFAULT_CUSTOM_THEME.colors.surfaceAlt),
      accent: normalizeThemeColor(colors.accent, DEFAULT_CUSTOM_THEME.colors.accent),
      accentStrong: normalizeThemeColor(colors.accentStrong, DEFAULT_CUSTOM_THEME.colors.accentStrong),
      accentSoft: normalizeThemeColor(colors.accentSoft, DEFAULT_CUSTOM_THEME.colors.accentSoft),
      text: normalizeThemeColor(colors.text, DEFAULT_CUSTOM_THEME.colors.text),
      textMuted: normalizeThemeColor(colors.textMuted, DEFAULT_CUSTOM_THEME.colors.textMuted),
      border: normalizeThemeColor(colors.border, DEFAULT_CUSTOM_THEME.colors.border),
    },
  };
}

export function normalizeWorkspacePath(path: string): string {
  const trimmed = String(path || '').trim();
  if (!trimmed) return '';
  if (/^[A-Za-z]:[\\/]*$/.test(trimmed)) {
    return `${trimmed[0].toUpperCase()}:\\`;
  }
  const normalized = trimmed.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(normalized)) {
    return `${normalized}\\`;
  }
  return normalized;
}

function upsertWorkspaceEntry(
  workspaces: WorkspaceEntry[],
  path: string,
  lastUsed = Date.now(),
): WorkspaceEntry[] {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return workspaces;
  const deduped = workspaces.filter((workspace) => normalizeWorkspacePath(workspace.path) !== normalized);
  return [{ path: normalized, lastUsed }, ...deduped].slice(0, 24);
}

function removeWorkspaceEntry(workspaces: WorkspaceEntry[], path: string): WorkspaceEntry[] {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return workspaces;
  return workspaces.filter((workspace) => normalizeWorkspacePath(workspace.path) !== normalized);
}

// --- Model options (display mapping) ---

export const MODEL_OPTIONS: { id: ModelId; label: string; short: string }[] = [
  { id: 'claude-opus-4-6', label: 'Primary', short: 'Primary' },
  { id: 'claude-sonnet-4-6', label: 'Fast', short: 'Fast' },
];

function migrateModelSelection(model: unknown): ModelId | undefined {
  if (typeof model !== 'string') return undefined;
  const normalized = normalizeDeepSeekModelName(model);
  if (normalized === DEEPSEEK_V4_PRO) return 'claude-opus-4-6';
  if (normalized === DEEPSEEK_V4_FLASH) return 'claude-sonnet-4-6';
  if (model === 'claude-opus-4-6-1m') return 'claude-opus-4-6';
  if (model === 'claude-haiku-4-5-20251001' || model === 'claude-haiku-4-5') return 'claude-sonnet-4-6';
  return undefined;
}

// --- Store State & Actions ---

interface SettingsState {
  theme: Theme;
  colorTheme: ColorTheme;
  backgroundTheme: BackgroundTheme;
  sidebarOpen: boolean;
  secondaryPanelOpen: boolean;
  secondaryPanelTab: SecondaryPanelTab;
  secondaryPanelWidth: number;
  settingsOpen: boolean;
  workingDirectory: string;
  workspaces: WorkspaceEntry[];
  selectedModel: string;
  sessionMode: SessionMode;
  locale: Locale;
  /** Global UI font size in px (default 18) */
  fontSize: number;
  /** Global UI font family preset */
  fontFamily: FontFamily;
  /** Whether mono-styled UI labels should follow the selected interface font */
  monoFontFollowsInterface: boolean;
  /** Sidebar width in px (default 280) */
  sidebarWidth: number;
  /** Whether the CLI setup wizard has been completed or skipped */
  setupCompleted: boolean;
  /** Thinking effort level: off disables, low/medium/high/max set effort */
  thinkingLevel: ThinkingLevel;
  /** Declares that the selected/provider model supports a 1M context window. */
  contextWindowMode: ContextWindowMode;
  /** User-adjustable auto compact threshold in tokens. */
  autoCompactThresholdTokens: number;
  /** Whether a newer version is available (set by auto-check on startup) */
  updateAvailable: boolean;
  /** Whether a newer CLI version is available */
  cliUpdateAvailable: boolean;
  /** Latest CLI version string (for display) */
  cliLatestVersion: string;
  /** Version string of the available update */
  updateVersion: string;
  /** Whether the update has been downloaded and is ready for restart (transient, not persisted) */
  updateDownloaded: boolean;
  /** Last app version the user has seen the changelog for */
  lastSeenVersion: string;
  /** Custom AI avatar image (data URL or empty string for default </> icon) */
  aiAvatarUrl: string;
  /** Custom user avatar image (data URL or empty string for default initials) */
  userAvatarUrl: string;
  /** Custom interface background image (optimized data URL) */
  customBackgroundImageUrl: string;
  /** Whether the editable custom theme overrides the selected preset background theme */
  customThemeEnabled: boolean;
  /** User-editable theme metadata + palette */
  customTheme: CustomThemeConfig;
  /** Foreground surface opacity when a custom background image is active */
  backgroundSurfaceOpacity: number;
  /** Extra readability mode for busy custom backgrounds */
  backgroundEnhanceEnabled: boolean;
  /** User display name shown next to messages */
  userDisplayName: string;
  /** Whether to show dotfiles (hidden files) in the file tree */
  showHiddenFiles: boolean;

  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setColorTheme: (colorTheme: ColorTheme) => void;
  setBackgroundTheme: (backgroundTheme: BackgroundTheme) => void;
  /** Whether the floating agent panel is open */
  agentPanelOpen: boolean;

  toggleSidebar: () => void;
  toggleSecondaryPanel: () => void;
  toggleSecondaryTab: (tab: SecondaryPanelTab) => void;
  toggleAgentPanel: () => void;
  setSecondaryTab: (tab: SecondaryPanelTab) => void;
  setSecondaryPanelWidth: (width: number) => void;
  toggleSettings: () => void;
  setWorkingDirectory: (dir: string) => void;
  addWorkspace: (dir: string) => void;
  addWorkspaces: (dirs: string[]) => void;
  removeWorkspace: (dir: string) => void;
  setSelectedModel: (model: string) => void;
  setSessionMode: (mode: SessionMode) => void;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: FontFamily) => void;
  setMonoFontFollowsInterface: (enabled: boolean) => void;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  setSidebarWidth: (width: number) => void;
  setSetupCompleted: (completed: boolean) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  setContextWindowMode: (mode: ContextWindowMode) => void;
  setAutoCompactThresholdTokens: (tokens: number) => void;
  setUpdateAvailable: (available: boolean, version?: string) => void;
  setUpdateDownloaded: (downloaded: boolean) => void;
  setLastSeenVersion: (version: string) => void;
  setAiAvatarUrl: (url: string) => void;
  setUserAvatarUrl: (url: string) => void;
  setCustomBackgroundImageUrl: (url: string) => void;
  setCustomThemeEnabled: (enabled: boolean) => void;
  updateCustomTheme: (patch: Partial<CustomThemeConfig>) => void;
  updateCustomThemeColors: (patch: Partial<CustomThemeColors>) => void;
  resetCustomTheme: () => void;
  setBackgroundSurfaceOpacity: (value: number) => void;
  setBackgroundEnhanceEnabled: (enabled: boolean) => void;
  setUserDisplayName: (name: string) => void;
  toggleHiddenFiles: () => void;
}

// --- Theme cycle order ---

const themeCycle: Theme[] = ['light', 'dark', 'system'];

function nextTheme(current: Theme): Theme {
  const idx = themeCycle.indexOf(current);
  return themeCycle[(idx + 1) % themeCycle.length];
}

// --- Store ---

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      colorTheme: 'black',
      backgroundTheme: 'garden',
      sidebarOpen: true,
      secondaryPanelOpen: false,
      secondaryPanelTab: 'files',
      secondaryPanelWidth: 300,
      settingsOpen: false,
      agentPanelOpen: false,
      workingDirectory: '',
      workspaces: [],
      selectedModel: 'claude-sonnet-4-6',
      sessionMode: 'bypass',
      locale: 'zh',
      fontSize: 18,
      fontFamily: 'microsoft',
      monoFontFollowsInterface: true,
      sidebarWidth: 280,
      setupCompleted: false,
      thinkingLevel: 'low' as ThinkingLevel,
      contextWindowMode: 'default',
      autoCompactThresholdTokens: 160_000,
      updateAvailable: false,
      updateVersion: '',
      cliUpdateAvailable: false,
      cliLatestVersion: '',
      updateDownloaded: false,
      lastSeenVersion: '',
      aiAvatarUrl: '',
      userAvatarUrl: '',
      customBackgroundImageUrl: '',
      customThemeEnabled: false,
      customTheme: DEFAULT_CUSTOM_THEME,
      backgroundSurfaceOpacity: 82,
      backgroundEnhanceEnabled: false,
      userDisplayName: '',
      showHiddenFiles: false,

      toggleTheme: () =>
        set((state) => ({ theme: nextTheme(state.theme) })),

      setTheme: (theme) => set(() => ({ theme })),

      setColorTheme: (colorTheme) => set(() => ({ colorTheme })),

      setBackgroundTheme: (backgroundTheme) => set(() => ({ backgroundTheme })),

      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      toggleSecondaryPanel: () =>
        set((state) => ({
          secondaryPanelOpen: !state.secondaryPanelOpen,
        })),

      toggleSecondaryTab: (tab) =>
        set((state) => ({
          secondaryPanelTab: tab,
          secondaryPanelOpen: !(state.secondaryPanelOpen && state.secondaryPanelTab === tab),
        })),

      toggleAgentPanel: () =>
        set((state) => ({ agentPanelOpen: !state.agentPanelOpen })),

      setSecondaryTab: (tab) =>
        set(() => ({
          secondaryPanelTab: tab,
          secondaryPanelOpen: true,
        })),

      setSecondaryPanelWidth: (width) =>
        set(() => ({ secondaryPanelWidth: width })),

      toggleSettings: () =>
        set((state) => ({
          settingsOpen: !state.settingsOpen,
          // Clear update badge when opening settings
          ...(!state.settingsOpen && state.updateAvailable ? { updateAvailable: false } : {}),
        })),

      setWorkingDirectory: (dir) =>
        set((state) => {
          const normalized = normalizeWorkspacePath(dir);
          if (!normalized) {
            return { workingDirectory: '' };
          }
          return {
            workingDirectory: normalized,
            workspaces: upsertWorkspaceEntry(state.workspaces, normalized),
          };
        }),

      addWorkspace: (dir) =>
        set((state) => {
          const normalized = normalizeWorkspacePath(dir);
          if (!normalized) return {};
          return { workspaces: upsertWorkspaceEntry(state.workspaces, normalized) };
        }),

      addWorkspaces: (dirs) =>
        set((state) => {
          let workspaces = state.workspaces;
          for (let index = dirs.length - 1; index >= 0; index -= 1) {
            workspaces = upsertWorkspaceEntry(workspaces, dirs[index]);
          }
          return { workspaces };
        }),

      removeWorkspace: (dir) =>
        set((state) => {
          const normalized = normalizeWorkspacePath(dir);
          if (!normalized) return {};
          const workspaces = removeWorkspaceEntry(state.workspaces, normalized);
          const workingDirectory = normalizeWorkspacePath(state.workingDirectory) === normalized
            ? (workspaces[0]?.path || '')
            : state.workingDirectory;
          return { workspaces, workingDirectory };
        }),

      setSelectedModel: (model) =>
        set(() => ({ selectedModel: model })),

      setSessionMode: (mode) =>
        set(() => ({ sessionMode: mode })),

      setLocale: (locale) =>
        set(() => ({ locale })),

      toggleLocale: () =>
        set((state) => ({ locale: state.locale === 'zh' ? 'en' : 'zh' })),

      setFontSize: (size) =>
        set(() => ({ fontSize: Math.max(10, Math.min(36, size)) })),

      setFontFamily: (fontFamily) =>
        set(() => ({ fontFamily })),

      setMonoFontFollowsInterface: (monoFontFollowsInterface) =>
        set(() => ({ monoFontFollowsInterface })),

      increaseFontSize: () =>
        set((state) => ({ fontSize: Math.min(36, state.fontSize + 1) })),

      decreaseFontSize: () =>
        set((state) => ({ fontSize: Math.max(10, state.fontSize - 1) })),

      setSidebarWidth: (width) =>
        set(() => ({ sidebarWidth: Math.max(220, Math.min(450, width)) })),

      setSetupCompleted: (completed) =>
        set(() => ({ setupCompleted: completed })),

      setThinkingLevel: (level) =>
        set(() => ({ thinkingLevel: level })),

      setContextWindowMode: (contextWindowMode) =>
        set((state) => {
          const oldDefault = defaultAutoCompactThreshold(state.contextWindowMode);
          const nextDefault = defaultAutoCompactThreshold(contextWindowMode);
          return {
            contextWindowMode,
            ...(state.autoCompactThresholdTokens === oldDefault
              ? { autoCompactThresholdTokens: nextDefault }
              : {}),
          };
        }),

      setAutoCompactThresholdTokens: (autoCompactThresholdTokens) =>
        set(() => ({ autoCompactThresholdTokens: clampAutoCompactThreshold(autoCompactThresholdTokens) })),

      setUpdateAvailable: (available, version) =>
        set(() => ({
          updateAvailable: available,
          ...(version !== undefined ? { updateVersion: version } : {}),
          ...(!available ? { updateVersion: '', updateDownloaded: false } : {}),
        })),

      setUpdateDownloaded: (downloaded) =>
        set(() => ({ updateDownloaded: downloaded })),

      setLastSeenVersion: (version) =>
        set(() => ({ lastSeenVersion: version })),

      setAiAvatarUrl: (url) =>
        set(() => ({ aiAvatarUrl: url })),

      setUserAvatarUrl: (url) =>
        set(() => ({ userAvatarUrl: url })),

      setCustomBackgroundImageUrl: (url) =>
        set(() => ({ customBackgroundImageUrl: url })),

      setCustomThemeEnabled: (customThemeEnabled) =>
        set(() => ({ customThemeEnabled })),

      updateCustomTheme: (patch) =>
        set((state) => ({
          customTheme: sanitizeCustomTheme({
            ...state.customTheme,
            ...patch,
            colors: {
              ...state.customTheme.colors,
              ...patch.colors,
            },
          }),
        })),

      updateCustomThemeColors: (patch) =>
        set((state) => ({
          customTheme: sanitizeCustomTheme({
            ...state.customTheme,
            colors: {
              ...state.customTheme.colors,
              ...patch,
            },
          }),
        })),

      resetCustomTheme: () =>
        set(() => ({ customTheme: DEFAULT_CUSTOM_THEME })),

      setBackgroundSurfaceOpacity: (backgroundSurfaceOpacity) =>
        set(() => ({ backgroundSurfaceOpacity: clampBackgroundSurfaceOpacity(backgroundSurfaceOpacity) })),

      setBackgroundEnhanceEnabled: (backgroundEnhanceEnabled) =>
        set(() => ({ backgroundEnhanceEnabled })),

      setUserDisplayName: (name) =>
        set(() => ({ userDisplayName: name.slice(0, 20) })),
      toggleHiddenFiles: () =>
        set((state) => ({ showHiddenFiles: !state.showHiddenFiles })),
    }),
    {
      name: 'tokenicode-settings',
      version: 17,
      migrate: (persistedState: unknown, version: number) => {
        const persisted = persistedState as Record<string, unknown>;
        if (version === 0) {
          // Migrate legacy model IDs to current ones
          const legacyMap: Record<string, ModelId> = {
            'claude-opus-4-0': 'claude-opus-4-6',
            'claude-sonnet-4-0': 'claude-sonnet-4-6',
            'claude-haiku-3-5': 'claude-haiku-4-5-20251001',
          };
          const old = persisted.selectedModel as string;
          if (old && legacyMap[old]) {
            persisted.selectedModel = legacyMap[old];
          }
        }
        if (version < 2) {
          persisted.updateAvailable = false;
          persisted.updateVersion = '';
          persisted.lastSeenVersion = '';
        }
        if (version < 3) {
          persisted.apiProviderMode = 'inherit';
          persisted.customProviderName = '';
          persisted.customProviderBaseUrl = '';
          persisted.customProviderModelMappings = [];
          persisted.customProviderApiFormat = 'anthropic';
        }
        if (version < 4) {
          // Migrate boolean thinkingEnabled → ThinkingLevel
          const oldThinking = persisted.thinkingEnabled;
          persisted.thinkingLevel = oldThinking === false ? 'off' : 'high';
          delete persisted.thinkingEnabled;
        }
        if (version < 5) {
          // Force default mode to bypass — old versions may have persisted 'code'/'ask'
          persisted.sessionMode = 'bypass';
        }
        if (version < 6) {
          // Fix Haiku model ID: claude-haiku-4-5 → claude-haiku-4-5-20251001
          if (persisted.selectedModel === 'claude-haiku-4-5') {
            persisted.selectedModel = 'claude-haiku-4-5-20251001';
          }
        }
        if (version < 7) {
          const migratedModel = migrateModelSelection(persisted.selectedModel);
          if (migratedModel) {
            persisted.selectedModel = migratedModel;
          }
        }
        if (version < 8) {
          persisted.backgroundTheme = 'garden';
        }
        if (version < 9) {
          persisted.monoFontFollowsInterface = true;
        }
        if (version < 10) {
          persisted.contextWindowMode = 'default';
        }
        if (version < 11) {
          const mode = persisted.contextWindowMode === 'large1m' ? 'large1m' : 'default';
          persisted.autoCompactThresholdTokens = defaultAutoCompactThreshold(mode);
        }
        if (version < 12) {
          if (persisted.thinkingLevel === undefined || persisted.thinkingLevel === 'medium') {
            persisted.thinkingLevel = 'low';
          }
        }
        if (version < 13) {
          persisted.customBackgroundImageUrl = '';
        }
        if (version < 14) {
          persisted.backgroundSurfaceOpacity = 82;
        }
        if (version < 15) {
          const rawWorkspaces = Array.isArray(persisted.workspaces)
            ? persisted.workspaces as Array<{ path?: unknown; lastUsed?: unknown }>
            : [];
          let workspaces: WorkspaceEntry[] = [];
          for (const item of rawWorkspaces) {
            if (typeof item?.path !== 'string') continue;
            const lastUsed = typeof item.lastUsed === 'number' ? item.lastUsed : Date.now();
            workspaces = upsertWorkspaceEntry(workspaces, item.path, lastUsed);
          }
          if (typeof persisted.workingDirectory === 'string' && persisted.workingDirectory.trim()) {
            workspaces = upsertWorkspaceEntry(workspaces, persisted.workingDirectory);
            persisted.workingDirectory = normalizeWorkspacePath(persisted.workingDirectory);
          }
          persisted.workspaces = workspaces;
        }
        if (version < 16) {
          persisted.backgroundEnhanceEnabled = false;
        }
        if (version < 17) {
          persisted.customThemeEnabled = false;
          persisted.customTheme = sanitizeCustomTheme(persisted.customTheme);
        }
        return persisted;
      },
      partialize: (state) => ({
        theme: state.theme,
        colorTheme: state.colorTheme,
        backgroundTheme: state.backgroundTheme,
        sidebarOpen: state.sidebarOpen,
        secondaryPanelWidth: state.secondaryPanelWidth,
        workingDirectory: state.workingDirectory,
        workspaces: state.workspaces,
        selectedModel: state.selectedModel,
        sessionMode: state.sessionMode,
        locale: state.locale,
        fontSize: state.fontSize,
        fontFamily: state.fontFamily,
        monoFontFollowsInterface: state.monoFontFollowsInterface,
        sidebarWidth: state.sidebarWidth,
        setupCompleted: state.setupCompleted,
        thinkingLevel: state.thinkingLevel,
        contextWindowMode: state.contextWindowMode,
        autoCompactThresholdTokens: state.autoCompactThresholdTokens,
        updateAvailable: state.updateAvailable,
        updateVersion: state.updateVersion,
        lastSeenVersion: state.lastSeenVersion,
        aiAvatarUrl: state.aiAvatarUrl,
        userAvatarUrl: state.userAvatarUrl,
        customBackgroundImageUrl: state.customBackgroundImageUrl,
        customThemeEnabled: state.customThemeEnabled,
        customTheme: state.customTheme,
        backgroundSurfaceOpacity: state.backgroundSurfaceOpacity,
        backgroundEnhanceEnabled: state.backgroundEnhanceEnabled,
        userDisplayName: state.userDisplayName,
        showHiddenFiles: state.showHiddenFiles,
      }),
    },
  ),
);

// --- Per-session effective value helpers (Phase 4) ---
// These read the snapshotted value from SessionMeta, falling back to the global store.
// Import SessionMeta lazily to avoid circular dependency.

/** Get the effective session mode for a given session's meta snapshot */
export function getEffectiveMode(meta: { snapshotMode?: SessionMode } | undefined): SessionMode {
  return meta?.snapshotMode ?? useSettingsStore.getState().sessionMode;
}

/** Get the effective model for a given session's meta snapshot */
export function getEffectiveModel(meta: { snapshotModel?: string } | undefined): string {
  return meta?.snapshotModel ?? useSettingsStore.getState().selectedModel;
}

/** Get the effective thinking level for a given session's meta snapshot */
export function getEffectiveThinking(meta: { snapshotThinking?: ThinkingLevel } | undefined): ThinkingLevel {
  return meta?.snapshotThinking ?? useSettingsStore.getState().thinkingLevel;
}

export function isLargeContextMode(model?: string, mode?: ContextWindowMode): boolean {
  if (mode === 'large1m') return true;
  const lower = (model || '').toLowerCase();
  return lower.includes('1m') || lower.includes('[1m]');
}

export function getContextWindowForModel(model?: string, mode?: ContextWindowMode): number {
  return isLargeContextMode(model, mode) ? 1_000_000 : 200_000;
}

export function getAutoCompactThreshold(model?: string, mode?: ContextWindowMode, overrideTokens?: number): number {
  if (typeof overrideTokens === 'number') {
    return clampAutoCompactThreshold(overrideTokens);
  }
  return getContextWindowForModel(model, mode) >= 1_000_000 ? 800_000 : 160_000;
}

// --- Runtime mode switching via SDK control protocol ---
// When sessionMode changes and there's an active CLI session, send set_permission_mode.

let _skipNextModeSync = false;

/** Update frontend sessionMode WITHOUT sending set_permission_mode to CLI.
 *  Use when CLI already switched modes internally (e.g. after ExitPlanMode allow). */
export function setSessionModeLocal(mode: SessionMode): void {
  _skipNextModeSync = true;
  useSettingsStore.getState().setSessionMode(mode);
}

useSettingsStore.subscribe((state, prevState) => {
  if (state.sessionMode === prevState.sessionMode) return;

  if (_skipNextModeSync) {
    _skipNextModeSync = false;
    return;
  }

  const cliMode = mapSessionModeToPermissionMode(state.sessionMode);

  // bypass uses --dangerously-skip-permissions at startup; can't switch TO bypass at runtime
  if (cliMode === 'bypassPermissions') return;

  // Dynamically import to avoid circular deps
  Promise.all([
    import('../lib/tauri-bridge'),
    import('./chatStore'),
  ]).then(([{ bridge }, { getActiveTabState }]) => {
    const stdinId = getActiveTabState().sessionMeta.stdinId;
    if (!stdinId) return; // No active session

    bridge.setPermissionMode(stdinId, cliMode).catch((err: unknown) => {
      console.error('[TOKENICODE] Failed to set permission mode:', err);
    });
  });
});
