import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveTab, type ProcessEvent } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFileStore } from '../../stores/fileStore';
import { bridge } from '../../lib/tauri-bridge';
import { parseTurns, shortFilePath, relativeTime } from '../../lib/turns';
import { useT } from '../../lib/i18n';

type ReviewCard = {
  id: string;
  filePath: string;
  kind: 'created' | 'modified' | 'removed';
  beforeContent: string | null;
  afterContent: string | null;
  added: number;
  removed: number;
  updatedAt: number;
  source: 'watcher' | 'tool';
  live: boolean;
};

type ReviewViewMode = 'diff' | 'before' | 'after';
type DiffLayout = 'unified' | 'split';

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function kindClass(kind: ProcessEvent['kind']) {
  if (kind === 'stderr' || kind === 'warning') return 'text-red-400';
  if (kind === 'tool') return 'text-amber-500';
  if (kind === 'result') return 'text-emerald-500';
  return 'text-text-secondary';
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

function reviewKindLabel(kind: ReviewCard['kind']) {
  if (kind === 'created') return '新增';
  if (kind === 'removed') return '删除';
  return '修改';
}

function reviewKindChip(kind: ReviewCard['kind']) {
  if (kind === 'created') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500';
  if (kind === 'removed') return 'border-red-500/20 bg-red-500/10 text-red-500';
  return 'border-amber-500/20 bg-amber-500/10 text-amber-500';
}

function revealFilePath(filePath: string) {
  bridge.revealInFinder(filePath).catch(() => {});
}

function jumpToFilePath(filePath: string) {
  bridge.openInVscode(filePath).catch(() => {
    bridge.openWithDefaultApp(filePath).catch(() => {});
  });
}

function SnapshotPanel({
  title,
  content,
  tone,
  emptyLabel,
}: {
  title: string;
  content: string | null;
  tone: 'before' | 'after';
  emptyLabel: string;
}) {
  const lines = splitLines(content);
  const displayLines = lines.slice(0, 120);
  const hiddenCount = Math.max(0, lines.length - displayLines.length);
  const isBefore = tone === 'before';
  const rowClass = isBefore ? 'bg-red-500/8' : 'bg-emerald-500/8';
  const lineNoClass = isBefore
    ? 'text-red-400/70 border-r border-red-500/15'
    : 'text-emerald-500/70 border-r border-emerald-500/15';
  const markerClass = isBefore ? 'text-red-400' : 'text-emerald-500';
  const textClass = isBefore ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400';

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-bg-card/85">
      <div className="border-b border-border-subtle/50 bg-bg-secondary/55 px-3 py-2 text-[11px] font-medium text-text-primary">
        {title}
      </div>
      {displayLines.length ? (
        <div className="max-h-[360px] overflow-auto">
          {displayLines.map((line, index) => (
            <div key={`${tone}-${index}`} className={`flex items-start gap-0 text-[11px] font-mono leading-relaxed ${rowClass}`}>
              <span className={`w-10 flex-shrink-0 select-none pr-2 text-right ${lineNoClass}`}>
                {index + 1}
              </span>
              <span className={`w-5 flex-shrink-0 select-none text-center ${markerClass}`}>
                {isBefore ? '-' : '+'}
              </span>
              <span className={`flex-1 whitespace-pre-wrap break-all px-1.5 ${textClass}`}>
                {line || '\u00A0'}
              </span>
            </div>
          ))}
          {hiddenCount > 0 && (
            <div className={`border-t px-3 py-2 text-[10px] font-mono ${isBefore ? 'border-red-500/10 bg-red-500/5 text-red-400/80' : 'border-emerald-500/10 bg-emerald-500/5 text-emerald-500/80'}`}>
              ... {isBefore ? '-' : '+'}{hiddenCount} more lines
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-4 text-xs text-text-tertiary">{emptyLabel}</div>
      )}
    </div>
  );
}

function UnifiedDiffPanel({
  beforeContent,
  afterContent,
}: {
  beforeContent: string | null;
  afterContent: string | null;
}) {
  const removedLines = splitLines(beforeContent);
  const addedLines = splitLines(afterContent);
  const displayedRemoved = removedLines.slice(0, 120);
  const displayedAdded = addedLines.slice(0, 120);
  const hiddenRemoved = Math.max(0, removedLines.length - displayedRemoved.length);
  const hiddenAdded = Math.max(0, addedLines.length - displayedAdded.length);

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-bg-card/85">
      <div className="border-b border-border-subtle/50 bg-bg-secondary/55 px-3 py-2 text-[11px] font-medium text-text-primary">
        差异
      </div>
      <div className="max-h-[420px] overflow-auto">
        {displayedRemoved.map((line, index) => (
          <div key={`removed-${index}`} className="flex items-start gap-0 bg-red-500/8 text-[11px] font-mono leading-relaxed">
            <span className="w-10 flex-shrink-0 select-none border-r border-red-500/15 pr-2 text-right text-red-400/70">
              {index + 1}
            </span>
            <span className="w-5 flex-shrink-0 select-none text-center text-red-400">-</span>
            <span className="flex-1 whitespace-pre-wrap break-all px-1.5 text-red-600 dark:text-red-400">
              {line || '\u00A0'}
            </span>
          </div>
        ))}
        {hiddenRemoved > 0 && (
          <div className="border-t border-red-500/10 bg-red-500/5 px-3 py-2 text-[10px] font-mono text-red-400/80">
            ... -{hiddenRemoved} more lines
          </div>
        )}
        {displayedAdded.map((line, index) => (
          <div key={`added-${index}`} className="flex items-start gap-0 bg-emerald-500/8 text-[11px] font-mono leading-relaxed">
            <span className="w-10 flex-shrink-0 select-none border-r border-emerald-500/15 pr-2 text-right text-emerald-500/70">
              {index + 1}
            </span>
            <span className="w-5 flex-shrink-0 select-none text-center text-emerald-500">+</span>
            <span className="flex-1 whitespace-pre-wrap break-all px-1.5 text-emerald-700 dark:text-emerald-400">
              {line || '\u00A0'}
            </span>
          </div>
        ))}
        {hiddenAdded > 0 && (
          <div className="border-t border-emerald-500/10 bg-emerald-500/5 px-3 py-2 text-[10px] font-mono text-emerald-500/80">
            ... +{hiddenAdded} more lines
          </div>
        )}
        {displayedRemoved.length === 0 && displayedAdded.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-tertiary">当前没有可显示的增删内容。</div>
        )}
      </div>
    </div>
  );
}

