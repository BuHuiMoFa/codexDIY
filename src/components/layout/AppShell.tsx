import { useCallback, useRef, useEffect, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFileStore } from '../../stores/fileStore';
import { FilePreview } from '../files/FilePreview';
import { bridge } from '../../lib/tauri-bridge';
import { fileUrlToPath } from '../../lib/preview-target';

interface AppShellProps {
  sidebar: React.ReactNode;
  main: React.ReactNode;
  secondary?: React.ReactNode;
}

const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 600;
const COLLAPSE_THRESHOLD = 120;

/* Sidebar width constants */
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 450;
const SIDEBAR_COLLAPSE_THRESHOLD = 100;

/* Preview panel width constants */
const MIN_PREVIEW_WIDTH = 300;
const MAX_PREVIEW_WIDTH = 1200;
const MIN_MAIN_WIDTH = 720;
const PANEL_GAP = 18;
const TITLEBAR_HEIGHT = 38;
const DRAG_REGION_STYLE = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG_REGION_STYLE = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export function AppShell({ sidebar, main, secondary }: AppShellProps) {
  const sidebarOpen = useSettingsStore((s) => s.sidebarOpen);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const setSidebarWidth = useSettingsStore((s) => s.setSidebarWidth);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const secondaryPanelOpen = useSettingsStore((s) => s.secondaryPanelOpen);
  const secondaryPanelTab = useSettingsStore((s) => s.secondaryPanelTab);
  const secondaryPanelWidth = useSettingsStore((s) => s.secondaryPanelWidth);
  const toggleSecondaryPanel = useSettingsStore((s) => s.toggleSecondaryPanel);
  const customBackgroundImageUrl = useSettingsStore((s) => s.customBackgroundImageUrl);
  const backgroundSurfaceOpacity = useSettingsStore((s) => s.backgroundSurfaceOpacity);
  const backgroundEnhanceEnabled = useSettingsStore((s) => s.backgroundEnhanceEnabled);
  const theme = useSettingsStore((s) => s.theme);
  const setCustomBackgroundImageUrl = useSettingsStore((s) => s.setCustomBackgroundImageUrl);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [isMaximized, setIsMaximized] = useState(false);

  /* File preview state — when a file is selected, we enter "preview mode" */
  const selectedFile = useFileStore((s) => s.selectedFile);
  const isFilePreviewMode = !!selectedFile;

  // --- Right-side panel dragging (secondary + preview) ---
  const isRightDragging = useRef(false);
  const rightStartX = useRef(0);
  const rightStartWidth = useRef(0);

  /* Preview panel resizable width — default to 50% of window */
  const [previewWidth, setPreviewWidth] = useState(() =>
    Math.round(window.innerWidth * 0.5)
  );

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (sidebarWidth < MIN_SIDEBAR_WIDTH) {
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    }
  }, [setSidebarWidth, sidebarWidth]);

  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;

    const syncMaximized = async () => {
      try {
        const next = await win.isMaximized();
        if (!disposed) setIsMaximized(next);
      } catch {
        // Ignore window API failures in non-desktop contexts.
      }
    };

    syncMaximized();
    let unlisten: (() => void) | null = null;
    win.onResized(() => {
      syncMaximized();
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!customBackgroundImageUrl || customBackgroundImageUrl.startsWith('data:')) return;
    const path = customBackgroundImageUrl.startsWith('file://')
      ? fileUrlToPath(customBackgroundImageUrl)
      : customBackgroundImageUrl;
    if (!path) return;
    let alive = true;
    bridge.readFileBase64(path)
      .then((dataUrl) => {
        if (alive) setCustomBackgroundImageUrl(dataUrl);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [customBackgroundImageUrl, setCustomBackgroundImageUrl]);

  /* Remember panel states before entering preview mode so we can restore them on exit */
  const panelStateBeforePreview = useRef<{ sidebar: boolean; secondary: boolean } | null>(null);

  /* Re-calculate default when entering preview mode */
  const prevPreviewMode = useRef(false);
  useEffect(() => {
    if (isFilePreviewMode && !prevPreviewMode.current) {
      // Entering preview mode — save current panel state and collapse them
      setPreviewWidth(Math.round(window.innerWidth * 0.5));
      panelStateBeforePreview.current = {
        sidebar: sidebarOpen,
        secondary: secondaryPanelOpen,
      };
      if (sidebarOpen) toggleSidebar();
      if (secondaryPanelOpen) toggleSecondaryPanel();
    } else if (!isFilePreviewMode && prevPreviewMode.current) {
      // Exiting preview mode — restore panels to their previous state
      const saved = panelStateBeforePreview.current;
      if (saved) {
        if (saved.sidebar && !sidebarOpen) toggleSidebar();
        if (saved.secondary && !secondaryPanelOpen) toggleSecondaryPanel();
        panelStateBeforePreview.current = null;
      }
    }
    prevPreviewMode.current = isFilePreviewMode;
  }, [isFilePreviewMode, sidebarOpen, toggleSidebar, secondaryPanelOpen, toggleSecondaryPanel]);

  useEffect(() => {
    if (!isFilePreviewMode) return;
    if (!secondaryPanelOpen) return;
    if (secondaryPanelTab !== 'preview') return;
    useFileStore.getState().closePreview();
  }, [isFilePreviewMode, secondaryPanelOpen, secondaryPanelTab]);

  // Refs to avoid re-registering global listeners when these values change
  const isFilePreviewModeRef = useRef(isFilePreviewMode);
  isFilePreviewModeRef.current = isFilePreviewMode;
  const secondaryPanelWidthRef = useRef(secondaryPanelWidth);
  secondaryPanelWidthRef.current = secondaryPanelWidth;
  const previewWidthRef = useRef(previewWidth);
  previewWidthRef.current = previewWidth;

  const handleRightMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isRightDragging.current = true;
    rightStartX.current = e.clientX;
    rightStartWidth.current = isFilePreviewModeRef.current
      ? previewWidthRef.current
      : secondaryPanelWidthRef.current;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isRightDragging.current) return;
      const delta = rightStartX.current - e.clientX;
      const newWidth = rightStartWidth.current + delta;

      if (isFilePreviewModeRef.current) {
        if (newWidth < COLLAPSE_THRESHOLD) {
          isRightDragging.current = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          useFileStore.getState().closePreview();
          return;
        }
        setPreviewWidth(
          Math.max(MIN_PREVIEW_WIDTH, Math.min(MAX_PREVIEW_WIDTH, newWidth))
        );
      } else {
        if (newWidth < COLLAPSE_THRESHOLD) {
          isRightDragging.current = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          const settings = useSettingsStore.getState();
          if (settings.secondaryPanelOpen) settings.toggleSecondaryPanel();
          return;
        }
        useSettingsStore.getState().setSecondaryPanelWidth(
          Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, newWidth))
        );
      }
    };

    const handleMouseUp = () => {
      if (!isRightDragging.current) return;
      isRightDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      // Safety: reset body styles if component unmounts mid-drag
      if (isRightDragging.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);

  // --- Sidebar dragging ---
  const isSidebarDragging = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartW = useRef(0);

  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isSidebarDragging.current = true;
    sidebarStartX.current = e.clientX;
    sidebarStartW.current = sidebarWidthRef.current;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!isSidebarDragging.current) return;
      // Dragging right increases sidebar width
      const delta = e.clientX - sidebarStartX.current;
      const newW = sidebarStartW.current + delta;
      if (newW < SIDEBAR_COLLAPSE_THRESHOLD) {
        isSidebarDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        const settings = useSettingsStore.getState();
        if (settings.sidebarOpen) settings.toggleSidebar();
        return;
      }
      useSettingsStore.getState().setSidebarWidth(
        Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, newW))
      );
    };
    const handleUp = () => {
      if (!isSidebarDragging.current) return;
      isSidebarDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      if (isSidebarDragging.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);

  /* Compute sidebar visibility: hidden when file preview is active (reclaim space) */
  const showSidebar = sidebarOpen && !isFilePreviewMode;
  const effectiveSidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, sidebarWidth);
  /* Secondary panel: dock when there is room, otherwise show as a floating drawer */
  const showSecondary = secondaryPanelOpen && !isFilePreviewMode;
  const canDockSidebar = windowWidth >= effectiveSidebarWidth + MIN_MAIN_WIDTH + PANEL_GAP;
  const responsiveShowSidebar = showSidebar && canDockSidebar;
  const showFloatingSidebar = sidebarOpen && (!canDockSidebar || isFilePreviewMode);
  const responsiveShowSecondary = showSecondary && windowWidth >= (
    (responsiveShowSidebar ? effectiveSidebarWidth : 0) + secondaryPanelWidth + MIN_MAIN_WIDTH + PANEL_GAP
  );
  const showFloatingSecondary = secondaryPanelOpen && !responsiveShowSecondary;
  const isTightOverlayLayout = windowWidth < 1180;
  const floatingSidebarWidth = Math.min(
    effectiveSidebarWidth,
    Math.max(196, Math.min(252, Math.round(windowWidth * 0.28))),
  );
  const floatingSecondaryWidth = Math.min(
    secondaryPanelWidth,
    Math.max(280, Math.min(380, Math.round(windowWidth * 0.34))),
  );
  const renderFloatingSidebar = showFloatingSidebar && !(showFloatingSecondary && isTightOverlayLayout);
  const hasCustomBackground = customBackgroundImageUrl.trim().length > 0;
  const backgroundEnhanceActive = hasCustomBackground && backgroundEnhanceEnabled;
  const sidebarSurfaceClass = hasCustomBackground ? 'bg-transparent tokenicode-glass-surface' : 'bg-bg-sidebar';
  const chatSurfaceClass = hasCustomBackground ? 'bg-transparent tokenicode-glass-surface' : 'bg-bg-chat';
  const clampedSurfaceOpacity = Math.max(0, Math.min(100, backgroundSurfaceOpacity));
  const surfaceOpacityRatio = clampedSurfaceOpacity / 100;
  const baseGlassBlur = backgroundEnhanceActive
    ? (clampedSurfaceOpacity <= 0 ? 8 : 8 + surfaceOpacityRatio * 10)
    : (clampedSurfaceOpacity <= 0 ? 0 : 3 + surfaceOpacityRatio * 6);
  const modalBackdropOpacity = backgroundEnhanceActive
    ? (clampedSurfaceOpacity <= 0 ? 0.08 : 0.08 + surfaceOpacityRatio * 0.08)
    : (clampedSurfaceOpacity <= 0 ? 0.02 : 0.03 + surfaceOpacityRatio * 0.05);
  const modalBackdropBlur = backgroundEnhanceActive
    ? (clampedSurfaceOpacity <= 0 ? 6 : 6 + surfaceOpacityRatio * 8)
    : (clampedSurfaceOpacity <= 0 ? 0 : 2 + surfaceOpacityRatio * 4);
  const modalSurfaceOpacity = backgroundEnhanceActive
    ? (clampedSurfaceOpacity <= 0 ? 0.18 : Math.min(0.42, 0.18 + surfaceOpacityRatio * 0.22))
    : (clampedSurfaceOpacity <= 0 ? 0.1 : Math.min(0.28, 0.1 + surfaceOpacityRatio * 0.14));
  const modalSurfaceBlur = backgroundEnhanceActive
    ? (clampedSurfaceOpacity <= 0 ? 10 : 10 + surfaceOpacityRatio * 10)
    : (clampedSurfaceOpacity <= 0 ? 4 : 4 + surfaceOpacityRatio * 5);
  const enhancedSidebarOpacity = clampedSurfaceOpacity <= 0 ? 0 : Math.min(94, clampedSurfaceOpacity + 8);
  const enhancedChatOpacity = clampedSurfaceOpacity <= 0 ? 0 : Math.min(95, clampedSurfaceOpacity + 10);
  const enhancedTitlebarOpacity = clampedSurfaceOpacity <= 0 ? 0 : Math.min(92, clampedSurfaceOpacity + 6);
  const customSidebarSurfaceStyle = hasCustomBackground
    ? {
        backgroundColor: `color-mix(in srgb, var(--color-bg-sidebar) ${backgroundEnhanceActive ? enhancedSidebarOpacity : clampedSurfaceOpacity}%, transparent)`,
      }
    : undefined;
  const customChatSurfaceStyle = hasCustomBackground
    ? {
        backgroundColor: `color-mix(in srgb, var(--color-bg-chat) ${backgroundEnhanceActive ? enhancedChatOpacity : clampedSurfaceOpacity}%, transparent)`,
      }
    : undefined;
  const customTitlebarStyle = hasCustomBackground
    ? {
        backgroundColor: `color-mix(in srgb, var(--color-bg-chat) ${backgroundEnhanceActive ? enhancedTitlebarOpacity : clampedSurfaceOpacity}%, transparent)`,
      }
    : undefined;
  const customBackdropTintStyle = hasCustomBackground
    ? {
        background: backgroundEnhanceActive
          ? (clampedSurfaceOpacity <= 0
            ? 'transparent'
            : theme === 'dark'
            ? `linear-gradient(180deg, rgba(3, 7, 18, ${0.08 + surfaceOpacityRatio * 0.10}), rgba(3, 7, 18, ${0.03 + surfaceOpacityRatio * 0.05})), radial-gradient(circle at 20% 18%, rgba(15, 23, 42, 0.18), transparent 34%), radial-gradient(circle at 82% 14%, rgba(15, 23, 42, 0.12), transparent 32%)`
            : `linear-gradient(180deg, rgba(255, 255, 255, ${0.16 + surfaceOpacityRatio * 0.08}), rgba(255, 255, 255, ${0.08 + surfaceOpacityRatio * 0.04})), radial-gradient(circle at 16% 16%, rgba(255, 255, 255, 0.18), transparent 34%), radial-gradient(circle at 84% 14%, rgba(255, 255, 255, 0.12), transparent 32%)`)
          : (theme === 'dark'
            ? `rgba(0, 0, 0, ${surfaceOpacityRatio * 0.09})`
            : `rgba(255, 255, 255, ${surfaceOpacityRatio * 0.05})`),
      }
    : undefined;
  const customBackgroundRootStyle = hasCustomBackground ? {
    '--tokenicode-surface-text-shadow': backgroundEnhanceActive
      ? (theme === 'dark'
        ? '0 1px 2px rgba(0, 0, 0, 0.34), 0 0 16px rgba(0, 0, 0, 0.22), 0 0 28px rgba(0, 0, 0, 0.14)'
        : '0 1px 2px rgba(255, 255, 255, 0.56), 0 0 16px rgba(255, 255, 255, 0.34), 0 0 24px rgba(255, 255, 255, 0.20)')
      : (theme === 'dark'
        ? `0 1px 2px rgba(0, 0, 0, ${0.22 + surfaceOpacityRatio * 0.14}), 0 0 12px rgba(0, 0, 0, ${0.08 + surfaceOpacityRatio * 0.08})`
        : `0 1px 2px rgba(255, 255, 255, ${0.28 + surfaceOpacityRatio * 0.18}), 0 0 10px rgba(255, 255, 255, ${0.10 + surfaceOpacityRatio * 0.10})`),
    '--tokenicode-surface-icon-shadow': backgroundEnhanceActive
      ? (theme === 'dark'
        ? 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.34)) drop-shadow(0 0 10px rgba(0, 0, 0, 0.18))'
        : 'drop-shadow(0 1px 2px rgba(255, 255, 255, 0.34)) drop-shadow(0 0 10px rgba(255, 255, 255, 0.16))')
      : (theme === 'dark'
        ? `drop-shadow(0 1px 2px rgba(0, 0, 0, ${0.22 + surfaceOpacityRatio * 0.14}))`
        : `drop-shadow(0 1px 2px rgba(255, 255, 255, ${0.18 + surfaceOpacityRatio * 0.12}))`),
    '--tokenicode-surface-border': backgroundEnhanceActive
      ? (theme === 'dark' ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.46)')
      : 'transparent',
    '--tokenicode-surface-highlight': backgroundEnhanceActive
      ? (theme === 'dark' ? 'rgba(255, 255, 255, 0.03)' : 'rgba(255, 255, 255, 0.12)')
      : 'transparent',
    '--tokenicode-glass-blur': `${baseGlassBlur.toFixed(1)}px`,
    '--tokenicode-glass-saturate': backgroundEnhanceActive ? '1.08' : '1.02',
    '--tokenicode-modal-backdrop': theme === 'dark'
      ? `rgba(0, 0, 0, ${modalBackdropOpacity.toFixed(3)})`
      : `rgba(255, 255, 255, ${(modalBackdropOpacity * 0.78).toFixed(3)})`,
    '--tokenicode-modal-backdrop-blur': `${modalBackdropBlur.toFixed(1)}px`,
    '--tokenicode-modal-surface-bg': theme === 'dark'
      ? `rgba(17, 24, 39, ${modalSurfaceOpacity.toFixed(3)})`
      : `rgba(255, 252, 247, ${(0.16 + modalSurfaceOpacity * 0.8).toFixed(3)})`,
    '--tokenicode-modal-surface-blur': `${modalSurfaceBlur.toFixed(1)}px`,
    '--tokenicode-modal-surface-saturate': backgroundEnhanceActive ? '1.06' : '1.02',
    '--tokenicode-modal-border': theme === 'dark'
      ? `rgba(255, 255, 255, ${(0.08 + surfaceOpacityRatio * 0.08).toFixed(3)})`
      : `rgba(255, 255, 255, ${(0.26 + surfaceOpacityRatio * 0.14).toFixed(3)})`,
  } as CSSProperties : undefined;
  const stopWindowControlMouseDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
  }, []);
  const stopWindowControlPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
  }, []);
  const handleMinimize = useCallback(() => {
    bridge.minimizeWindow().catch(() => {
      getCurrentWindow().minimize().catch(() => {});
    });
  }, []);
  const handleAppClose = useCallback(async () => {
    try {
      const { exit } = await import('@tauri-apps/plugin-process');
      await exit(0);
    } catch {
      getCurrentWindow().destroy().catch(() => {});
    }
  }, []);

  return (
    <div
      className={`relative isolate flex h-full w-full flex-col overflow-hidden gradient-bg ${hasCustomBackground ? 'has-custom-background' : ''} ${backgroundEnhanceActive ? 'has-background-enhance' : ''}`}
      style={hasCustomBackground ? {
        backgroundImage: `url("${customBackgroundImageUrl}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        ...(customBackgroundRootStyle ?? {}),
      } : undefined}
    >
      {hasCustomBackground && (
        <div className="pointer-events-none absolute inset-0 z-0" style={customBackdropTintStyle} />
      )}
      <div
        className={`relative z-20 flex items-center border-b border-border-subtle/80 px-3 ${
          hasCustomBackground ? 'bg-transparent tokenicode-glass-surface tokenicode-glass-titlebar' : 'bg-bg-chat/95'
        }`}
        style={{ height: `${TITLEBAR_HEIGHT}px`, ...(customTitlebarStyle ?? {}) }}
      >
        <div
          data-tauri-drag-region
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-2 pr-28"
          style={DRAG_REGION_STYLE}
        >
          <img src="/app-icon.png" alt="" className="h-4 w-4 rounded-sm flex-shrink-0" />
          <span className="truncate text-[12px] font-semibold tracking-[0.18em] text-text-primary">
            TOKENICODE
          </span>
        </div>
        <div
          className="absolute right-3 top-1/2 z-50 flex -translate-y-1/2 items-center gap-1 pointer-events-auto"
          data-tauri-drag-region="false"
          style={NO_DRAG_REGION_STYLE}
        >
          <button
            type="button"
            data-tauri-drag-region="false"
            onMouseDown={stopWindowControlMouseDown}
            onPointerDown={stopWindowControlPointerDown}
            onClick={handleMinimize}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-smooth hover:bg-bg-tertiary hover:text-text-primary"
            title="最小化"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M2 6h8" />
            </svg>
          </button>
          <button
            type="button"
            data-tauri-drag-region="false"
            onMouseDown={stopWindowControlMouseDown}
            onPointerDown={stopWindowControlPointerDown}
            onClick={() => {
              getCurrentWindow().toggleMaximize()
                .then(() => getCurrentWindow().isMaximized())
                .then((next) => setIsMaximized(next))
                .catch(() => {});
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-smooth hover:bg-bg-tertiary hover:text-text-primary"
            title={isMaximized ? '还原' : '放大'}
          >
            {isMaximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="2.5" y="4" width="5.5" height="5.5" />
                <path d="M4 4V2.5h5.5V8H8" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="2.5" y="2.5" width="7" height="7" />
              </svg>
            )}
          </button>
          <button
            type="button"
            data-tauri-drag-region="false"
            onMouseDown={stopWindowControlMouseDown}
            onPointerDown={stopWindowControlPointerDown}
            onClick={() => {
              handleAppClose().catch(() => {});
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-smooth hover:bg-[#e15f5f] hover:text-white"
            title="关闭"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3 3l6 6M9 3L3 9" />
            </svg>
          </button>
        </div>
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 w-full overflow-hidden">
        {/* Sidebar — animates to w-0 when hidden or preview mode */}
        <div
          className="flex-shrink-0 transition-all duration-300 ease-out overflow-hidden"
          style={{ width: responsiveShowSidebar ? `${effectiveSidebarWidth}px` : '0px' }}
        >
          <div
            className={`h-full overflow-y-auto overflow-x-hidden ${sidebarSurfaceClass}`}
            style={{ width: `${effectiveSidebarWidth}px`, ...(customSidebarSurfaceStyle ?? {}) }}
          >
            {sidebar}
          </div>
        </div>
        {/* Sidebar resize handle — outside overflow-hidden so hit area isn't clipped */}
        {responsiveShowSidebar && (
          <div
            onMouseDown={handleSidebarMouseDown}
            className="w-[9px] -ml-px -mr-px h-full flex-shrink-0 relative cursor-col-resize z-10
              flex items-center justify-center group"
          >
            <div className="w-px h-full bg-border-subtle group-hover:bg-accent/40 transition-colors" />
          </div>
        )}

        {/* Main Panel — full-height, separated by vertical border lines */}
        <div
          className={`flex-1 min-w-0 flex flex-col overflow-hidden ${chatSurfaceClass}`}
          style={customChatSurfaceStyle}
        >
          {main}
        </div>

        {/* File Preview resize handle — outside overflow-hidden */}
        {isFilePreviewMode && (
          <div
            onMouseDown={handleRightMouseDown}
            className="w-[9px] -ml-px -mr-px h-full flex-shrink-0 relative cursor-col-resize z-10
              flex items-center justify-center group"
          >
            <div className="w-px h-full bg-border-subtle group-hover:bg-accent/40 transition-colors" />
          </div>
        )}
        {/* File Preview Panel — animates in/out */}
        <div
          className="flex-shrink-0 overflow-hidden transition-all duration-300 ease-out"
          style={{ width: isFilePreviewMode ? `${previewWidth}px` : '0px' }}
        >
          <div className={`h-full overflow-hidden flex flex-col ${chatSurfaceClass}`}
            style={{ width: `${previewWidth}px`, ...(customChatSurfaceStyle ?? {}) }}>
            <FilePreview />
          </div>
        </div>

        {/* Secondary Panel resize handle — outside overflow-hidden */}
        {secondary && responsiveShowSecondary && (
          <div
            onMouseDown={handleRightMouseDown}
            className="w-[9px] -ml-px -mr-px h-full flex-shrink-0 relative cursor-col-resize z-10
              flex items-center justify-center group"
          >
            <div className="w-px h-full bg-border-subtle group-hover:bg-accent/40 transition-colors" />
          </div>
        )}
        {/* Secondary Panel — animates to w-0 when hidden or preview mode */}
        {secondary && (
          <div
            className="flex-shrink-0 transition-all duration-300 ease-out overflow-hidden"
            style={{ width: responsiveShowSecondary ? `${secondaryPanelWidth}px` : '0px' }}
          >
            <div
              className={`h-full overflow-y-auto overflow-x-hidden ${sidebarSurfaceClass}`}
              style={{ width: `${secondaryPanelWidth}px`, ...(customSidebarSurfaceStyle ?? {}) }}
            >
              {secondary}
            </div>
          </div>
        )}
      </div>

      {/* Floating Sidebar — overlay when file preview is active */}
      {renderFloatingSidebar && (
        <>
          <div
            className="absolute inset-0 z-40"
            style={hasCustomBackground ? {
              backgroundColor: theme === 'dark'
                ? `rgba(0, 0, 0, ${(surfaceOpacityRatio * 0.05).toFixed(3)})`
                : `rgba(255, 255, 255, ${(surfaceOpacityRatio * 0.04).toFixed(3)})`,
            } : undefined}
            onClick={toggleSidebar}
          />
          <div
            className="fixed left-0 bottom-0 z-50 flex animate-in slide-in-from-left duration-200"
            style={{ top: `${TITLEBAR_HEIGHT}px`, width: `${floatingSidebarWidth}px` }}
          >
            <div className={`flex-1 h-full overflow-y-auto ${sidebarSurfaceClass}
              border-r border-border-subtle shadow-lg`}
              style={{ width: `${floatingSidebarWidth}px`, ...(customSidebarSurfaceStyle ?? {}) }}>
              {sidebar}
            </div>
          </div>
        </>
      )}

      {/* Floating Secondary Panel — overlay when file preview is active */}
      {secondary && showFloatingSecondary && (
        <>
          {/* Backdrop — click to dismiss */}
          <div
            className="absolute inset-0 z-40"
            style={hasCustomBackground ? {
              backgroundColor: theme === 'dark'
                ? `rgba(0, 0, 0, ${(surfaceOpacityRatio * 0.05).toFixed(3)})`
                : `rgba(255, 255, 255, ${(surfaceOpacityRatio * 0.04).toFixed(3)})`,
            } : undefined}
            onClick={toggleSecondaryPanel}
          />
          {/* Floating panel — anchored to right edge */}
          <div
            className="absolute right-0 bottom-0 z-50 flex animate-in slide-in-from-right duration-200"
            style={{
              top: `${TITLEBAR_HEIGHT}px`,
              width: `${floatingSecondaryWidth}px`,
              maxWidth: 'calc(100% - 16px)',
            }}
          >
            <div className={`flex-1 h-full overflow-y-auto overflow-x-hidden ${sidebarSurfaceClass}
              border-l border-border-subtle shadow-lg`}
              style={customSidebarSurfaceStyle}>
              {secondary}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
