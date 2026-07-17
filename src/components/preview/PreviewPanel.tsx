import { useEffect, useRef, useState } from 'react';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { listen } from '@tauri-apps/api/event';
import { Webview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl as openExternalUrl } from '@tauri-apps/plugin-opener';
import { usePreviewStore, type PreviewCommand, type PreviewSnapshot } from '../../stores/previewStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFileStore } from '../../stores/fileStore';
import { useT } from '../../lib/i18n';
import { fileUrlToPath } from '../../lib/preview-target';
import { openDetachedPreviewWindow } from '../../lib/preview-window';

type EmbedIssue = 'failed' | null;

const INLINE_PREVIEW_WEBVIEW_LABEL = 'tokenicode-inline-preview';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function PreviewPanel() {
  const t = useT();
  const nativePreviewHostRef = useRef<HTMLDivElement | null>(null);
  const nativeWebviewRef = useRef<Webview | null>(null);
  const nativeSessionRef = useRef(0);
  const url = usePreviewStore((s) => s.url);
  const history = usePreviewStore((s) => s.history);
  const historyIndex = usePreviewStore((s) => s.historyIndex);
  const reloadToken = usePreviewStore((s) => s.reloadToken);
  const lastSnapshot = usePreviewStore((s) => s.lastSnapshot);
  const openUrl = usePreviewStore((s) => s.openUrl);
  const refresh = usePreviewStore((s) => s.refresh);
  const back = usePreviewStore((s) => s.back);
  const forward = usePreviewStore((s) => s.forward);
  const setSnapshot = usePreviewStore((s) => s.setSnapshot);
  const resetPreview = usePreviewStore((s) => s.resetPreview);
  const locale = useSettingsStore((s) => s.locale);
  const setSecondaryTab = useSettingsStore((s) => s.setSecondaryTab);
  const changedFiles = useFileStore((s) => s.changedFiles);
  const [draftUrl, setDraftUrl] = useState(url === 'about:blank' ? '' : url);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [embedIssue, setEmbedIssue] = useState<EmbedIssue>(null);

  useEffect(() => {
    setDraftUrl(url === 'about:blank' ? '' : url);
  }, [url]);

  useEffect(() => {
    if (url === 'about:blank') {
      setLoading(false);
      setEmbedIssue(null);
      return;
    }
    setLoading(true);
    setEmbedIssue(null);
  }, [url, reloadToken]);

  useEffect(() => {
    const unlistenPromise = listen<PreviewCommand>('tokenicode-preview-command', (event) => {
      const command = event.payload;
      setSecondaryTab('preview');
      if (command.type === 'open') openUrl(command.url);
      if (command.type === 'refresh') refresh();
      if (command.type === 'back') back();
      if (command.type === 'forward') forward();
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [back, forward, openUrl, refresh, setSecondaryTab]);

  useEffect(() => {
    const previewedPath = fileUrlToPath(url);
    if (!previewedPath) return;
    const changeKind = changedFiles.get(previewedPath);
    if (changeKind !== 'modified' && changeKind !== 'created') return;
    refresh();
    setNotice(t('preview.autoRefresh'));
  }, [changedFiles, refresh, t, url]);

  useEffect(() => {
    let disposed = false;

    const closeNativeWebview = async () => {
      const existing = nativeWebviewRef.current ?? await Webview.getByLabel(INLINE_PREVIEW_WEBVIEW_LABEL);
      nativeWebviewRef.current = null;
      if (!existing) return;
      await existing.close().catch(() => {});
      await wait(80);
    };

    const syncNativePreviewBounds = async () => {
      const host = nativePreviewHostRef.current;
      const webview = nativeWebviewRef.current;
      if (!host || !webview) return;

      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const x = Math.round(rect.left);
      const y = Math.round(rect.top);

      if (rect.width < 2 || rect.height < 2) {
        await webview.hide().catch(() => {});
        return;
      }

      await webview.setPosition(new LogicalPosition(x, y)).catch(() => {});
      await webview.setSize(new LogicalSize(width, height)).catch(() => {});
      await webview.show().catch(() => {});
    };

    if (url === 'about:blank') {
      void closeNativeWebview();
      return () => {
        disposed = true;
      };
    }

    const sessionId = nativeSessionRef.current + 1;
    nativeSessionRef.current = sessionId;

    void (async () => {
      await closeNativeWebview();
      if (disposed || url === 'about:blank') return;

      const host = nativePreviewHostRef.current;
      if (!host) {
        setLoading(false);
        setEmbedIssue('failed');
        setNotice(t('preview.loadFailed'));
        return;
      }

      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width || host.clientWidth || 1));
      const height = Math.max(1, Math.round(rect.height || host.clientHeight || 1));
      const x = Math.round(rect.left);
      const y = Math.round(rect.top);

      try {
        const inlineWebview = new Webview(getCurrentWindow(), INLINE_PREVIEW_WEBVIEW_LABEL, {
          url,
          x,
          y,
          width,
          height,
          focus: false,
          dragDropEnabled: false,
          zoomHotkeysEnabled: true,
        });
        nativeWebviewRef.current = inlineWebview;

        void inlineWebview.once('tauri://created', () => {
          if (disposed || nativeSessionRef.current !== sessionId) {
            void inlineWebview.close().catch(() => {});
            return;
          }
          void inlineWebview.setAutoResize(false).catch(() => {});
          void syncNativePreviewBounds();
          setLoading(false);
          setEmbedIssue(null);
        });

        void inlineWebview.once('tauri://error', () => {
          if (nativeSessionRef.current !== sessionId) return;
          nativeWebviewRef.current = null;
          setLoading(false);
          setEmbedIssue('failed');
          setNotice(t('preview.loadFailed'));
        });
      } catch {
        nativeWebviewRef.current = null;
        setLoading(false);
        setEmbedIssue('failed');
        setNotice(t('preview.loadFailed'));
      }
    })();

    let resizeObserver: ResizeObserver | null = null;
    const sync = () => {
      void syncNativePreviewBounds();
    };

    if (nativePreviewHostRef.current) {
      resizeObserver = new ResizeObserver(sync);
      resizeObserver.observe(nativePreviewHostRef.current);
    }

    const intervalId = window.setInterval(sync, 180);
    const frameId = window.requestAnimationFrame(sync);
    window.addEventListener('resize', sync);

    return () => {
      disposed = true;
      window.removeEventListener('resize', sync);
      window.clearInterval(intervalId);
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      void closeNativeWebview();
    };
  }, [reloadToken, t, url]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1;
  const canOpenExternal = url !== 'about:blank';

  const uiText = locale === 'zh'
    ? {
        title: '网页预览',
        subtitle: '在面板里打开网页、地址或本地预览目标',
        detached: '窗口',
        failedTitle: '这个网页暂时无法显示',
        failedBody: '当前面板里的内置浏览器创建失败了。你可以重试，也可以先恢复为空白页，再重新打开别的地址。',
        detachedOpen: '独立窗口打开',
        browserOpen: '浏览器打开',
        retry: '重新加载',
        resetBlank: '恢复空白页',
        blankTitle: '空白预览页',
        blankBody: '输入网址、本地地址或 localhost 后，就会在这里显示内容。',
        blankAction: '已恢复为空白页',
        loading: '正在加载网页...',
        statusBlank: '空白页',
        statusLoading: '加载中',
        statusFailed: '失败',
        statusReady: '可预览',
        currentAddress: '当前地址',
        quickHint: '现在这里使用的是应用内置浏览器，像百度这类禁止 iframe 的网页也可以直接显示。',
        nativeSnapshotNote: '内置浏览器预览暂不直接提取正文，已记录地址和视口信息。',
      }
    : {
        title: 'Web Preview',
        subtitle: 'Open pages, addresses, or local preview targets inside the side panel',
        detached: 'Window',
        failedTitle: 'This page could not be displayed',
        failedBody: 'The built-in browser view could not be created. Retry it, or reset to a blank page before opening another address.',
        detachedOpen: 'Open in window',
        browserOpen: 'Open in browser',
        retry: 'Reload',
        resetBlank: 'Reset to blank',
        blankTitle: 'Blank preview page',
        blankBody: 'Enter a URL, localhost address, or local preview target and it will appear here.',
        blankAction: 'Reset back to blank',
        loading: 'Loading preview...',
        statusBlank: 'Blank',
        statusLoading: 'Loading',
        statusFailed: 'Failed',
        statusReady: 'Ready',
        currentAddress: 'Current address',
        quickHint: 'This panel now uses the app built-in browser view, so pages that block iframes can still render here.',
        nativeSnapshotNote: 'Native browser preview currently records the address and viewport only.',
      };

  const captureSnapshot = async () => {
    const host = nativePreviewHostRef.current;
    const snapshot: PreviewSnapshot = {
      url,
      title: '',
      capturedAt: new Date().toISOString(),
      viewport: {
        width: host?.clientWidth || 0,
        height: host?.clientHeight || 0,
      },
      note: uiText.nativeSnapshotNote,
    };
    setSnapshot(snapshot);
    setNotice(uiText.nativeSnapshotNote);
  };

  const resetToBlank = () => {
    resetPreview();
    setDraftUrl('');
    setLoading(false);
    setEmbedIssue(null);
    setNotice(uiText.blankAction);
  };

  const submitUrl = () => {
    if (!draftUrl.trim()) {
      resetToBlank();
      return;
    }
    openUrl(draftUrl);
  };

  const openDetached = async () => {
    if (!canOpenExternal) return;
    await openDetachedPreviewWindow(url);
  };

  const openInBrowser = () => {
    if (!canOpenExternal) return;
    void openExternalUrl(url);
  };

  const statusLabel = url === 'about:blank'
    ? uiText.statusBlank
    : loading
      ? uiText.statusLoading
      : embedIssue === 'failed'
        ? uiText.statusFailed
        : uiText.statusReady;

  const statusClass = url === 'about:blank'
    ? 'border-border-subtle bg-bg-secondary/60 text-text-tertiary'
    : loading
      ? 'border-accent/25 bg-accent/10 text-accent'
      : embedIssue
        ? 'border-warning/25 bg-warning/10 text-warning'
        : 'border-success/25 bg-success/10 text-success';

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <div className="border-b border-border-subtle bg-bg-sidebar/85 px-4 py-4 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.2em] text-text-tertiary">
              Preview
            </div>
            <div className="mt-1 text-sm font-semibold text-text-primary">
              {uiText.title}
            </div>
            <div className="mt-1 text-[11px] text-text-tertiary">
              {uiText.subtitle}
            </div>
          </div>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${statusClass}`}>
            {statusLabel}
          </span>
        </div>

        <div className="mt-4 rounded-2xl border border-border-subtle bg-bg-card/80 p-3 shadow-sm">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-xl border border-border-subtle bg-bg-secondary/60 px-1 py-1">
              <button
                onClick={back}
                disabled={!canGoBack}
                className="preview-icon-btn"
                title={t('preview.back')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 3L5 8l5 5" />
                </svg>
              </button>
              <button
                onClick={forward}
                disabled={!canGoForward}
                className="preview-icon-btn"
                title={t('preview.forward')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3l5 5-5 5" />
                </svg>
              </button>
              <button
                onClick={refresh}
                disabled={!canOpenExternal}
                className="preview-icon-btn"
                title={t('preview.refresh')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 8a5 5 0 11-1.46-3.54" />
                  <path d="M13 3v4H9" />
                </svg>
              </button>
            </div>

            <form
              className="min-w-0 flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                submitUrl();
              }}
            >
              <input
                value={draftUrl}
                onChange={(event) => setDraftUrl(event.target.value)}
                placeholder={t('preview.urlPlaceholder')}
                className="h-10 w-full rounded-xl border border-border-subtle bg-bg-secondary/55 px-3 text-[12px] text-text-primary placeholder:text-text-tertiary outline-none transition-smooth focus:border-accent/60"
              />
            </form>

            <button
              onClick={submitUrl}
              className="preview-icon-btn rounded-xl border border-border-subtle bg-bg-secondary/60"
              title={t('preview.open')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12L12 4" />
                <path d="M6 4h6v6" />
              </svg>
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
                {uiText.currentAddress}
              </div>
              <div className="mt-1 truncate text-[12px] text-text-secondary">
                {loading ? uiText.loading : (url === 'about:blank' ? 'about:blank' : url)}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={resetToBlank}
                className="preview-action-btn rounded-xl border border-border-subtle bg-bg-secondary/60"
                title={uiText.resetBlank}
              >
                {uiText.resetBlank}
              </button>
              <button
                onClick={() => void openDetached()}
                disabled={!canOpenExternal}
                className="preview-action-btn rounded-xl border border-border-subtle bg-bg-secondary/60 disabled:opacity-40"
                title={uiText.detachedOpen}
              >
                {uiText.detached}
              </button>
              <button
                onClick={captureSnapshot}
                disabled={!canOpenExternal}
                className="preview-action-btn rounded-xl border border-border-subtle bg-bg-secondary/60 disabled:opacity-40"
                title={t('preview.snapshot')}
              >
                {t('preview.snapshotShort')}
              </button>
              <button
                onClick={openInBrowser}
                disabled={!canOpenExternal}
                className="preview-icon-btn rounded-xl border border-border-subtle bg-bg-secondary/60 disabled:opacity-40"
                title={t('preview.external')}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 4H4a2 2 0 00-2 2v6a2 2 0 002 2h6a2 2 0 002-2v-2" />
                  <path d="M10 2h4v4" />
                  <path d="M8 8l6-6" />
                </svg>
              </button>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-dashed border-border-subtle bg-bg-secondary/35 px-3 py-2 text-[11px] text-text-tertiary">
            {uiText.quickHint}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-4">
        <div className="relative h-full overflow-hidden rounded-3xl border border-border-subtle bg-white shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          {url === 'about:blank' ? (
            <div className="flex h-full items-center justify-center bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.96))] px-6">
              <div className="w-full max-w-md rounded-3xl border border-border-subtle bg-bg-primary/92 p-6 text-center shadow-sm">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-border-subtle bg-bg-secondary/65 text-text-primary">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="14" rx="3" />
                    <path d="M8 20h8" />
                  </svg>
                </div>
                <div className="mt-4 text-base font-semibold text-text-primary">
                  {uiText.blankTitle}
                </div>
                <div className="mt-2 text-sm leading-6 text-text-secondary">
                  {uiText.blankBody}
                </div>
                <div className="mt-5 flex justify-center">
                  <button
                    onClick={() => setDraftUrl('https://')}
                    className="rounded-xl border border-border-subtle bg-bg-secondary/70 px-4 py-2 text-sm font-medium text-text-primary transition-smooth hover:bg-bg-tertiary"
                  >
                    {t('preview.open')}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div
              ref={nativePreviewHostRef}
              className="h-full w-full bg-white"
            />
          )}

          {loading && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
              <div className="h-0.5 bg-accent animate-pulse" />
              <div className="mx-4 mt-4 inline-flex rounded-2xl border border-border-subtle bg-bg-primary/95 px-4 py-2 text-sm text-text-secondary shadow-sm">
                {uiText.loading}
              </div>
            </div>
          )}

          {embedIssue && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/95 p-6">
              <div className="w-full max-w-lg rounded-3xl border border-border-subtle bg-bg-primary p-6 shadow-lg">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl border border-warning/20 bg-warning/10 text-warning">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-semibold text-text-primary">
                      {uiText.failedTitle}
                    </div>
                    <div className="mt-2 text-sm leading-6 text-text-secondary">
                      {uiText.failedBody}
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <button
                    onClick={resetToBlank}
                    className="h-10 rounded-xl bg-accent px-4 text-sm font-medium text-white"
                  >
                    {uiText.resetBlank}
                  </button>
                  <button
                    onClick={() => void openDetached()}
                    className="h-10 rounded-xl border border-border-subtle px-4 text-sm text-text-primary"
                  >
                    {uiText.detachedOpen}
                  </button>
                  <button
                    onClick={openInBrowser}
                    className="h-10 rounded-xl border border-border-subtle px-4 text-sm text-text-primary"
                  >
                    {uiText.browserOpen}
                  </button>
                  <button
                    onClick={() => {
                      setEmbedIssue(null);
                      refresh();
                    }}
                    className="h-10 rounded-xl border border-border-subtle px-4 text-sm text-text-primary"
                  >
                    {uiText.retry}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {(notice || lastSnapshot) && (
        <div className="border-t border-border-subtle bg-bg-primary px-4 py-3 text-[11px] text-text-muted">
          <div className="truncate">{notice || lastSnapshot?.note || t('preview.snapshotReady')}</div>
        </div>
      )}
    </div>
  );
}
