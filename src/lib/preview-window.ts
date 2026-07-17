import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl } from '@tauri-apps/plugin-opener';

const PREVIEW_WINDOW_LABEL = 'tokenicode-web-preview';

function buildPreviewWindowTitle(url: string): string {
  try {
    const parsed = new URL(url);
    return `TOKENICODE Preview - ${parsed.hostname}`;
  } catch {
    return 'TOKENICODE Preview';
  }
}

export async function openDetachedPreviewWindow(url: string): Promise<void> {
  const existing = await WebviewWindow.getByLabel(PREVIEW_WINDOW_LABEL);
  if (existing) {
    await existing.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  const previewWindow = new WebviewWindow(PREVIEW_WINDOW_LABEL, {
    title: buildPreviewWindowTitle(url),
    url,
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    center: true,
    focus: true,
    resizable: true,
  });

  previewWindow.once('tauri://error', async () => {
    await openUrl(url).catch(() => {});
  });
}
