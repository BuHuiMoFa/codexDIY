import { useRef, useEffect, useState, useMemo, useCallback, type ReactNode } from 'react';
import { create } from 'zustand';
import { useChatStore, useActiveTab, generateMessageId, type ChatMessage, type ProcessEvent, type SessionMeta } from '../../stores/chatStore';
import { MessageBubble } from './MessageBubble';
import { ToolGroup } from './ToolGroup';
import { InputBar } from './InputBar';
import { ExportMenu } from '../conversations/ExportMenu';
import { UpdateButton } from '../shared/UpdateButton';
import {
  useSettingsStore,
  MODEL_OPTIONS,
  mapSessionModeToPermissionMode,
  getContextWindowForModel,
  getAutoCompactThreshold,
} from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useFileStore, type FileChangeKind } from '../../stores/fileStore';
import { useAgentStore } from '../../stores/agentStore';
import { AgentPanel } from '../agents/AgentPanel';
import { bridge, onClaudeStream, onClaudeStderr } from '../../lib/tauri-bridge';
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../../lib/i18n';
import { envFingerprint, resolveModelForProvider, resolveThinkingLevelForProvider } from '../../lib/api-provider';
import { useProviderStore } from '../../stores/providerStore';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { SetupWizard } from '../setup/SetupWizard';
import { AiAvatar } from '../shared/AiAvatar';
import { displayDeepSeekModelName } from '../../lib/deepseek-models';
import { parseTurns, shortFilePath, relativeTime, type Turn } from '../../lib/turns';
import { GitActionMenu } from './GitActionMenu';
import { useRewind } from '../../hooks/useRewind';

const COMPACT_MESSAGE_TYPES = ['tool_use', 'tool_result', 'thinking', 'todo', 'plan', 'plan_review'] as const;

type CompactMessageType = (typeof COMPACT_MESSAGE_TYPES)[number];
type BaseDisplayItem =
  | { kind: 'message'; msg: ChatMessage; idx: number }
  | { kind: 'tool_group'; msgs: ChatMessage[]; startIdx: number };
type DisplayItem =
  | BaseDisplayItem
  | { kind: 'process_chunk'; items: BaseDisplayItem[]; startIdx: number };

function isCompactMessageType(type: ChatMessage['type']): type is CompactMessageType {
  return COMPACT_MESSAGE_TYPES.includes(type as CompactMessageType);
}

function isCompactDisplayItem(item: BaseDisplayItem | DisplayItem | null | undefined): boolean {
  if (!item) return false;
  if (item.kind === 'tool_group' || item.kind === 'process_chunk') return true;
  return isCompactMessageType(item.msg.type);
}

function getDisplayItemStartIdx(item: BaseDisplayItem): number {
  return item.kind === 'tool_group' ? item.startIdx : item.idx;
}

function buildProcessChunkSummary(items: BaseDisplayItem[]) {
  const counts = {
    thinking: 0,
    tool: 0,
    result: 0,
    todo: 0,
    plan: 0,
  };

  for (const item of items) {
    if (item.kind === 'tool_group') {
      counts.tool += item.msgs.length;
      continue;
    }

    switch (item.msg.type) {
      case 'thinking':
        counts.thinking += 1;
        break;
      case 'tool_use':
        counts.tool += 1;
        break;
      case 'tool_result':
        counts.result += 1;
        break;
      case 'todo':
        counts.todo += 1;
        break;
      case 'plan':
      case 'plan_review':
        counts.plan += 1;
        break;
      default:
        break;
    }
  }

  const parts = [
    counts.thinking > 0 ? `思考 ${counts.thinking}` : null,
    counts.tool > 0 ? `工具 ${counts.tool}` : null,
    counts.result > 0 ? `结果 ${counts.result}` : null,
    counts.todo > 0 ? `任务 ${counts.todo}` : null,
    counts.plan > 0 ? `计划 ${counts.plan}` : null,
  ].filter(Boolean);

  return parts.join(' · ');
}