function SplitDiffPanel({
  beforeContent,
  afterContent,
}: {
  beforeContent: string | null;
  afterContent: string | null;
}) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <SnapshotPanel
        title="删除内容"
        content={beforeContent}
        tone="before"
        emptyLabel="没有删除内容"
      />
      <SnapshotPanel
        title="新增内容"
        content={afterContent}
        tone="after"
        emptyLabel="没有新增内容"
      />
    </div>
  );
}

function ReviewCardItem({
  card,
  onOpenPreview,
}: {
  card: ReviewCard;
  onOpenPreview: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<ReviewViewMode>(card.kind === 'created' ? 'after' : 'diff');
  const [diffLayout, setDiffLayout] = useState<DiffLayout>('unified');
  const [showFileSnapshot, setShowFileSnapshot] = useState(false);
  const [showViewOptions, setShowViewOptions] = useState(false);
  const viewOptionsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showViewOptions) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!viewOptionsRef.current?.contains(event.target as Node)) {
        setShowViewOptions(false);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [showViewOptions]);

  const openPreview = useCallback(() => {
    onOpenPreview(card.filePath);
  }, [card.filePath, onOpenPreview]);

  const renderBody = () => {
    if (viewMode === 'before') {
      return (
        <SnapshotPanel
          title="修改前"
          content={card.beforeContent}
          tone="before"
          emptyLabel="没有修改前内容"
        />
      );
    }
    if (viewMode === 'after') {
      return (
        <SnapshotPanel
          title={card.kind === 'created' ? '文件内容' : '修改后'}
          content={card.afterContent}
          tone="after"
          emptyLabel={card.kind === 'removed' ? '文件已删除' : '没有修改后内容'}
        />
      );
    }
    return diffLayout === 'split'
      ? <SplitDiffPanel beforeContent={card.beforeContent} afterContent={card.afterContent} />
      : <UnifiedDiffPanel beforeContent={card.beforeContent} afterContent={card.afterContent} />;
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-bg-secondary/60">
      <div className="px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${reviewKindChip(card.kind)}`}>
                {reviewKindLabel(card.kind)}
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] font-mono">
                <span className="text-success">+{card.added}</span>
                <span className="text-error">-{card.removed}</span>
              </span>
              <span className="text-[10px] text-text-tertiary">
                {card.source === 'watcher' ? '实时同步' : '工具变更'}
              </span>
              {card.live && (
                <span className="rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                  LIVE
                </span>
              )}
            </div>

            <button
              onClick={openPreview}
              className="mt-2 min-w-0 max-w-full truncate text-left text-xs font-mono text-accent/80 transition-smooth hover:text-accent hover:underline"
              title={card.filePath}
            >
              {shortFilePath(card.filePath)}
            </button>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-tertiary">
              <span>{formatClock(card.updatedAt)}</span>
              <span>·</span>
              <span>{card.live ? '持续跟踪中' : '等待下一次文件变化'}</span>
            </div>
          </div>

          <button
            onClick={() => setExpanded((current) => !current)}
            className="flex-shrink-0 rounded-lg p-1 text-text-tertiary transition-smooth hover:bg-bg-tertiary"
            title={expanded ? '收起审阅' : '展开审阅'}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
            >
              <path d="M3 2l4 3-4 3" />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border-subtle/60 px-3 py-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              onClick={openPreview}
              className="rounded-lg border border-border-subtle bg-bg-card/75 px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-smooth hover:bg-bg-tertiary"
            >
              预览
            </button>
            <button
              onClick={() => revealFilePath(card.filePath)}
              className="rounded-lg border border-border-subtle bg-bg-card/75 px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-smooth hover:bg-bg-tertiary"
            >
              文件夹
            </button>
            <button
              onClick={() => setShowFileSnapshot((current) => !current)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-smooth ${
                showFileSnapshot
                  ? 'border-accent/20 bg-accent/10 text-accent'
                  : 'border-border-subtle bg-bg-card/75 text-text-secondary hover:bg-bg-tertiary'
              }`}
            >
              {showFileSnapshot ? '隐藏文件' : '显示文件'}
            </button>
            <button
              onClick={() => jumpToFilePath(card.filePath)}
              className="rounded-lg border border-border-subtle bg-bg-card/75 px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-smooth hover:bg-bg-tertiary"
            >
              跳转到文件
            </button>
            <button
              onClick={() => {
                setViewMode('diff');
                setDiffLayout((current) => current === 'split' ? 'unified' : 'split');
              }}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-smooth ${
                diffLayout === 'split'
                  ? 'border-accent/20 bg-accent/10 text-accent'
                  : 'border-border-subtle bg-bg-card/75 text-text-secondary hover:bg-bg-tertiary'
              }`}
            >
              {diffLayout === 'split' ? '统一差异' : '拆分差异'}
            </button>
            <div className="relative" ref={viewOptionsRef}>
              <button
                onClick={() => setShowViewOptions((current) => !current)}
                className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-smooth ${
                  showViewOptions
                    ? 'border-accent/20 bg-accent/10 text-accent'
                    : 'border-border-subtle bg-bg-card/75 text-text-secondary hover:bg-bg-tertiary'
                }`}
              >
                查看选项
              </button>
              {showViewOptions && (
                <div className="absolute left-0 top-full z-20 mt-2 min-w-[180px] rounded-xl border border-border-subtle bg-bg-card p-1.5 shadow-lg">
                  <button
                    onClick={() => {
                      setViewMode('diff');
                      setShowViewOptions(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[11px] text-text-primary transition-smooth hover:bg-bg-secondary"
                  >
                    <span>查看差异</span>
                    <span className="font-mono text-text-tertiary">{diffLayout === 'split' ? 'split' : 'unified'}</span>
                  </button>
                  {card.kind !== 'created' && (
                    <button
                      onClick={() => {
                        setViewMode('before');
                        setShowViewOptions(false);
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[11px] text-text-primary transition-smooth hover:bg-bg-secondary"
                    >
                      <span>修改前</span>
                      <span className="font-mono text-red-400">-</span>
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setViewMode('after');
                      setShowViewOptions(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[11px] text-text-primary transition-smooth hover:bg-bg-secondary"
                  >
                    <span>{card.kind === 'created' ? '文件内容' : '修改后'}</span>
                    <span className="font-mono text-emerald-500">+</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {renderBody()}
            {showFileSnapshot && viewMode !== 'after' && (
              <SnapshotPanel
                title="当前文件"
                content={card.afterContent}
                tone="after"
                emptyLabel={card.kind === 'removed' ? '文件已删除' : '当前没有可显示内容'}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function TaskInspectorPanel() {
  const t = useT();
  const messages = useActiveTab((tab) => tab.messages);
  const sessionStatus = useActiveTab((tab) => tab.sessionStatus);
  const activityStatus = useActiveTab((tab) => tab.activityStatus);
  const sessionMeta = useActiveTab((tab) => tab.sessionMeta);
  const liveReviewEntries = useFileStore((state) => state.liveReviewEntries);
  const changedFiles = useFileStore((state) => state.changedFiles);
  const seedLiveReviewEntry = useFileStore((state) => state.seedLiveReviewEntry);

  const turn = useMemo(() => {
    const turns = parseTurns(messages);
    return turns[turns.length - 1];
  }, [messages]);

  const processEvents = (sessionMeta.processEvents ?? []).slice(-12).reverse();
  const currentEvent = processEvents[0];

  const recentEdits = useMemo(() => (
    messages
      .filter((msg) => msg.type === 'tool_use' && (msg.toolName === 'Edit' || msg.toolName === 'Write') && msg.toolInput?.file_path)
      .slice(-8)
      .reverse()
      .map((msg) => {
        const input = msg.toolInput || {};
        const isWrite = msg.toolName === 'Write';
        const beforeContent = isWrite ? null : String(input.old_string || '');
        const afterContent = isWrite ? String(input.content || '') : String(input.new_string || '');
        const diff = computeDiffStats(beforeContent, afterContent);
        return {
          id: msg.id,
          filePath: String(input.file_path || ''),
          kind: (isWrite ? 'created' : 'modified') as ReviewCard['kind'],
          beforeContent,
          afterContent,
          added: diff.added,
          removed: diff.removed,
          updatedAt: msg.timestamp,
          source: 'tool' as const,
        };
      })
  ), [messages]);

  useEffect(() => {
    for (const edit of [...recentEdits].reverse()) {
      seedLiveReviewEntry({
        filePath: edit.filePath,
        kind: edit.kind,
        previousContent: edit.beforeContent,
        currentContent: edit.afterContent,
        source: 'tool',
      });
    }
  }, [recentEdits, seedLiveReviewEntry]);

  const reviewCards = useMemo(() => {
    const cards: ReviewCard[] = Array.from(liveReviewEntries.values()).map((entry) => ({
      id: `live:${entry.filePath}`,
      filePath: entry.filePath,
      kind: entry.kind,
      beforeContent: entry.previousContent,
      afterContent: entry.currentContent,
      added: entry.added,
      removed: entry.removed,
      updatedAt: entry.updatedAt,
      source: entry.source,
      live: true,
    }));

    const seen = new Set(cards.map((card) => card.filePath));
    for (const edit of recentEdits) {
      if (seen.has(edit.filePath)) continue;
      cards.push({
        id: `tool:${edit.id}`,
        filePath: edit.filePath,
        kind: edit.kind,
        beforeContent: edit.beforeContent,
        afterContent: edit.afterContent,
        added: edit.added,
        removed: edit.removed,
        updatedAt: edit.updatedAt,
        source: edit.source,
        live: false,
      });
    }

    return cards.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [liveReviewEntries, recentEdits]);

  const changeList = useMemo(() => {
    const items = new Map<string, {
      key: string;
      filePath: string;
      action: 'created' | 'edited' | 'removed' | 'terminal';
      updatedAt: number;
      isLive: boolean;
    }>();

    for (const card of reviewCards) {
      items.set(card.filePath, {
        key: `review:${card.filePath}`,
        filePath: card.filePath,
        action: card.kind === 'created' ? 'created' : card.kind === 'removed' ? 'removed' : 'edited',
        updatedAt: card.updatedAt,
        isLive: card.live,
      });
    }

    for (const [filePath, kind] of changedFiles) {
      if (items.has(filePath)) continue;
      items.set(filePath, {
        key: `fs:${filePath}`,
        filePath,
        action: kind === 'created' ? 'created' : kind === 'removed' ? 'removed' : 'edited',
        updatedAt: Date.now(),
        isLive: true,
      });
    }

    for (const [index, change] of (turn?.codeChanges ?? []).entries()) {
      if (change.action === 'terminal') {
        items.set(`terminal:${index}`, {
          key: `terminal:${index}`,
          filePath: change.filePath,
          action: 'terminal',
          updatedAt: turn?.timestamp ?? 0,
          isLive: false,
        });
        continue;
      }
      if (items.has(change.filePath)) continue;
      items.set(change.filePath, {
        key: `turn:${change.filePath}`,
        filePath: change.filePath,
        action: change.action === 'created' ? 'created' : 'edited',
        updatedAt: turn?.timestamp ?? 0,
        isLive: false,
      });
    }

    return Array.from(items.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [reviewCards, changedFiles, turn]);

  const changedCount = changeList.filter((change) => change.action !== 'terminal').length;

  const openFilePreview = useCallback((path: string) => {
    useSettingsStore.getState().setSecondaryTab('files');
    void useFileStore.getState().selectFile(path);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-subtle bg-bg-sidebar/90 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.2em] text-text-tertiary">
              Workspace overview
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-text-primary">
              {turn ? `Turn ${turn.index}` : 'Live session'}
            </div>
            <div className="mt-1 line-clamp-2 text-xs text-text-secondary">
              {turn?.userContent || sessionMeta.lastEventLabel || t('sidebar.taskReady')}
            </div>
          </div>
          <span className={`flex-shrink-0 rounded-full border px-2 py-1 text-[11px] font-medium ${
            sessionStatus === 'running'
              ? 'border-success/30 bg-success/10 text-success'
              : sessionStatus === 'error'
                ? 'border-error/30 bg-error/10 text-error'
                : 'border-border-subtle bg-bg-secondary/60 text-text-tertiary'
          }`}>
            {activityStatus.phase}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-border-subtle bg-bg-secondary/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-text-tertiary">Files</div>
            <div className="mt-1 text-sm font-semibold text-text-primary">{changedCount}</div>
          </div>
          <div className="rounded-xl border border-border-subtle bg-bg-secondary/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-text-tertiary">Review</div>
            <div className="mt-1 text-sm font-semibold text-text-primary">{reviewCards.length}</div>
          </div>
          <div className="rounded-xl border border-border-subtle bg-bg-secondary/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-text-tertiary">Last</div>
            <div className="mt-1 truncate text-sm font-semibold text-text-primary">
              {sessionMeta.lastEventAt ? relativeTime(sessionMeta.lastEventAt) : 'Idle'}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <section className="rounded-2xl border border-border-subtle bg-bg-card/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold text-text-primary">变更列表</div>
            <div className="text-[11px] text-text-tertiary">{changeList.length}</div>
          </div>
          {changeList.length ? (
            <div className="mt-3 space-y-2">
              {changeList.map((change) => (
                <button
                  key={change.key}
                  onClick={() => {
                    if (change.action === 'terminal') return;
                    openFilePreview(change.filePath);
                  }}
                  className={`w-full min-w-0 rounded-xl border px-3 py-2 text-left transition-smooth ${
                    change.action === 'terminal'
                      ? 'cursor-default border-border-subtle bg-bg-secondary/60 text-text-tertiary'
                      : 'cursor-pointer border-border-subtle bg-bg-secondary/70 text-text-primary hover:bg-bg-tertiary'
                  }`}
                  title={change.filePath}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex-shrink-0 text-[10px] font-semibold uppercase opacity-80">
                      {change.action === 'created' ? 'NEW' : change.action === 'removed' ? 'DEL' : change.action === 'edited' ? 'EDIT' : 'CMD'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {change.action === 'terminal' ? change.filePath : shortFilePath(change.filePath)}
                    </span>
                    {change.isLive && change.action !== 'terminal' && (
                      <span className="flex-shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                        LIVE
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-3 text-xs text-text-tertiary">{t('sidebar.taskReady')}</div>
          )}
        </section>

        <section className="rounded-2xl border border-border-subtle bg-bg-card/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold text-text-primary">实时审阅</div>
            <div className="text-[11px] text-text-tertiary">{reviewCards.length}</div>
          </div>
          <div className="mt-2 text-[11px] text-text-tertiary">
            预览、文件夹、显示文件、跳转到文件、拆分差异和查看选项都集中放在这里。
          </div>
          {reviewCards.length ? (
            <div className="mt-3 space-y-3">
              {reviewCards.map((card) => (
                <ReviewCardItem
                  key={card.id}
                  card={card}
                  onOpenPreview={openFilePreview}
                />
              ))}
            </div>
          ) : (
            <div className="mt-3 text-xs text-text-tertiary">当前还没有可审阅的文件变更。</div>
          )}
        </section>

        <section className="rounded-2xl border border-border-subtle bg-bg-card/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold text-text-primary">Process trace</div>
            {currentEvent ? (
              <div className="text-[11px] text-text-tertiary">{formatClock(currentEvent.at)}</div>
            ) : null}
          </div>
          {processEvents.length ? (
            <div className="mt-3 space-y-2">
              {processEvents.map((event, index) => (
                <div
                  key={event.id}
                  className={`rounded-xl border px-3 py-2 ${
                    index === 0
                      ? 'border-accent/20 bg-accent/5'
                      : 'border-border-subtle/70 bg-bg-secondary/55'
                  }`}
                >
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-text-tertiary">{formatClock(event.at)}</span>
                    <span className={`font-medium ${kindClass(event.kind)}`}>{event.label}</span>
                  </div>
                  {event.detail ? (
                    <div className="mt-1 break-words text-xs text-text-secondary">{event.detail}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 text-xs text-text-tertiary">{t('sidebar.taskReady')}</div>
          )}
        </section>

        <section className="rounded-2xl border border-border-subtle bg-bg-card/70 p-3">
          <div className="text-xs font-semibold text-text-primary">Latest signal</div>
          <div className="mt-2 break-words text-xs text-text-secondary">
            {sessionMeta.lastEventLabel || sessionMeta.lastStderrLine || t('sidebar.taskReady')}
          </div>
        </section>
      </div>
    </div>
  );
}