function ProcessChunkGroup({ items, renderItem }: {
  items: BaseDisplayItem[];
  renderItem: (item: BaseDisplayItem, index: number) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => buildProcessChunkSummary(items), [items]);

  return (
    <div className="ml-11">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1.5 py-1 text-left group cursor-pointer"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M3 2l4 3-4 3" />
        </svg>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          className="text-text-tertiary flex-shrink-0"
        >
          <path d="M2.5 3.5h7M2.5 6h7M2.5 8.5h7" />
        </svg>
        <span className="text-xs font-medium text-text-muted">
          {`${items.length} 条处理过程`}
        </span>
        {summary && (
          <span className="text-[11px] text-text-tertiary truncate max-w-[320px]">
            ({summary})
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-l-2 border-border-subtle ml-[5px] pl-2 space-y-0.5">
          {items.map((item, index) => (
            <div key={`process_chunk_item_${getDisplayItemStartIdx(item)}_${index}`}>
              {renderItem(item, index)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shared plan panel toggle — used by ChatPanel (panel) and InputBar (button) */
export const usePlanPanelStore = create<{
  open: boolean;
  toggle: () => void;
  close: () => void;
}>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

/** Resizable right-side plan panel */
function PlanPanel({ planMessages, onClose }: {
  planMessages: ChatMessage[];
  onClose: () => void;
}) {
  const t = useT();
  const [width, setWidth] = useState(420);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const widthRef = useRef(width);
  widthRef.current = width;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = widthRef.current;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      // Dragging left edge → moving left = wider
      const delta = startX.current - ev.clientX;
      const newWidth = Math.max(280, Math.min(800, startW.current + delta));
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  return (
    <div
      className="absolute right-3 top-3 bottom-3 z-20
        bg-bg-card/80 backdrop-blur-xl border border-white/10 rounded-2xl
        shadow-2xl shadow-black/20
        flex flex-col overflow-hidden"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize
          hover:bg-accent/20 active:bg-accent/30 transition-colors z-10"
        onMouseDown={handleMouseDown}
      />
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5
        border-b border-border-subtle bg-accent/5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="text-accent">
            <path d="M2 3.5h10M2 7h8M2 10.5h5" />
          </svg>
          <span className="text-xs font-semibold text-text-primary">
            {t('msg.planTitle')}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-bg-tertiary text-text-tertiary
            transition-smooth cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {planMessages.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-4">
            {t('msg.noPlan')}
          </p>
        ) : (
          planMessages.map((planMsg) => (
            <div key={planMsg.id} className="text-sm leading-relaxed">
              <MarkdownRenderer content={planMsg.planContent || planMsg.content || ''} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Map raw model ID to friendly display name */
function getModelDisplayName(modelId: string): string {
  const option = MODEL_OPTIONS.find((m) => modelId.includes(m.id));
  return option?.short || displayDeepSeekModelName(modelId);
}


/** Format token count: "3.2k" for >=1000, raw number for <1000 */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format elapsed seconds into "Xm Ys" or "Xs" */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

type LiveFileProgressItem = {
  id: string;
  filePath: string;
  displayName: string;
  displayPath: string;
  kind: FileChangeKind;
  added: number;
  removed: number;
  updatedAt: number;
  source: 'live' | 'watcher' | 'turn';
};

function getFileDisplayParts(filePath: string, workingDirectory?: string | null) {
  const displayPath = workingDirectory && filePath.startsWith(workingDirectory)
    ? filePath.slice(workingDirectory.length).replace(/^[/\\]/, '')
    : filePath;
  const displayName = filePath.split(/[\\/]/).pop() || displayPath;
  return { displayName, displayPath };
}

function liveFileActionLabel(kind: FileChangeKind, isRunning: boolean) {
  if (kind === 'removed') return '\u5df2\u5220\u9664';
  if (kind === 'created') return isRunning ? '\u6b63\u5728\u521b\u5efa' : '\u5df2\u521b\u5efa';
  return isRunning ? '\u6b63\u5728\u7f16\u8f91' : '\u5df2\u7f16\u8f91';
}

function liveFileActionTone(kind: FileChangeKind) {
  if (kind === 'removed') {
    return {
      text: 'text-red-500',
      dot: 'bg-red-400',
      stats: 'text-red-400',
    };
  }
  if (kind === 'created') {
    return {
      text: 'text-accent',
      dot: 'bg-accent',
      stats: 'text-accent',
    };
  }
  return {
    text: 'text-amber-500',
    dot: 'bg-amber-400',
    stats: 'text-amber-500',
  };
}

type ActivityVisualTone = 'violet' | 'emerald' | 'amber' | 'blue' | 'slate';
type ActivityVisualIcon = 'spark' | 'pencil' | 'terminal' | 'search' | 'agents' | 'clock';

function getToolActivityVisual(
  phase: string,
  toolName: string | undefined,
  t: (key: string) => string,
): { label: string; icon: ActivityVisualIcon; tone: ActivityVisualTone } {
  const normalized = String(toolName || '').trim();

  if (phase === 'thinking') {
    return { label: t('chat.thinking'), icon: 'spark', tone: 'violet' };
  }
  if (phase === 'writing') {
    return { label: t('chat.toolStatus.writingReply'), icon: 'spark', tone: 'emerald' };
  }
  if (phase === 'awaiting') {
    return { label: t('chat.awaiting'), icon: 'clock', tone: 'slate' };
  }
  if (phase === 'tool') {
    if (['Edit', 'MultiEdit', 'Write'].includes(normalized)) {
      return { label: t('chat.toolStatus.editFile'), icon: 'pencil', tone: 'amber' };
    }
    if (['Bash', 'BatchTool'].includes(normalized)) {
      return { label: t('chat.toolStatus.runCommand'), icon: 'terminal', tone: 'blue' };
    }
    if (['Read', 'LS', 'Glob', 'Grep', 'Find', 'Search', 'Open'].includes(normalized)) {
      return { label: t('chat.toolStatus.inspectProject'), icon: 'search', tone: 'blue' };
    }
    if (['Task', 'Agent', 'TaskCreate', 'SendMessage'].includes(normalized)) {
      return { label: t('chat.toolStatus.runSubtask'), icon: 'agents', tone: 'violet' };
    }
    return {
      label: normalized ? `${t('chat.runningTool')}: ${normalized}` : t('chat.running'),
      icon: 'spark',
      tone: 'blue',
    };
  }
  return { label: t('chat.running'), icon: 'spark', tone: 'slate' };
}

function activityToneClasses(tone: ActivityVisualTone) {
  if (tone === 'violet') {
    return 'border-violet-400/25 bg-violet-500/10 text-violet-300';
  }
  if (tone === 'emerald') {
    return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300';
  }
  if (tone === 'amber') {
    return 'border-amber-400/25 bg-amber-500/10 text-amber-300';
  }
  if (tone === 'blue') {
    return 'border-sky-400/25 bg-sky-500/10 text-sky-300';
  }
  return 'border-border-subtle bg-bg-secondary/80 text-text-secondary';
}

function ActivityVisualIconGlyph({ icon }: { icon: ActivityVisualIcon }) {
  if (icon === 'pencil') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 11.75V13h1.25L11.5 5.75 10.25 4.5 3 11.75z" />
        <path d="M9.75 5 11 3.75a.884.884 0 0 1 1.25 1.25L11 6.25" />
      </svg>
    );
  }
  if (icon === 'terminal') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.75 3.5h10.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
        <path d="M4.5 6.25 6.75 8 4.5 9.75M8 10h3.5" />
      </svg>
    );
  }
  if (icon === 'search') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7" cy="7" r="3.75" />
        <path d="M10 10 13 13" />
      </svg>
    );
  }
  if (icon === 'agents') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5.25 8.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM10.75 7.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5z" />
        <path d="M2.75 12.5a2.75 2.75 0 0 1 5.5 0M8.5 12.5c.13-1.25 1.07-2.25 2.5-2.25 1.45 0 2.37 1 2.5 2.25" />
      </svg>
    );
  }
  if (icon === 'clock') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="5.25" />
        <path d="M8 5v3l2 1.25" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.25 9.4 6.1l4.1.15-3.2 2.55 1.05 4-3.35-2.15-3.35 2.15 1.05-4-3.2-2.55 4.1-.15L8 2.25z" />
    </svg>
  );
}

function LiveFileProgressPanel({
  items,
  isRunning,
  onOpenFile,
  onOpenReview,
}: {
  items: LiveFileProgressItem[];
  isRunning: boolean;
  onOpenFile: (path: string) => void;
  onOpenReview: () => void;
}) {
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (isRunning && items.length > 0) {
      setExpanded(true);
    }
  }, [isRunning, items.length]);

  if (items.length === 0) return null;

  const visibleItems = items.slice(0, 4);
  const activeCount = visibleItems.filter((item) => item.kind !== 'removed' && isRunning).length;

  return (
    <div className="mt-2 ml-5 rounded-xl border border-border-subtle bg-bg-card/55 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 items-center gap-2 text-left transition-smooth hover:text-text-primary"
          title={expanded ? '\u6536\u8d77\u6587\u4ef6\u52a8\u4f5c' : '\u5c55\u5f00\u6587\u4ef6\u52a8\u4f5c'}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`text-text-tertiary transition-transform ${expanded ? 'rotate-180' : ''}`}
          >
            <path d="M2.5 4.5L6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-tertiary">
            <path d="M3 12.5h2.25L12 5.75 10.25 4 3.5 10.75V13.5H6.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="truncate text-[12px] font-medium text-text-primary">
            {activeCount > 0 ? '\u6b63\u5728\u7f16\u8f91\u6587\u4ef6' : '\u6587\u4ef6\u53d8\u66f4'}
          </span>
        </button>
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className="text-[11px] text-text-tertiary">{items.length}</span>
          <button
            type="button"
            onClick={onOpenReview}
            className="rounded-full border border-border-subtle bg-bg-secondary/65 px-2 py-1 text-[10px] text-text-secondary transition-smooth hover:bg-bg-tertiary hover:text-text-primary"
          >
            {'\u5ba1\u9605'}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {visibleItems.map((item) => {
            const tone = liveFileActionTone(item.kind);
            const actionLabel = liveFileActionLabel(item.kind, isRunning);
            return (
              <div key={item.id} className="flex items-center gap-2 text-[12px] leading-relaxed">
                <span className={`flex-shrink-0 ${tone.text}`}>{actionLabel}</span>
                <button
                  type="button"
                  onClick={() => onOpenFile(item.filePath)}
                  className="min-w-0 flex-1 truncate text-left text-text-secondary underline decoration-text-tertiary/35 underline-offset-2 transition-smooth hover:text-text-primary"
                  title={item.filePath}
                >
                  {item.displayName}
                </button>
                <span className={`flex-shrink-0 font-mono text-[11px] ${tone.stats}`}>
                  +{item.added} -{item.removed}
                </span>
                <span className={`h-2 w-2 flex-shrink-0 rounded-full ${tone.dot}`} />
              </div>
            );
          })}
          {items.length > visibleItems.length && (
            <button
              type="button"
              onClick={onOpenReview}
              className="pl-14 text-[11px] text-text-tertiary transition-smooth hover:text-text-primary"
            >
              {'\u8fd8\u6709'} {items.length - visibleItems.length} {'\u9879\uff0c\u53bb\u53f3\u4fa7\u67e5\u770b'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Cycling typewriter text for thinking phase — like Claude Code website "Built for > coders" */
const THINKING_WORD_COUNT = 17;
const TYPING_SPEED = 80;      // ms per character (typing)
const DELETING_SPEED = 40;    // ms per character (deleting)
const PAUSE_DURATION = 2500;  // ms to hold full word
const TRANSITION_DELAY = 300; // ms between delete and next word

/** Fisher-Yates shuffle, always starts with index 0 ("思考中"/"Thinking") */
function shuffledOrder(count: number): number[] {
  const arr = Array.from({ length: count }, (_, i) => i);
  for (let i = arr.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(Math.random() * i); // skip index 0
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function CyclingThinkingText() {
  const t = useT();
  const [order, setOrder] = useState(() => shuffledOrder(THINKING_WORD_COUNT));
  const [cursor, setCursor] = useState(0);
  const [displayText, setDisplayText] = useState('');
  const [phase, setPhase] = useState<'typing' | 'pausing' | 'deleting' | 'waiting'>('typing');

  const wordIndex = order[cursor];
  const fullWord = t(`chat.thinkingCycle.${wordIndex}`);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    if (phase === 'typing') {
      if (displayText.length < fullWord.length) {
        timer = setTimeout(() => {
          setDisplayText(fullWord.slice(0, displayText.length + 1));
        }, TYPING_SPEED);
      } else {
        timer = setTimeout(() => setPhase('pausing'), 0);
      }
    } else if (phase === 'pausing') {
      timer = setTimeout(() => setPhase('deleting'), PAUSE_DURATION);
    } else if (phase === 'deleting') {
      if (displayText.length > 0) {
        timer = setTimeout(() => {
          setDisplayText(displayText.slice(0, -1));
        }, DELETING_SPEED);
      } else {
        const nextCursor = cursor + 1;
        if (nextCursor >= THINKING_WORD_COUNT) {
          // Reshuffle when all words shown
          setOrder(shuffledOrder(THINKING_WORD_COUNT));
          setCursor(0);
        } else {
          setCursor(nextCursor);
        }
        setPhase('waiting');
      }
    } else if (phase === 'waiting') {
      timer = setTimeout(() => {
        setDisplayText('');
        setPhase('typing');
      }, TRANSITION_DELAY);
    }

    return () => clearTimeout(timer);
  }, [displayText, phase, fullWord, cursor]);

  return (
    <span className="inline-flex items-baseline">
      <span>{displayText}</span>
      <span className="text-text-tertiary">...</span>
    </span>
  );
}

/** Activity indicator with elapsed time and token count */
function ActivityIndicator({ activityStatus, sessionMeta, fileProgressItems, onOpenFile, onOpenReview }: {
  activityStatus: { phase: string; toolName?: string };
  sessionMeta: {
    turnStartTime?: number;
    outputTokens?: number;
    inputTokens?: number;
    lastProgressAt?: number;
    lastChangeAt?: number;
    lastEventAt?: number;
    lastEventLabel?: string;
    lastStderrLine?: string;
    processEvents?: ProcessEvent[];
    spawnedModel?: string;
    snapshotModel?: string;
    snapshotContextWindowMode?: import('../../stores/settingsStore').ContextWindowMode;
  };
  fileProgressItems: LiveFileProgressItem[];
  onOpenFile: (path: string) => void;
  onOpenReview: () => void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const visual = getToolActivityVisual(activityStatus.phase, activityStatus.toolName, t);
  const phaseText = activityStatus.phase === 'thinking' ? t('chat.thinking')
    : activityStatus.phase === 'writing' ? t('chat.writing')
    : activityStatus.phase === 'tool' ? `${t('chat.runningTool')}: ${activityStatus.toolName || ''}`
    : activityStatus.phase === 'awaiting' ? t('chat.awaiting')
    : t('chat.running');

  const elapsed = sessionMeta.turnStartTime ? formatElapsed(now - sessionMeta.turnStartTime) : null;
  const tokens = sessionMeta.outputTokens ? formatTokens(sessionMeta.outputTokens) : null;
  const statsText = elapsed
    ? tokens ? `(${elapsed} · ↓ ${tokens})` : `(${elapsed})`
    : null;
  const lastActivityAt = Math.max(sessionMeta.lastProgressAt ?? 0, sessionMeta.lastChangeAt ?? 0) || undefined;
  const sinceProgress = lastActivityAt ? formatElapsed(now - lastActivityAt) : null;

  // Context pressure warning: threshold depends on model context window size
  // 1M models (claude-opus-4-6-1m, mimo-v2-pro[1m]) → warn at 600K; others at 120K (60% of 200K)
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const resolvedModel = sessionMeta.spawnedModel
    || sessionMeta.snapshotModel
    || resolveModelForProvider(selectedModel);
  const contextWindow = getContextWindowForModel(
    resolvedModel,
    sessionMeta.snapshotContextWindowMode ?? contextWindowMode,
  );
  const inputTokens = sessionMeta.inputTokens || 0;
  const contextWarning = inputTokens > contextWindow * 0.6;

  // Stall detection: 120s of silence (no stream activity), not total elapsed time.
  const stallWarning = !!lastActivityAt
    && !!elapsed
    && (now - lastActivityAt) > 120_000;

  const isThinking = activityStatus.phase === 'thinking';
  const processEvents = (sessionMeta.processEvents ?? []).slice(-5).reverse();
  const lastEventAt = sessionMeta.lastEventAt || lastActivityAt;
  const lastEventLabel = sessionMeta.lastEventLabel;
  const showProcessPanel = true;

  const kindClass = (kind: ProcessEvent['kind']) => {
    if (kind === 'stderr' || kind === 'warning') return 'text-red-400';
    if (kind === 'tool') return 'text-amber-500';
    if (kind === 'result') return 'text-emerald-500';
    return 'text-text-secondary';
  };

  return (
    <div className="py-1">
      <div className="rounded-xl border border-border-subtle bg-bg-card/60 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`relative inline-flex items-center gap-2 overflow-hidden rounded-full border px-3 py-1.5 text-[12px] font-medium ${activityToneClasses(visual.tone)}`}>
            <span className="animate-status-sheen pointer-events-none absolute inset-0 opacity-70" />
            <span className="relative flex h-4 w-4 items-center justify-center">
              <ActivityVisualIconGlyph icon={visual.icon} />
            </span>
            <span className="relative">
              {isThinking ? <CyclingThinkingText /> : visual.label}
            </span>
            {(activityStatus.phase === 'tool' || activityStatus.phase === 'writing') && (
              <span className="relative inline-flex items-center gap-1 pl-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-current animate-status-bob" />
                <span className="h-1.5 w-1.5 rounded-full bg-current animate-status-bob" style={{ animationDelay: '0.15s' }} />
                <span className="h-1.5 w-1.5 rounded-full bg-current animate-status-bob" style={{ animationDelay: '0.3s' }} />
              </span>
            )}
          </span>
          <span className="text-sm text-text-muted">
            {!isThinking && phaseText !== visual.label ? <span className="mr-1.5 text-text-tertiary">{phaseText}</span> : null}
            {statsText && (
              <span className={`${stallWarning ? 'text-red-400' : 'text-text-tertiary'}`}>{statsText}</span>
            )}
          </span>
          {stallWarning && (
            <span className="text-xs text-red-400 ml-2 flex items-center gap-1">
              <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
              </svg>
              {t('chat.stallWarning')}
            </span>
          )}
          {contextWarning && !stallWarning && (
            <span className="text-xs text-amber-500 ml-2 flex items-center gap-1"
                  title={t('chat.tokenWarning')}>
              <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
              {t('chat.tokenWarning')}
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-tertiary">
          {lastEventAt && <span>{formatClock(lastEventAt)}</span>}
          {activityStatus.toolName && <span>{`tool: ${activityStatus.toolName}`}</span>}
          {lastEventLabel && <span className="truncate max-w-[420px]">{lastEventLabel}</span>}
          {sinceProgress && <span>{`last progress ${sinceProgress} ago`}</span>}
        </div>
      </div>
      {showProcessPanel && (
        <>
          <LiveFileProgressPanel
            items={fileProgressItems}
            isRunning={activityStatus.phase !== 'completed' && activityStatus.phase !== 'error'}
            onOpenFile={onOpenFile}
            onOpenReview={onOpenReview}
          />
          <div className="mt-2 ml-5 rounded-xl border border-border-subtle bg-bg-card/55 px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-[11px] text-text-tertiary">
              <span>Live trace</span>
              {lastEventAt && <span>{relativeTime(lastEventAt)}</span>}
            </div>
            {processEvents.length > 0 ? (
              <div className="mt-1.5 space-y-1">
                {processEvents.map((event) => (
                  <div key={event.id} className="flex items-start gap-2 text-[11px] leading-relaxed">
                    <span className="w-[58px] flex-shrink-0 text-text-tertiary">{formatClock(event.at)}</span>
                    <span className={`flex-shrink-0 font-medium ${kindClass(event.kind)}`}>{event.label}</span>
                    <span className="text-text-secondary break-words">{event.detail}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-1.5 text-[11px] text-text-tertiary">
                {activityStatus.phase === 'thinking'
                  ? 'Thinking... waiting for first visible progress'
                  : 'Waiting for process events'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ContextMeter({ sessionMeta, tabId, sessionStatus }: {
  sessionMeta: SessionMeta;
  tabId: string | null;
  sessionStatus?: string;
}) {
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const autoCompactThresholdTokens = useSettingsStore((s) => s.autoCompactThresholdTokens);
  const [isCompacting, setIsCompacting] = useState(false);
  const modelForContext = sessionMeta.spawnedModel
    || sessionMeta.snapshotModel
    || sessionMeta.model
    || resolveModelForProvider(selectedModel);
  const effectiveContextMode = sessionMeta.snapshotContextWindowMode ?? contextWindowMode;
  const contextWindow = getContextWindowForModel(modelForContext, effectiveContextMode);
  const compactThreshold = getAutoCompactThreshold(modelForContext, effectiveContextMode, autoCompactThresholdTokens);
  const used = Math.min(contextWindow, Math.max(0,
    (sessionMeta.inputTokens ?? 0) + (sessionMeta.outputTokens ?? 0),
  ));
  const available = Math.max(0, contextWindow - used);
  const percent = Math.min(100, Math.round((used / contextWindow) * 100));
  const thresholdPercent = Math.min(100, Math.round((compactThreshold / contextWindow) * 100));
  const isBusy = sessionStatus === 'running';
  const canCompact = Boolean(tabId && sessionMeta.stdinId && !isBusy && !isCompacting);

  const handleCompact = async () => {
    if (!tabId || !sessionMeta.stdinId || isBusy) return;
    setIsCompacting(true);
    const processingMsgId = generateMessageId();
    const store = useChatStore.getState();
    store.addMessage(tabId, {
      id: processingMsgId,
      role: 'system',
      type: 'text',
      content: '',
      commandType: 'processing',
      commandData: { command: '/compact' },
      commandStartTime: Date.now(),
      commandCompleted: false,
      timestamp: Date.now(),
    });
    store.setSessionMeta(tabId, { pendingCommandMsgId: processingMsgId });
    store.setSessionStatus(tabId, 'running');
    store.setActivityStatus(tabId, { phase: 'thinking' });
    try {
      await bridge.sendStdin(sessionMeta.stdinId, '/compact');
    } catch (e) {
      store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
      store.setSessionStatus(tabId, 'error');
      console.warn('[TOKENICODE] manual compact failed:', e);
    } finally {
      setIsCompacting(false);
    }
  };

  return (
    <div className="hidden md:flex items-center gap-2 ml-2 px-2 py-1 rounded-lg
      bg-bg-secondary/60 border border-border-subtle text-[10px] text-text-tertiary"
      title={`Actual model: ${displayDeepSeekModelName(modelForContext)}; context used ${used.toLocaleString()} / ${contextWindow.toLocaleString()}; available ${available.toLocaleString()}; auto compact at ${compactThreshold.toLocaleString()}`}>
      <span className="font-medium text-text-muted">Ctx</span>
      <div className="w-20 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
        <div
          className={`h-full rounded-full ${percent >= thresholdPercent ? 'bg-warning' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={percent >= thresholdPercent ? 'text-warning' : 'text-text-tertiary'}>
        {percent}%
      </span>
      <span>{formatTokens(available)} free</span>
      <button
        onClick={handleCompact}
        disabled={!canCompact}
        className="px-1.5 py-0.5 rounded bg-bg-tertiary hover:bg-bg-hover
          text-text-muted hover:text-text-primary disabled:opacity-40 disabled:hover:bg-bg-tertiary"
        title={canCompact ? 'Compact context now' : 'Compact is available after a live session is idle'}
      >
        Compact
      </button>
    </div>
  );
}

function ConversationTimeline({ turns, activeTurnId, showScrollBtn, onJumpTurn, onJumpBottom }: {
  turns: Turn[];
  activeTurnId?: string;
  showScrollBtn: boolean;
  onJumpTurn: (turn: Turn) => void;
  onJumpBottom: () => void;
}) {
  const t = useT();
  if (turns.length === 0) return null;

  return (
    <div className="hidden lg:flex absolute right-3 top-24 bottom-28 z-10
      flex-col items-center gap-2 pointer-events-none">
      <div className="flex-1 min-h-0 px-1 py-2 rounded-full
        bg-bg-card/85 backdrop-blur border border-border-subtle shadow-lg
        overflow-y-auto scrollbar-none pointer-events-auto">
        <div className="flex flex-col items-center gap-1.5">
          {turns.map((turn) => {
            const active = activeTurnId === turn.userMessageId;
            return (
              <button
                key={turn.userMessageId}
                onClick={() => onJumpTurn(turn)}
                className={`group relative w-8 h-8 rounded-full text-[10px]
                  flex items-center justify-center border transition-smooth
                  ${active
                    ? 'bg-accent text-text-inverse border-accent shadow-md shadow-black/10'
                    : 'bg-bg-secondary/75 text-text-tertiary border-border-subtle hover:text-text-primary hover:bg-bg-tertiary'
                  }`}
              title={`${t('chat.turn')} ${turn.index}: ${turn.userContent}`}
            >
              {turn.index > 99 ? '99+' : turn.index}
            </button>
            );
          })}
        </div>
      </div>

      <button
        onClick={onJumpBottom}
        className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1.5
          rounded-full border border-border-subtle bg-bg-card/90 backdrop-blur
          shadow-lg text-xs transition-smooth
          ${showScrollBtn
            ? 'text-accent hover:bg-accent/10'
            : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
          }`}
        title={t('chat.scrollToBottom')}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M7 2v10M3 8l4 4 4-4" />
        </svg>
        <span>{t('chat.latest')}</span>
      </button>
    </div>
  );
}

function TurnChangeStrip({ turn }: { turn?: Turn }) {
  const t = useT();
  const toggleSecondaryTab = useSettingsStore((s) => s.toggleSecondaryTab);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const sessionStatus = useActiveTab((tab) => tab.sessionStatus);
  const liveReviewEntries = useFileStore((s) => s.liveReviewEntries);
  const { executeRewind } = useRewind();

  if (!turn || turn.codeChanges.length === 0) return null;

  const fileChanges = turn.codeChanges.filter((change) => change.action !== 'terminal');
  if (fileChanges.length === 0) return null;

  const items = fileChanges.map((change, idx) => {
    const live = liveReviewEntries.get(change.filePath);
    const displayPath = workingDirectory && change.filePath.startsWith(workingDirectory)
      ? change.filePath.slice(workingDirectory.length).replace(/^[/\\]/, '')
      : change.filePath;
    return {
      id: `${change.filePath}-${idx}`,
      filePath: change.filePath,
      displayPath,
      added: live?.added ?? 0,
      removed: live?.removed ?? 0,
      updatedAt: live?.updatedAt ?? turn.timestamp,
      action: change.action,
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);

  const totalAdded = items.reduce((sum, item) => sum + item.added, 0);
  const totalRemoved = items.reduce((sum, item) => sum + item.removed, 0);
  const canUndo = !!turn.checkpointUuid && sessionStatus !== 'running';

  const handleReview = () => {
    toggleSecondaryTab('overview');
  };

  const handleUndo = () => {
    if (!canUndo) return;
    const confirmed = window.confirm(`${t('rewind.restoreCode')} - ${t('rewind.confirm').replace('{n}', String(turn.index))}`);
    if (!confirmed) return;
    void executeRewind(turn, 'restore_code');
  };

  return (
    <div className="mb-4 space-y-2">
      <div className="flex justify-center">
        <button
          onClick={handleReview}
          className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-card/95 px-4 py-2 text-sm text-text-primary shadow-sm transition-smooth hover:bg-bg-tertiary"
          title={'\u6253\u5f00\u53f3\u4fa7\u5ba1\u9605\u9762\u677f'}
        >
          <span className="font-medium">{items.length} {'\u4e2a\u6587\u4ef6\u5df2\u66f4\u6539'}</span>
          <span className="font-mono text-success">+{totalAdded}</span>
          <span className="font-mono text-error">-{totalRemoved}</span>
        </button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-card/92 shadow-sm">
        <div className="px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border-subtle bg-bg-secondary/75 text-text-primary">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
                    <path d="M8 5v6M5 8h6" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text-primary">
                    {'\u5df2\u7f16\u8f91'} {items.length} {'\u4e2a\u6587\u4ef6'}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[12px] font-mono">
                    <span className="text-success">+{totalAdded}</span>
                    <span className="text-error">-{totalRemoved}</span>
                  </div>
                </div>
              </div>
              <div className="mt-2 truncate text-xs text-text-secondary">
                {turn.userContent}
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <button
                onClick={handleUndo}
                disabled={!canUndo}
                className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-smooth hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-45"
                title={canUndo ? t('rewind.restoreCode') : t('rewind.noCheckpoint')}
              >
                {'\u64a4\u9500'}
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.5 3L2 5.5l2.5 2.5" />
                  <path d="M2.5 5.5H7a2.5 2.5 0 110 5H5.5" />
                </svg>
              </button>
              <button
                onClick={handleReview}
                className="inline-flex items-center rounded-full border border-border-subtle bg-bg-secondary/70 px-3 py-1.5 text-[12px] font-medium text-text-primary transition-smooth hover:bg-bg-tertiary"
              >
                {'\u5ba1\u9605'}
              </button>
            </div>
          </div>
        </div>
        <div className="border-t border-border-subtle/70">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                useSettingsStore.getState().setSecondaryTab('files');
                useFileStore.getState().selectFile(item.filePath);
              }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-smooth hover:bg-bg-secondary/55"
              title={item.filePath}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                {item.displayPath || shortFilePath(item.filePath)}
              </span>
              <span className="flex-shrink-0 text-[13px] font-mono text-success">
                +{item.added}
              </span>
              <span className="flex-shrink-0 text-[13px] font-mono text-error">
                -{item.removed}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const messages = useActiveTab((t) => t.messages);
  const isStreaming = useActiveTab((t) => t.isStreaming);
  const partialText = useActiveTab((t) => t.partialText);
  const partialThinking = useActiveTab((t) => t.partialThinking);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);
  const sessionMeta = useActiveTab((t) => t.sessionMeta);
  const activityStatus = useActiveTab((t) => t.activityStatus);
  const sidebarOpen = useSettingsStore((s) => s.sidebarOpen);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const toggleSecondaryTab = useSettingsStore((s) => s.toggleSecondaryTab);
  const agentPanelOpen = useSettingsStore((s) => s.agentPanelOpen);
  const toggleAgentPanel = useSettingsStore((s) => s.toggleAgentPanel);
  const sessionMode = useSettingsStore((s) => s.sessionMode);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const directoryMissing = useFileStore((s) => s.directoryMissing);
  const lastFileChangeAt = useFileStore((s) => s.lastChangeAt);
  const changedFiles = useFileStore((s) => s.changedFiles);
  const liveReviewEntries = useFileStore((s) => s.liveReviewEntries);
  const activeProvider = useProviderStore((s) => {
    if (!s.activeProviderId) return null;
    return s.providers.find((p) => p.id === s.activeProviderId) ?? null;
  });
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const isFilePreviewMode = !!useFileStore((s) => s.selectedFile);

  // Agent activity for floating button badge
  const agents = useAgentStore((s) => s.agents);
  const activeAgentCount = useMemo(
    () => Array.from(agents.values()).filter(
      (a) => a.phase !== 'completed' && a.phase !== 'error'
    ).length,
    [agents],
  );
  const totalAgentCount = agents.size;

  const showPlanPanel = usePlanPanelStore((s) => s.open);
  const closePlanPanel = usePlanPanelStore((s) => s.close);


  // Listen for internal file tree drag-drop (mouse-based, not HTML5 drag-and-drop)
  // HTML5 drag events don't work in Tauri because dragDropEnabled: true intercepts them.
  // Listen for file-chip click → open file in secondary panel's file browser
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const filePath = (e as CustomEvent<string>).detail;
      if (!filePath) return;
      // Open secondary panel to files tab and select the file
      useSettingsStore.getState().setSecondaryTab('files');
      useFileStore.getState().selectFile(filePath);
    };
    window.addEventListener('tokenicode:open-file', onOpenFile);
    return () => window.removeEventListener('tokenicode:open-file', onOpenFile);
  }, []);

  const footerPendingUser = useMemo(() => {
    if (sessionStatus !== 'running') return null;
    const latestUserIdx = [...messages].map((m) => m.role).lastIndexOf('user');
    if (latestUserIdx < 0) return null;

    const currentTurnMessages = messages.slice(latestUserIdx + 1);
    const hasCommittedReply = currentTurnMessages.some(
      (m) => m.role === 'assistant' && m.type === 'text' && typeof m.content === 'string' && m.content.trim().length > 0,
    );

    if (hasCommittedReply) return null;
    return { idx: latestUserIdx, message: messages[latestUserIdx] };
  }, [messages, sessionStatus]);

  const groupedDisplayItems = useMemo<BaseDisplayItem[]>(() => {
    const items: BaseDisplayItem[] = [];
    let i = 0;
    while (i < messages.length) {
      if (footerPendingUser && i === footerPendingUser.idx) {
        i++;
        continue;
      }
      // Detect runs of consecutive tool_use messages
      if (messages[i].type === 'tool_use') {
        let j = i;
        while (j < messages.length && messages[j].type === 'tool_use') j++;
        const runLength = j - i;
        if (runLength >= 3) {
          items.push({ kind: 'tool_group', msgs: messages.slice(i, j), startIdx: i });
          i = j;
          continue;
        }
      }
      items.push({ kind: 'message', msg: messages[i], idx: i });
      i++;
    }
    return items;
  }, [messages, footerPendingUser]);

  const displayItems = useMemo<DisplayItem[]>(() => {
    const items: DisplayItem[] = [];
    let compactRun: BaseDisplayItem[] = [];

    const flushCompactRun = () => {
      if (compactRun.length === 0) return;

      const chunkCount = Math.floor(compactRun.length / 10);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const start = chunkIndex * 10;
        const chunkItems = compactRun.slice(start, start + 10);
        items.push({
          kind: 'process_chunk',
          items: chunkItems,
          startIdx: getDisplayItemStartIdx(chunkItems[0]),
        });
      }

      const remainderStart = chunkCount * 10;
      compactRun.slice(remainderStart).forEach((item) => items.push(item));
      compactRun = [];
    };

    groupedDisplayItems.forEach((item) => {
      if (isCompactDisplayItem(item)) {
        compactRun.push(item);
        return;
      }

      flushCompactRun();
      items.push(item);
    });

    flushCompactRun();
    return items;
  }, [groupedDisplayItems]);

  // Collect plan review messages from the session (created by ExitPlanMode)
  const planMessages = useMemo(
    () => messages.filter((m) => m.type === 'plan_review' || m.type === 'plan' || m.planContent),
    [messages],
  );

  // Find the path of the currently selected session for export
  const currentSessionPath = sessions.find(
    (s) => s.id === selectedSessionId
  )?.path;

  const headerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const thinkingPreRef = useRef<HTMLPreElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const isNearBottomRef = useRef(true);
  // When user scrolls up via wheel, suppress auto-scroll until they return to bottom
  const userScrollingUpRef = useRef(false);
  // Show "scroll to bottom" button when user is far from bottom
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const showScrollBtnRef = useRef(false);
  const scrollRafRef = useRef(0);
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>();
  const [headerWidth, setHeaderWidth] = useState(0);
  const turns = useMemo(() => parseTurns(messages), [messages]);
  const currentTurn = turns[turns.length - 1];
  const visibleTurn = useMemo(
    () => turns.find((turn) => turn.userMessageId === activeTurnId) ?? turns[turns.length - 1],
    [turns, activeTurnId],
  );
  const stallRecoveryKeyRef = useRef('');
  const committedReplyRecoveryKeyRef = useRef('');
  const processHeartbeatKeyRef = useRef('');
  const fileProgressKeyRef = useRef('');

  useEffect(() => {
    if (!selectedSessionId || sessionStatus !== 'running') {
      stallRecoveryKeyRef.current = '';
      committedReplyRecoveryKeyRef.current = '';
      return;
    }

    const tick = () => {
      const tab = useChatStore.getState().getTab(selectedSessionId);
      if (!tab || tab.sessionStatus !== 'running') return;

      const activeStdinId = tab.sessionMeta.stdinId;
      const turnKey = `${selectedSessionId}:${tab.sessionMeta.turnStartTime ?? 0}`;
      const lastProgressAt = tab.sessionMeta.lastProgressAt ?? 0;
      const lastVisibleProgressAt = Math.max(lastProgressAt, lastFileChangeAt ?? 0);
      const recoverablePhase = tab.activityStatus.phase === 'thinking' || tab.activityStatus.phase === 'writing';
      const currentMessages = tab.messages;
      const latestUserIdx = [...currentMessages].map((m) => m.role).lastIndexOf('user');
      const currentTurnMessages = latestUserIdx >= 0 ? currentMessages.slice(latestUserIdx + 1) : currentMessages;
      const hasCommittedReply = currentTurnMessages.some(
        (m) => m.role === 'assistant' && m.type === 'text' && typeof m.content === 'string' && m.content.trim().length > 0,
      );
      const hasPendingInteraction = currentTurnMessages.some(
        (m) => ['permission', 'question', 'plan_review'].includes(m.type)
          && !m.resolved
          && m.interactionState !== 'resolved'
          && m.interactionState !== 'sending',
      );

      if (recoverablePhase && lastProgressAt && Date.now() - lastProgressAt > 150_000) {
        if (stallRecoveryKeyRef.current === turnKey) return;
        stallRecoveryKeyRef.current = turnKey;

        if (activeStdinId) {
          bridge.killSession(activeStdinId).catch(() => {});
          if ((window as any).__claudeUnlisteners?.[activeStdinId]) {
            (window as any).__claudeUnlisteners[activeStdinId]();
            delete (window as any).__claudeUnlisteners[activeStdinId];
          }
          useSessionStore.getState().unregisterStdinTab(activeStdinId);
        }

        const store = useChatStore.getState();
        const currentTab = store.getTab(selectedSessionId);
        const currentMessages2 = currentTab?.messages ?? [];
        const trimmedThinking = currentTab?.partialThinking?.trimEnd() || '';
        const trimmedText = currentTab?.partialText?.trimEnd() || '';

        if (trimmedThinking) {
          const duplicateThinking = currentMessages2.some(
            (existing) => existing.role === 'assistant' && existing.type === 'thinking' && existing.content === trimmedThinking,
          );
          if (!duplicateThinking) {
            store.addMessage(selectedSessionId, {
              id: generateMessageId(),
              role: 'assistant',
              type: 'thinking',
              content: trimmedThinking,
              timestamp: Date.now(),
            });
          }
        }

        if (trimmedText) {
          const duplicateText = currentMessages2.some(
            (existing) => existing.role === 'assistant' && existing.type === 'text' && existing.content === trimmedText,
          );
          if (!duplicateText) {
            store.addMessage(selectedSessionId, {
              id: generateMessageId(),
              role: 'assistant',
              type: 'text',
              content: trimmedText,
              timestamp: Date.now(),
            });
          }
        }

        store.setSessionStatus(selectedSessionId, 'completed');
        store.setActivityStatus(selectedSessionId, { phase: 'completed' });
        store.pushProcessEvent(selectedSessionId, {
          kind: 'warning',
          label: 'Recovered stalled stream',
          detail: 'Completed from buffered output after 150s without new stream events',
        });
        store.setSessionMeta(selectedSessionId, { stdinId: undefined, lastProgressAt: undefined });
        return;
      }

      if (!hasCommittedReply || hasPendingInteraction) return;
      const committedKey = `${selectedSessionId}:${tab.sessionMeta.turnStartTime ?? 0}:committed`;
      if (lastVisibleProgressAt && Date.now() - lastVisibleProgressAt > 30_000 && committedReplyRecoveryKeyRef.current !== committedKey) {
        committedReplyRecoveryKeyRef.current = committedKey;

        if (activeStdinId) {
          bridge.killSession(activeStdinId).catch(() => {});
          if ((window as any).__claudeUnlisteners?.[activeStdinId]) {
            (window as any).__claudeUnlisteners[activeStdinId]();
            delete (window as any).__claudeUnlisteners[activeStdinId];
          }
          useSessionStore.getState().unregisterStdinTab(activeStdinId);
        }

        const store = useChatStore.getState();
        store.setSessionStatus(selectedSessionId, 'completed');
        store.setActivityStatus(selectedSessionId, { phase: 'completed' });
        store.pushProcessEvent(selectedSessionId, {
          kind: 'result',
          label: 'Finalized visible reply',
          detail: 'No new stream events for 30s after committed assistant response',
        });
        store.setSessionMeta(selectedSessionId, { stdinId: undefined, lastProgressAt: undefined });
      }
    };

    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [lastFileChangeAt, selectedSessionId, sessionStatus]);

  useEffect(() => {
    if (!selectedSessionId || sessionStatus !== 'running') {
      processHeartbeatKeyRef.current = '';
      return;
    }
    if (activityStatus.phase !== 'thinking' && activityStatus.phase !== 'writing' && activityStatus.phase !== 'tool') {
      processHeartbeatKeyRef.current = '';
      return;
    }

    const id = window.setInterval(() => {
      const tab = useChatStore.getState().getTab(selectedSessionId);
      if (!tab || tab.sessionStatus !== 'running') return;
      if (tab.activityStatus.phase !== 'thinking' && tab.activityStatus.phase !== 'writing' && tab.activityStatus.phase !== 'tool') return;

      const lastProgressAt = Math.max(
        tab.sessionMeta.lastProgressAt ?? 0,
        lastFileChangeAt ?? 0,
        tab.sessionMeta.turnStartTime ?? 0,
      );
      if (!lastProgressAt) return;

      const age = Date.now() - lastProgressAt;
      if (age < 60_000) return;

      const bucket = Math.floor(age / 30_000);
      const key = `${selectedSessionId}:${tab.sessionMeta.turnStartTime ?? 0}:${tab.activityStatus.phase}:${bucket}`;
      if (processHeartbeatKeyRef.current === key) return;
      processHeartbeatKeyRef.current = key;

      useChatStore.getState().pushProcessEvent(selectedSessionId, {
        kind: 'warning',
        label: 'No new stream events',
        detail: `${Math.floor(age / 1000)}s since last visible progress`,
      });
    }, 10000);

    return () => window.clearInterval(id);
  }, [activityStatus.phase, selectedSessionId, sessionStatus, lastFileChangeAt]);

  useEffect(() => {
    if (!selectedSessionId || sessionStatus !== 'running' || !lastFileChangeAt) {
      fileProgressKeyRef.current = '';
      return;
    }

    let latestPath = '';
    let latestKind: 'created' | 'modified' | 'removed' | '' = '';
    let latestAt = 0;

    for (const entry of liveReviewEntries.values()) {
      if (entry.updatedAt >= latestAt) {
        latestAt = entry.updatedAt;
        latestPath = entry.filePath;
        latestKind = entry.kind;
      }
    }

    if (!latestPath || !latestKind) return;

    const key = `${selectedSessionId}:${latestKind}:${latestPath}:${latestAt}`;
    if (fileProgressKeyRef.current === key) return;
    fileProgressKeyRef.current = key;

    const label = latestKind === 'created'
      ? 'File created'
      : latestKind === 'removed'
        ? 'File removed'
        : 'File updated';

  useChatStore.getState().pushProcessEvent(selectedSessionId, {
      kind: 'tool',
      label,
      detail: shortFilePath(latestPath),
    });
  }, [liveReviewEntries, lastFileChangeAt, selectedSessionId, sessionStatus]);

  const liveFileProgressItems = useMemo(() => {
    const items = new Map<string, LiveFileProgressItem>();

    for (const entry of liveReviewEntries.values()) {
      const parts = getFileDisplayParts(entry.filePath, workingDirectory);
      items.set(entry.filePath, {
        id: `live:${entry.filePath}`,
        filePath: entry.filePath,
        displayName: parts.displayName,
        displayPath: parts.displayPath,
        kind: entry.kind,
        added: entry.added,
        removed: entry.removed,
        updatedAt: entry.updatedAt,
        source: entry.source === 'watcher' ? 'watcher' : 'live',
      });
    }

    for (const [filePath, kind] of changedFiles) {
      if (items.has(filePath)) continue;
      const parts = getFileDisplayParts(filePath, workingDirectory);
      items.set(filePath, {
        id: `watch:${filePath}`,
        filePath,
        displayName: parts.displayName,
        displayPath: parts.displayPath,
        kind,
        added: 0,
        removed: 0,
        updatedAt: lastFileChangeAt ?? Date.now(),
        source: 'watcher',
      });
    }

    for (const [index, change] of (currentTurn?.codeChanges ?? []).entries()) {
      if (change.action === 'terminal' || items.has(change.filePath)) continue;
      const parts = getFileDisplayParts(change.filePath, workingDirectory);
      items.set(change.filePath, {
        id: `turn:${index}:${change.filePath}`,
        filePath: change.filePath,
        displayName: parts.displayName,
        displayPath: parts.displayPath,
        kind: change.action === 'created' ? 'created' : 'modified',
        added: 0,
        removed: 0,
        updatedAt: currentTurn?.timestamp ?? Date.now(),
        source: 'turn',
      });
    }

    return Array.from(items.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [liveReviewEntries, changedFiles, currentTurn, workingDirectory, lastFileChangeAt]);

  const openFilePreview = useCallback((path: string) => {
    toggleSecondaryTab('files');
    void useFileStore.getState().selectFile(path);
  }, [toggleSecondaryTab]);

  const openReviewPanel = useCallback(() => {
    toggleSecondaryTab('overview');
  }, [toggleSecondaryTab]);

  const setMessageNode = useCallback((id: string) => (node: HTMLDivElement | null) => {
    if (node) {
      messageRefs.current.set(id, node);
    } else {
      messageRefs.current.delete(id);
    }
  }, []);

  const updateActiveTurnFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || turns.length === 0) {
      setActiveTurnId(undefined);
      return;
    }

    const marker = el.scrollTop + 140;
    let current = turns[0].userMessageId;
    for (const turn of turns) {
      const node = messageRefs.current.get(turn.userMessageId);
      if (!node) continue;
      if (node.offsetTop <= marker) {
        current = turn.userMessageId;
      } else {
        break;
      }
    }
    setActiveTurnId((prev) => prev === current ? prev : current);
  }, [turns]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    userScrollingUpRef.current = false;
    setShowScrollBtn(false);
    setActiveTurnId(turns[turns.length - 1]?.userMessageId);
  }, [turns]);

  const jumpToTurn = useCallback((turn: Turn) => {
    const node = messageRefs.current.get(turn.userMessageId);
    if (!node) return;
    userScrollingUpRef.current = true;
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveTurnId(turn.userMessageId);
  }, []);

  // Track whether user is near the bottom of the scroll container, throttled via rAF
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) {
      userScrollingUpRef.current = false;
    }
    // Only update React state when the boolean actually changes, and throttle via rAF
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > 300;
    if (far !== showScrollBtnRef.current) {
      showScrollBtnRef.current = far;
      if (scrollRafRef.current) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        setShowScrollBtn(showScrollBtnRef.current);
      });
    }
    updateActiveTurnFromScroll();
  }, [updateActiveTurnFromScroll]);

  // Detect intentional upward scroll via wheel event
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User is scrolling up — suppress auto-scroll
        userScrollingUpRef.current = true;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Auto-scroll to bottom only when already near bottom and user isn't scrolling up
  useEffect(() => {
    if (isNearBottomRef.current && !userScrollingUpRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, partialText, partialThinking]);

  useEffect(() => {
    updateActiveTurnFromScroll();
  }, [turns.length, messages.length, updateActiveTurnFromScroll]);

  // Auto-scroll the internal thinking <pre> to bottom as new content streams in
  useEffect(() => {
    const el = thinkingPreRef.current;
    if (el && partialThinking) {
      el.scrollTop = el.scrollHeight;
    }
  }, [partialThinking]);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;

    const update = () => setHeaderWidth(el.clientWidth);
    update();

    const observer = new ResizeObserver(() => update());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const isCompactHeader = headerWidth > 0 && headerWidth < 1080;
  const isVeryCompactHeader = headerWidth > 0 && headerWidth < 940;
  const isUltraCompactHeader = headerWidth > 0 && headerWidth < 820;
  const isEdgeCompactHeader = headerWidth > 0 && headerWidth < 700;

  const renderDisplayEntry = (item: BaseDisplayItem) => {
    if (item.kind === 'tool_group') {
      return <ToolGroup messages={item.msgs} />;
    }

    const msg = item.msg;
    const idx = item.idx;
    let isFirstInGroup = true;
    if (msg.role === 'assistant' && msg.type === 'text') {
      for (let j = idx - 1; j >= 0; j--) {
        const prev = messages[j];
        if (prev.role === 'user') break;
        if (prev.role === 'assistant' && prev.type === 'text') {
          isFirstInGroup = false;
          break;
        }
      }
    }

    return (
      <div ref={setMessageNode(msg.id)} className="chat-message-item">
        <MessageBubble message={msg} isFirstInGroup={isFirstInGroup} />
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar */}
      <div
        ref={headerRef}
        className={`flex items-center h-[48px] border-b border-border-subtle
        flex-shrink-0 bg-bg-chat cursor-default overflow-visible
        ${isUltraCompactHeader ? 'px-2.5 gap-1.5' : isCompactHeader ? 'px-3 gap-2' : 'px-5 gap-3'}`}>
        {/* Show sidebar toggle when sidebar is not visible:
            either user closed it, or it's hidden by file preview mode */}
        {(!sidebarOpen || isFilePreviewMode) && (
          <button onClick={toggleSidebar}
            className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-tertiary
              transition-smooth mr-3 flex-shrink-0" title={t('chat.showSidebar')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
        )}
        {/* Left: model name + project hint */}
        <div className={`flex min-w-0 flex-shrink items-center overflow-hidden pointer-events-none ${
          isUltraCompactHeader ? 'gap-1' : 'gap-2'
        }`}>
          {sessionMeta.model && (
            <span
              className={`text-sm font-medium text-text-muted whitespace-nowrap min-w-0 truncate ${
                isEdgeCompactHeader ? 'max-w-[56px]' : isUltraCompactHeader ? 'max-w-[72px]' : isCompactHeader ? 'max-w-[96px]' : 'max-w-[140px]'
              }`}
              title={sessionMeta.model}
            >
              {getModelDisplayName(sessionMeta.model)}
            </span>
          )}
          {workingDirectory && !isUltraCompactHeader && (
            <span className={`text-[10px] text-text-tertiary truncate whitespace-nowrap min-w-0 ${
              isVeryCompactHeader ? 'max-w-[72px]' : isCompactHeader ? 'max-w-[100px]' : 'max-w-[160px]'
            }`}
              title={workingDirectory}>
              {workingDirectory.split(/[\\/]/).pop()}
            </span>
          )}
        </div>

        {/* Integrated status: Agent + API route — left-aligned with color dots */}
        <div className={`relative flex min-w-0 flex-shrink items-center overflow-hidden ${
          isUltraCompactHeader ? 'ml-1 gap-1' : 'ml-2 gap-2'
        }`}>
          {/* Agent status — clickable dot + label → opens AgentPanel */}
          <button onClick={toggleAgentPanel}
            className={`flex items-center ${isCompactHeader ? 'gap-0 px-1' : 'gap-1.5 px-1.5'} py-0.5 rounded-lg
              transition-smooth text-[9px]
              ${agentPanelOpen ? 'bg-accent/10' : 'hover:bg-bg-secondary/50'} flex-shrink-0`}
            title={t('agents.toggle')}>
            <span className={`w-[6px] h-[6px] rounded-full flex-shrink-0 transition-smooth
              ${activeAgentCount > 0
                ? 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.5)] animate-pulse-soft'
                : totalAgentCount > 0
                  ? 'bg-success'
                  : 'bg-text-tertiary/30'}`} />
            {!isCompactHeader && (
              <span className={`${activeAgentCount > 0 ? 'text-amber-400' : totalAgentCount > 0 ? 'text-success' : 'text-text-tertiary'} whitespace-nowrap`}>
                Agent{totalAgentCount > 1 ? ` (${totalAgentCount})` : ''}
              </span>
            )}
          </button>

          {/* API route status — dot + label */}
          <div className={`flex items-center ${isCompactHeader ? 'gap-0.5' : 'gap-1.5'} text-[9px] min-w-0 flex-shrink overflow-hidden`}>
            <span className={`w-[6px] h-[6px] rounded-full flex-shrink-0 transition-smooth
              ${sessionStatus === 'running'
                ? 'bg-success shadow-[0_0_6px_var(--color-accent-glow)] animate-pulse-soft'
                : sessionStatus === 'error'
                  ? 'bg-error'
                  : 'bg-text-tertiary/30'}`} />
            {!isVeryCompactHeader && (
              <span className="text-text-tertiary whitespace-nowrap truncate">
                {activeProvider ? (activeProvider.name || 'Custom') : 'CLI'}
              </span>
            )}
          </div>

          {/* Current session mode indicator */}
          {!isVeryCompactHeader && (
            <div className={`flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded whitespace-nowrap flex-shrink-0
              ${sessionMode === 'bypass'
                ? 'text-warning/80'
                : 'text-text-tertiary'}`}>
              <span>{t(`mode.${sessionMode}`)}</span>
            </div>
          )}

          {/* Floating agent panel popover — anchored to agent button */}
          {agentPanelOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={toggleAgentPanel} />
              <div className="absolute left-0 top-full mt-2 z-50
                w-72 max-h-80 rounded-xl border border-border-subtle
                bg-bg-primary shadow-lg overflow-y-auto">
                <AgentPanel />
              </div>
            </>
          )}
        </div>

        {/* Spacer + right-side actions */}
        <div className="ml-auto flex min-w-0 items-center" />
        <div className={`flex items-center flex-shrink-0 ${isUltraCompactHeader ? 'gap-0.5' : 'gap-1'}`}>
          {!isVeryCompactHeader && <ContextMeter
            sessionMeta={sessionMeta}
            tabId={selectedSessionId}
            sessionStatus={sessionStatus}
          />}
          {!isUltraCompactHeader && <GitActionMenu />}
          {!isEdgeCompactHeader && <UpdateButton />}
          {!isVeryCompactHeader && <ExportMenu sessionPath={currentSessionPath} />}
          <button
            onClick={() => toggleSecondaryTab('preview')}
            className={`${isUltraCompactHeader ? 'p-1' : 'p-1.5'} rounded-lg hover:bg-bg-tertiary text-text-tertiary transition-smooth`}
            title={t('panel.preview')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M2 4h12v8H2zM5 14h6" />
            </svg>
          </button>
          <button
            onClick={() => toggleSecondaryTab('files')}
            className={`${isUltraCompactHeader ? 'p-1' : 'p-1.5'} rounded-lg hover:bg-bg-tertiary text-text-tertiary transition-smooth`}
            title={t('chat.toggleFiles')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <rect x="1" y="2" width="14" height="12" rx="2" />
              <path d="M10 2v12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 relative">
      {/* Main chat area */}
      <div className="flex flex-col flex-1 min-w-0">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-5 py-6 selectable chat-scroll-container">
        {!workingDirectory && messages.length === 0 && !isStreaming ? (
          <WelcomeScreen />
        ) : messages.length === 0 && !isStreaming ? (
          <EmptyReadyState />
        ) : (
          <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end lg:pr-24">
            <TurnChangeStrip turn={visibleTurn} />
            {displayItems.map((item, displayIdx) => {
              // Determine spacing based on item type
              const isCompact = isCompactDisplayItem(item);
              const prevItem = displayIdx > 0 ? displayItems[displayIdx - 1] : null;
              const prevIsCompact = isCompactDisplayItem(prevItem);
              const spacing = displayIdx === 0
                ? ''
                : isCompact && prevIsCompact
                  ? 'mt-0.5'
                  : isCompact || prevIsCompact
                    ? 'mt-2'
                    : 'mt-5';

              if (item.kind === 'process_chunk') {
                return (
                  <div key={`pc_${item.startIdx}`} className={spacing}>
                    <ProcessChunkGroup items={item.items} renderItem={renderDisplayEntry} />
                  </div>
                );
              }

              return (
                <div key={item.kind === 'tool_group' ? `tg_${item.msgs[0].id}` : item.msg.id} className={spacing}>
                  {renderDisplayEntry(item)}
                </div>
              );
            })}
            {/* Streaming thinking — collapsible like ThinkingMsg but with pulse cursor */}
            {isStreaming && partialThinking && (
              <div className="ml-11 mt-1">
                <details open className="group">
                  <summary className="flex items-center gap-1.5 py-1
                    cursor-pointer text-[11px] text-text-tertiary list-none select-none">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                      stroke="currentColor" strokeWidth="1.5"
                      className="transition-transform duration-150 group-open:rotate-90">
                      <path d="M3 2l4 3-4 3" />
                    </svg>
                    {t('msg.thinking')}
                    <span className="inline-block w-1.5 h-3 bg-text-tertiary ml-0.5
                      animate-pulse-soft rounded-sm" />
                  </summary>
                  <pre ref={thinkingPreRef} className="ml-5 mt-0.5 text-[11px] text-text-tertiary
                    whitespace-pre-wrap max-h-48 overflow-y-auto
                    font-mono leading-relaxed">
                    {partialThinking}
                  </pre>
                </details>
              </div>
            )}
            {isStreaming && partialText && (() => {
              // Hide streaming text while an unresolved question is pending —
              // the CLI may keep sending text_delta events for the next turn's
              // content, but the user needs to answer the question first.
              // Check both resolved flag AND interactionState to handle edge
              // cases where setInteractionState hasn't propagated yet.
              const hasPendingQuestion = messages.some(
                (m) => m.type === 'question' && !m.resolved
                  && m.interactionState !== 'resolved' && m.interactionState !== 'sending',
              );
              if (hasPendingQuestion) return null;

              // Check if there's already an assistant text in this turn
              let showStreamAvatar = true;
              for (let j = messages.length - 1; j >= 0; j--) {
                if (messages[j].role === 'user') break;
                if (messages[j].role === 'assistant' && messages[j].type === 'text') {
                  showStreamAvatar = false;
                  break;
                }
              }
              return (
              <div className="flex gap-3 mt-2">
                {showStreamAvatar ? (
                  <div className="w-8 h-8 rounded-[10px] bg-accent
                    flex items-center justify-center flex-shrink-0 text-text-inverse
                    text-xs font-bold shadow-md mt-0.5">C</div>
                ) : (
                  <div className="w-8 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0 text-base text-text-primary leading-relaxed">
                  <MarkdownRenderer content={partialText} />
                  <span className="inline-block w-2 h-5 bg-accent ml-0.5
                    animate-pulse-soft rounded-sm shadow-[0_0_8px_var(--color-accent-glow)]" />
                </div>
              </div>
              );
            })()}
            {/* Inline activity status indicator — like Claude Desktop App */}
          </div>
        )}
      </div>

      {!showPlanPanel && (
        <ConversationTimeline
          turns={turns}
          activeTurnId={activeTurnId}
          showScrollBtn={showScrollBtn}
          onJumpTurn={jumpToTurn}
          onJumpBottom={scrollToBottom}
        />
      )}

      {/* Scroll to bottom FAB */}
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10
            inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-card border border-border-subtle
            shadow-md hover:shadow-lg justify-center
            text-text-muted hover:text-text-primary transition-smooth
            cursor-pointer opacity-80 hover:opacity-100"
          title={t('chat.scrollToBottom')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M7 2v10M3 8l4 4 4-4" />
          </svg>
          <span className="text-xs">{t('chat.latest')}</span>
        </button>
      )}

      {/* Directory missing banner */}
      {workingDirectory && directoryMissing && (
        <div className="mx-4 mb-3 px-4 py-3 rounded-xl bg-status-warning/10 border border-status-warning/30
          flex items-center gap-3 text-sm text-text-secondary">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.5" className="flex-shrink-0 text-status-warning">
            <path d="M8 1.5L1.5 13h13L8 1.5z" strokeLinejoin="round" />
            <path d="M8 6v3" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
          </svg>
          <span className="flex-1">{t('project.directoryMissing')}</span>
          <button
            onClick={async () => {
              const selected = await open({ directory: true, multiple: false, title: t('project.selectFolder') });
              if (selected) useSettingsStore.getState().setWorkingDirectory(selected as string);
            }}
            className="px-3 py-1 rounded-lg text-xs font-medium
              bg-status-warning/20 hover:bg-status-warning/30
              text-status-warning transition-smooth"
          >
            {t('project.reselect')}
          </button>
        </div>
      )}

      {/* Input — only show when a project folder is selected and exists */}
      {footerPendingUser && (
        <div className="mx-5 mb-2">
          <div className="mx-auto max-w-3xl lg:pr-24">
            <MessageBubble message={footerPendingUser.message} />
          </div>
        </div>
      )}
      {(sessionStatus === 'running' || activityStatus.phase === 'awaiting') && (
        <div className="mx-5 mb-3">
          <div className="mx-auto max-w-3xl lg:pr-24">
            <div className="ml-11 max-w-[calc(100%-2.75rem)]">
              <ActivityIndicator
                activityStatus={activityStatus}
                sessionMeta={{ ...sessionMeta, lastChangeAt: lastFileChangeAt }}
                fileProgressItems={liveFileProgressItems}
                onOpenFile={openFilePreview}
                onOpenReview={openReviewPanel}
              />
            </div>
          </div>
        </div>
      )}
      {workingDirectory && !directoryMissing && <InputBar />}
      </div>{/* end main chat area */}

      {/* Right-side plan panel (resizable) */}
      {showPlanPanel && (
        <PlanPanel
          planMessages={planMessages}
          onClose={closePlanPanel}
        />
      )}
      </div>{/* end flex row */}
    </div>
  );
}

/** Start a new draft conversation for the given folder and pre-warm the CLI process */
async function startDraftSession(folderPath: string) {
  useSettingsStore.getState().setWorkingDirectory(folderPath);
  const currentTab = useSessionStore.getState().selectedSessionId;
  if (currentTab) useChatStore.getState().resetTab(currentTab);

  // Reuse existing draft tab if one is already selected, otherwise create a new one
  const currentTabId = useSessionStore.getState().selectedSessionId;
  const currentSession = useSessionStore.getState().sessions.find(
    (s) => s.id === currentTabId,
  );
  let draftId: string;
  if (currentSession && currentSession.path === '') {
    // Reuse the existing draft — just update its project info
    draftId = currentSession.id;
    useSessionStore.getState().updateDraftProject(draftId, folderPath);
  } else {
    // No draft selected — create a new one
    draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().addDraftSession(draftId, folderPath);
  }

  // Pre-warm: spawn CLI process in background so first message is fast.
  // Send empty prompt — Rust will skip the NDJSON send.
  const preWarmId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Register stream listeners before spawning
    const unlisten = await onClaudeStream(preWarmId, (msg: any) => {
      // Tag message with stdinId so the handler can route to correct session
      msg.__stdinId = preWarmId;
      // Forward to InputBar's handler via a global — will be overridden when InputBar mounts
      const handler = (window as any).__claudeStreamHandler;
      if (handler) {
        // Replay any events that arrived while handler was briefly null (React effect cycle)
        const queue: any[] = (window as any).__claudeStreamQueue;
        if (queue && queue.length > 0) {
          console.warn(`[TOKENICODE] replaying ${queue.length} queued pre-warm events`);
          const pending = queue.splice(0);
          for (const queued of pending) handler(queued);
        }
        handler(msg);
      } else {
        // Handler not yet available (InputBar not mounted or React effect cycle) — queue the event
        if (!(window as any).__claudeStreamQueue) (window as any).__claudeStreamQueue = [];
        (window as any).__claudeStreamQueue.push(msg);
        console.warn('[TOKENICODE] pre-warm event queued (handler not ready):', msg.type);
      }
    });
    const unlistenStderr = await onClaudeStderr(preWarmId, (line: string) => {
      // Log pre-warm stderr for debugging (errors here explain why CLI may fail)
      console.warn('[TOKENICODE] pre-warm stderr:', line);
    });

    // Store unlisten per stdinId for multi-session support
    if (!(window as any).__claudeUnlisteners) {
      (window as any).__claudeUnlisteners = {};
    }
    (window as any).__claudeUnlisteners[preWarmId] = () => {
      unlisten();
      unlistenStderr();
    };

    const selectedModel = useSettingsStore.getState().selectedModel;
    const sessionMode = useSettingsStore.getState().sessionMode;
    const thinkingSetting = useSettingsStore.getState().thinkingLevel;
    const contextWindowMode = useSettingsStore.getState().contextWindowMode;
    const providerId = useProviderStore.getState().activeProviderId || null;
    const resolvedModel = resolveModelForProvider(selectedModel);
    const session = await bridge.startSession({
      prompt: '',  // empty = pre-warm, no message sent
      cwd: folderPath,
      model: resolvedModel,
      session_id: preWarmId,
      thinking_level: resolveThinkingLevelForProvider(
        selectedModel,
        thinkingSetting,
      ),
      provider_id: providerId || undefined,
      context_window: getContextWindowForModel(resolvedModel, contextWindowMode),
      permission_mode: mapSessionModeToPermissionMode(sessionMode),
    });

    // Store stdinId so InputBar can send the first message via stdin
    useChatStore.getState().ensureTab(draftId);
    useChatStore.getState().setSessionMeta(draftId, {
      sessionId: session.session_id,
      stdinId: preWarmId,
      envFingerprint: envFingerprint(),
      snapshotMode: sessionMode,
      snapshotModel: selectedModel,
      snapshotThinking: thinkingSetting,
      snapshotContextWindowMode: contextWindowMode,
      snapshotProviderId: providerId,
      spawnedModel: resolvedModel,
    });

    // Register stdinId → tabId mapping for background stream routing
    useSessionStore.getState().registerStdinTab(preWarmId, draftId);

    // Skip desk_* IDs — they pollute tracked_sessions.txt (multi-session isolation fix)
    if (!session.session_id.startsWith('desk_')) {
      bridge.trackSession(session.session_id).catch(() => {});
    }
  } catch {
    // Pre-warm failed — InputBar will spawn on first message instead
  }
}

/** Welcome screen shown when no project folder is selected */
function WelcomeScreen() {
  const t = useT();
  const setupCompleted = useSettingsStore((s) => s.setupCompleted);
  const recentProjects = useFileStore((s) => s.recentProjects);
  const fetchProjects = useFileStore((s) => s.fetchRecentProjects);

  useEffect(() => { fetchProjects(); }, []);

  const handlePickFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('project.selectFolder'),
    });
    if (selected) {
      startDraftSession(selected as string);
    }
  }, [t]);

  // Show SetupWizard if setup has not been completed
  if (!setupCompleted) {
    return <SetupWizard />;
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {/* App icon — customizable AI avatar */}
      <AiAvatar size="w-20 h-20" rounded="rounded-3xl" className="mb-6 shadow-glow" />
      <h2 className="text-xl font-semibold text-accent mb-2">
        {t('chat.welcome')}
      </h2>
      <p className="text-sm text-text-muted max-w-sm leading-relaxed mb-6">
        {t('welcome.subtitle')}
      </p>

      {/* Primary action: new chat with folder picker */}
      <button
        onClick={handlePickFolder}
        className="px-6 py-3 rounded-[20px] text-sm font-medium
          bg-accent hover:bg-accent-hover text-text-inverse
          hover:shadow-glow transition-smooth
          flex items-center gap-2 mb-8"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h4l2 2h6v7H2V4z" />
        </svg>
        {t('welcome.newChat')}
      </button>

      {/* Recent projects */}
      {recentProjects.length > 0 && (
        <div className="w-full max-w-sm">
          <div className="text-[11px] font-medium text-text-tertiary uppercase
            tracking-wider mb-3">
            {t('welcome.recentProjects')}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {recentProjects.slice(0, 6).map((project) => (
              <button
                key={project.path}
                onClick={() => startDraftSession(project.path)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5
                  rounded-lg border border-border-subtle text-xs
                  text-text-muted hover:border-accent hover:text-accent
                  hover:bg-accent/5 transition-smooth"
                title={project.shortPath}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5"
                  className="flex-shrink-0 text-text-tertiary">
                  <path d="M2 4h4l2 2h6v7H2V4z" />
                </svg>
                {project.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Empty state shown when project is selected but no messages yet */
function EmptyReadyState() {
  const t = useT();
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {/* App icon — customizable AI avatar */}
      <AiAvatar size="w-16 h-16" rounded="rounded-2xl" className="mb-5 shadow-glow" />
      <h2 className="text-lg font-semibold text-accent mb-1">
        {t('chat.welcome')}
      </h2>
      <p className="text-sm text-text-muted max-w-sm leading-relaxed">
        {t('chat.welcomeWithProject')}
      </p>
      {workingDirectory && (
        <p className="text-xs text-text-tertiary mt-2 truncate max-w-xs">
          {workingDirectory}
        </p>
      )}
    </div>
  );
}
