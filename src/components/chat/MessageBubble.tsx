import { memo, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { type ChatMessage } from '../../stores/chatStore';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useLightboxStore } from '../shared/ImageLightbox';
import { useT } from '../../lib/i18n';
import { bridge } from '../../lib/tauri-bridge';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { CommandProcessingCard } from './CommandProcessingCard';
import { PlanReviewCard } from './PlanReviewCard';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { AiAvatar } from '../shared/AiAvatar';
import { UserAvatar } from '../shared/UserAvatar';

interface Props {
  message: ChatMessage;
  isFirstInGroup?: boolean;
}

/** Guard against raw content-block objects ({text, type}) being rendered as
 *  JSX children — causes Minified React error #31. */
function safeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value);
}

export const MessageBubble = memo(function MessageBubble({ message, isFirstInGroup = true }: Props) {
  if (message.role === 'user') return <UserMsg message={message} />;
  if (message.role === 'system' && message.commandType === 'processing') return <CommandProcessingCard message={message} />;
  if (message.role === 'system' && message.commandType) return <CommandFeedbackMsg message={message} />;
  // Unresolved question/plan_review cards are rendered as floating overlays
  // above the InputBar. Only show them inline once resolved.
  if (message.type === 'question' && !message.resolved) return null;
  if (message.type === 'question') return <QuestionCard message={message} />;
  if (message.type === 'todo') return <TodoMsg message={message} />;
  if (message.type === 'plan_review' && !message.resolved) return null;
  if (message.type === 'plan_review') return <PlanReviewCard message={message} />;
  if (message.type === 'tool_use') return <ToolUseMsg message={message} />;
  if (message.type === 'thinking') return <ThinkingMsg message={message} />;
  if (message.type === 'tool_result') return <ToolResultMsg message={message} />;
  // Unresolved permission cards are rendered as floating overlays above InputBar
  if (message.type === 'permission' && !message.resolved && message.interactionState !== 'resolved') return null;
  if (message.type === 'permission') return <PermissionCard message={message} />;
  if (message.type === 'plan') return <PlanMsg message={message} />;
  return <AssistantMsg message={message} isFirstInGroup={isFirstInGroup} />;
});

/* ================================================================
   UserMsg — bubble on the right
   ================================================================ */
/** Collapse threshold: messages longer than this are collapsed by default */
const USER_MSG_COLLAPSE_LINES = 12;

/** Extract file extension from a filename */
function getFileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Detect file paths in inline code — same regexes as MarkdownRenderer */
const FILE_PATH_RE = /^(?:\/|\.\/|\.\.\/|[a-zA-Z]:[/\\]|src\/|lib\/|components\/|stores\/|hooks\/|utils\/|tests\/|__tests__\/)[\w.@/-]+\.\w{1,10}$/;
const KNOWN_EXT_RE = /^[\w][\w.-]*\.(?:md|mdx|ts|tsx|js|jsx|mjs|cjs|json|jsonl|toml|yaml|yml|py|pyi|rs|go|html|htm|css|scss|sass|less|vue|svelte|sh|bash|zsh|fish|env|conf|cfg|ini|xml|sql|graphql|gql|proto|lock|log|txt|csv|rb|php|java|kt|swift|c|cpp|h|hpp|cs|r|lua|zig|ex|exs|erl|ml|mli|tf|hcl|dockerfile|makefile|pdf|doc|docx|xls|xlsx|ppt|pptx)$/i;

function previewFilePath(filePath: string) {
  useFileStore.getState().selectFile(filePath);
}

function revealFilePath(filePath: string) {
  bridge.revealInFinder(filePath).catch(() => {});
}

function jumpToFilePath(filePath: string) {
  bridge.openInVscode(filePath).catch(() => {
    bridge.openWithDefaultApp(filePath).catch(() => {});
  });
}

/** Render a single backtick-inner segment: file path → clickable chip, else → inline code */
function renderCodeSegment(inner: string, key: number): ReactNode {
  if (FILE_PATH_RE.test(inner) || KNOWN_EXT_RE.test(inner)) {
    const wd = useSettingsStore.getState().workingDirectory || '';
    const resolved = inner.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(inner)
      ? inner
      : wd ? `${wd.replace(/\/$/, '')}/${inner}` : inner;
    const fileName = inner.split(/[\\/]/).pop() || inner;
    return (
      <span
        key={key}
        className="inline-flex items-center gap-1 mx-0.5 align-baseline max-w-full"
        title={resolved}
      >
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5
            bg-white/15 border border-white/25 rounded-md
            text-xs font-medium leading-normal whitespace-nowrap min-w-0 max-w-[220px]"
        >
          <span className="text-[10px]">FILE</span>
          <span className="truncate">{fileName}</span>
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            previewFilePath(resolved);
          }}
          className="inline-flex items-center px-1.5 py-0.5 rounded-md border border-white/25
            bg-white/10 text-[10px] hover:bg-white/20 hover:border-white/40 transition-all duration-150"
        >
          {"\u9884\u89c8"}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            revealFilePath(resolved);
          }}
          className="inline-flex items-center px-1.5 py-0.5 rounded-md border border-white/25
            bg-white/10 text-[10px] hover:bg-white/20 hover:border-white/40 transition-all duration-150"
          aria-label={"\u6587\u4ef6\u5939"}
          title={"\u6587\u4ef6\u5939"}
        >
          {"\u6587\u4ef6\u5939"}
        </button>
      </span>
    );
  }
  return (
    <code key={key} className="px-1.5 py-0.5 mx-0.5 rounded-md text-[13px]
      bg-white/15 border border-white/20 font-mono">
      {inner}
    </code>
  );
}
/** Parse backtick-wrapped segments in user text into styled inline code elements.
 *  Handles both single ` and triple ``` (renders as single-line code).
 *  File paths inside backticks become clickable chips. */
function renderUserContent(text: string): ReactNode {
  // Split on backtick patterns: ```...``` or `...`
  const parts = text.split(/(```[^`]*```|`[^`\n]+`)/g);
  if (parts.length === 1) return text; // no backticks found, return plain string

  return parts.map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3).trim();
      if (!inner) return part;
      return renderCodeSegment(inner, i);
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      const inner = part.slice(1, -1);
      if (!inner) return part;
      return renderCodeSegment(inner, i);
    }
    return part;
  });
}

function UserMsg({ message }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const attachments = message.attachments;
  const content = safeContent(message.content);
  const lines = content.split('\n');
  const isLong = lines.length > USER_MSG_COLLAPSE_LINES || content.length > 600;
  const displayContent = (!expanded && isLong)
    ? lines.slice(0, USER_MSG_COLLAPSE_LINES).join('\n')
    : content;

  useEffect(() => {
    if (!isEditing) {
      setEditValue(content);
    }
  }, [content, isEditing]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [content]);

  const handleStartEditing = useCallback(() => {
    setEditValue(content);
    setIsEditing(true);
  }, [content]);

  const handleCancelEditing = useCallback(() => {
    setEditValue(content);
    setIsEditing(false);
  }, [content]);

  const handleSubmitEdited = useCallback(() => {
    const next = editValue.trim();
    if (!next) return;
    window.dispatchEvent(new CustomEvent('tokenicode:submit-edited-message', {
      detail: { text: next, messageId: message.id },
    }));
    setIsEditing(false);
  }, [editValue, message.id]);

  return (
    <div className="flex justify-end gap-2.5 group/user relative">
      {/* Copy button — visible on hover */}
      <button
        onClick={handleCopy}
        className="hidden absolute -top-2 right-1 z-10 opacity-0 group-hover/user:opacity-100
          px-1.5 py-0.5 rounded-md text-[10px] font-medium
          bg-bg-tertiary/80 text-text-muted hover:text-text-primary
          hover:bg-bg-tertiary border border-border-subtle
          transition-smooth cursor-pointer"
      >
        {copied ? t('msg.copied') : t('msg.copyText')}
      </button>
      <div className="flex max-w-[75%] min-w-0 flex-col items-end gap-1.5">
      <div className="w-full px-3.5 py-2.5 rounded-2xl rounded-br-md
        bg-bg-user-msg text-text-inverse
        text-sm leading-relaxed shadow-md whitespace-pre-wrap">
        {renderUserContent(displayContent)}
        {!expanded && isLong && (
          <span className="text-white/60">…</span>
        )}
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="block mt-1.5 text-xs text-white/60 hover:text-white/90
              transition-smooth"
          >
            {expanded ? '▲ 收起' : '▼ 展开全部'}
          </button>
        )}
        {attachments && attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {attachments.map((att, i) => (
              <button
                key={i}
                onClick={() => {
                  if (att.isImage) {
                    useLightboxStore.getState().openFile(att.path, att.name);
                  } else {
                    useFileStore.getState().selectFile(att.path);
                  }
                }}
                className="inline-flex items-center gap-2 px-2.5 py-1.5
                  bg-white/10 hover:bg-white/20 rounded-lg border border-white/15
                  transition-smooth cursor-pointer text-left"
              >
                {att.isImage && att.preview ? (
                  <img src={att.preview} alt="" className="w-8 h-8 rounded object-cover" />
                ) : (
                  <span className="flex items-center justify-center w-8 h-8 rounded
                    bg-white/10 text-[10px] font-mono font-semibold uppercase opacity-80">
                    {getFileExt(att.name) || (
                      <svg width="14" height="14" viewBox="0 0 12 12" fill="none"
                        stroke="currentColor" strokeWidth="1.2">
                        <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
                        <path d="M7 1v3h3" />
                      </svg>
                    )}
                  </span>
                )}
                <span className="text-xs truncate max-w-[180px]">{att.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 pr-1">
          <button
            onClick={handleCopy}
            className="rounded-md border border-border-subtle bg-bg-card/85 px-2 py-1 text-[10px] font-medium text-text-muted transition-smooth hover:bg-bg-tertiary hover:text-text-primary"
          >
            {copied ? t('msg.copied') : t('msg.copyPrompt')}
          </button>
          {!isEditing && (
            <button
              onClick={handleStartEditing}
              className="rounded-md border border-border-subtle bg-bg-card/85 px-2 py-1 text-[10px] font-medium text-text-muted transition-smooth hover:bg-bg-tertiary hover:text-text-primary"
            >
              {t('msg.editMessage')}
            </button>
          )}
        </div>
        {isEditing && (
          <div className="w-full rounded-2xl rounded-br-md border border-border-subtle bg-bg-card/92 px-3.5 py-3 shadow-sm">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="min-h-[120px] w-full resize-y rounded-xl border border-border-subtle bg-bg-secondary/70 px-3 py-2 text-sm leading-relaxed text-text-primary outline-none"
              placeholder={t('msg.editMessage')}
            />
            <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
              <button
                onClick={handleCancelEditing}
                className="rounded-md border border-border-subtle bg-bg-card/85 px-2 py-1 text-[10px] font-medium text-text-muted transition-smooth hover:bg-bg-tertiary hover:text-text-primary"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSubmitEdited}
                disabled={!editValue.trim()}
                className="rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[10px] font-medium text-accent transition-smooth hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('msg.editResend')}
              </button>
            </div>
          </div>
        )}
      </div>
      <UserAvatar size="w-8 h-8 text-xs" className="mt-0.5" />
    </div>
  );
}

/* ================================================================
   CommandFeedbackMsg — rich UI for slash command results
   Renders mode switches, info cards, help lists, action feedback
   ================================================================ */
function CommandFeedbackMsg({ message }: Props) {
  const t = useT();
  const cType = message.commandType;
  const data = message.commandData || {};

  // --- Mode switch: animated pill with icon ---
  if (cType === 'mode') {
    const modeColors: Record<string, string> = {
      ask: 'from-blue-500/15 to-blue-400/5 border-blue-400/30 text-blue-400',
      plan: 'from-amber-500/15 to-amber-400/5 border-amber-400/30 text-amber-400',
      code: 'from-emerald-500/15 to-emerald-400/5 border-emerald-400/30 text-emerald-400',
    };
    const colorClass = modeColors[data.mode] || modeColors.code;
    return (
      <div className="flex justify-center my-2 animate-fade-in">
        <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full
          bg-gradient-to-r ${colorClass} border
          shadow-sm transition-all duration-300`}>
          <span className="text-base">{data.icon}</span>
          <span className="text-xs font-medium">{safeContent(message.content)}</span>
        </div>
      </div>
    );
  }

  // --- Model switch: centered pill ---
  if (cType === 'model-switch') {
    return (
      <div className="flex justify-center my-2 animate-fade-in">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full
          border border-border-subtle text-text-tertiary text-[11px]">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0 opacity-60">
            <path d="M4 6l4-4 4 4M4 10l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {safeContent(message.content)}
        </div>
      </div>
    );
  }

  // --- Info card: structured key-value table or preformatted text ---
  if (cType === 'info') {
    const rows: Array<{ label: string; value: string }> = data.rows || [];

    // Preformatted output (e.g. CLI command results)
    if (data.preformatted) {
      return (
        <div className="ml-11 my-1 animate-fade-in">
          <div className="rounded-lg border border-border-subtle
            bg-bg-secondary/50 overflow-hidden max-w-md">
            <div className="flex items-center gap-2 px-3 py-1.5
              border-b border-border-subtle/50 bg-bg-tertiary/30">
              <span className="text-[10px] font-mono text-text-tertiary">{data.command}</span>
            </div>
            <pre className="px-3 py-2 text-[11px] font-mono text-text-primary
              whitespace-pre-wrap break-words overflow-x-auto max-h-60 overflow-y-auto">
              {safeContent(message.content)}
            </pre>
          </div>
        </div>
      );
    }

    return (
      <div className="ml-11 my-1 animate-fade-in">
        <div className="inline-block rounded-lg border border-border-subtle
          bg-bg-secondary/50 overflow-hidden max-w-xs">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-1.5
            border-b border-border-subtle/50 bg-bg-tertiary/30">
            <span className="text-xs font-semibold text-text-primary">
              {data.title || safeContent(message.content)}
            </span>
          </div>
          {/* Rows */}
          {rows.length > 0 ? (
            <div className="divide-y divide-border-subtle/30">
              {rows.map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-4 px-3 py-1.5">
                  <span className="text-[11px] text-text-tertiary">{row.label}</span>
                  <span className={`text-[11px] font-mono font-medium
                    ${row.value === '—' ? 'text-text-tertiary/50' : 'text-text-primary'}`}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-2 text-[11px] text-text-tertiary italic">
              {t('cmd.noSessionData')}
            </div>
          )}
          {/* Hint */}
          {data.hint && (
            <div className="px-3 py-1.5 border-t border-border-subtle/50
              text-[10px] text-text-tertiary/70">
              {data.hint}
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Help: formatted command list ---
  if (cType === 'help') {
    const builtins: Array<{ name: string; desc: string }> = data.builtins || [];
    return (
      <div className="ml-11 my-1 animate-fade-in">
        <div className="rounded-lg border border-border-subtle
          bg-bg-secondary/50 overflow-hidden max-w-md">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-1.5
            border-b border-border-subtle/50 bg-bg-tertiary/30">
            <span className="text-xs">📖</span>
            <span className="text-xs font-semibold text-text-primary">
              {safeContent(message.content)}
            </span>
          </div>
          {/* Built-in commands */}
          <div className="p-2 space-y-0.5">
            {builtins.map((cmd, i) => (
              <div key={i} className="flex items-baseline gap-2 px-1.5 py-0.5
                rounded hover:bg-bg-tertiary/40 transition-colors">
                <code className="text-[11px] font-mono text-accent font-medium w-20 flex-shrink-0">
                  {cmd.name}
                </code>
                <span className="text-[11px] text-text-muted truncate">
                  {cmd.desc}
                </span>
              </div>
            ))}
          </div>
          {/* Footer stats */}
          <div className="flex items-center gap-3 px-3 py-1.5
            border-t border-border-subtle/50 text-[10px] text-text-tertiary">
            <span>{t('cmd.helpCustom')}: {data.customCount ?? 0}</span>
            <span>•</span>
            <span>{t('cmd.helpSkills')}: {data.skillCount ?? 0}</span>
          </div>
        </div>
      </div>
    );
  }

  // --- Action feedback: inline with icon/spinner ---
  if (cType === 'action') {
    return (
      <div className="flex justify-center my-1.5 animate-fade-in">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg
          bg-bg-secondary/60 border border-border-subtle text-[11px] text-text-muted">
          {data.loading ? (
            <span className="w-3 h-3 border-2 border-accent/30 border-t-accent
              rounded-full animate-spin" />
          ) : (
            <span className="text-sm">✓</span>
          )}
          <span>{safeContent(message.content)}</span>
        </div>
      </div>
    );
  }

  // --- Error feedback ---
  if (cType === 'error') {
    return (
      <div className="flex justify-center my-1.5 animate-fade-in">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg
          bg-red-500/5 border border-red-500/20 text-[11px] text-red-400">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
            <circle cx="6" cy="6" r="5" />
            <path d="M6 4v2.5M6 8v.5" />
          </svg>
          <span>{safeContent(message.content)}</span>
        </div>
      </div>
    );
  }

  // Fallback: render as plain text
  return (
    <div className="flex justify-center my-1 animate-fade-in">
      <span className="text-[11px] text-text-tertiary">{safeContent(message.content)}</span>
    </div>
  );
}

/* ================================================================
   AssistantMsg — markdown with avatar (uses shared MarkdownRenderer)
   ================================================================ */
function AssistantMsg({ message, isFirstInGroup = true }: Props) {
  return (
    <div className="flex gap-3">
      {/* Avatar: show only for the first message in a consecutive group */}
      {isFirstInGroup ? (
        <AiAvatar size="w-8 h-8" className="mt-0.5" />
      ) : (
        <div className="w-8 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0 text-base text-text-primary leading-relaxed">
        <MarkdownRenderer content={safeContent(message.content)} />
      </div>
    </div>
  );
}

/* ================================================================
   ToolUseMsg — inline collapsible, no card
   Enhanced display for Edit/Write/Read with diff stats, file icons
   ================================================================ */

/** Compute line diff stats from Edit tool input (common prefix/suffix algorithm) */
function computeEditDiff(input: any): { added: number; removed: number } | null {
  if (!input?.old_string || !input?.new_string) return null;
  const oldLines: string[] = input.old_string.split('\n');
  const newLines: string[] = input.new_string.split('\n');

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length
         && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (from remaining after prefix)
  let suffixLen = 0;
  while (suffixLen < oldLines.length - prefixLen
         && suffixLen < newLines.length - prefixLen
         && oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
    suffixLen++;
  }

  return {
    added: Math.max(0, newLines.length - prefixLen - suffixLen),
    removed: Math.max(0, oldLines.length - prefixLen - suffixLen),
  };
}

/** Compute lines for Write tool input */
function computeWriteLines(input: any): number | null {
  if (!input?.content) return null;
  return input.content.split('\n').length;
}

/** Get short filename from path */
function shortPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || filePath;
}

function FilePathActions({ filePath, compact = false }: { filePath: string; compact?: boolean }) {
  return (
    <span className={`inline-flex items-center ${compact ? 'gap-1' : 'gap-1.5'} min-w-0 max-w-full`}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          previewFilePath(filePath);
        }}
        className={`min-w-0 truncate text-left font-mono transition-smooth ${
          compact
            ? 'text-[10px] text-accent/70 hover:text-accent hover:underline max-w-[220px]'
            : 'text-[11px] text-accent/70 hover:text-accent hover:underline max-w-[280px]'
        }`}
        title={filePath}
      >
        {shortPath(filePath)}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          previewFilePath(filePath);
        }}
        className="inline-flex items-center rounded-md border border-border-subtle
          bg-bg-secondary/70 hover:bg-bg-tertiary transition-smooth px-1.5 py-0.5 text-[10px]"
      >
        {"\u9884\u89c8"}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          revealFilePath(filePath);
        }}
        className="inline-flex items-center rounded-md border border-border-subtle
          bg-bg-secondary/70 hover:bg-bg-tertiary transition-smooth px-1.5 py-0.5 text-[10px]"
        aria-label={"\u6587\u4ef6\u5939"}
        title={"\u6587\u4ef6\u5939"}
      >
        {"\u6587\u4ef6\u5939"}
      </button>
    </span>
  );
}
function SnapshotPanel({
  title,
  content,
  tone = 'neutral',
  emptyLabel,
}: {
  title: string;
  content: string;
  tone?: 'before' | 'after' | 'neutral';
  emptyLabel?: string;
}) {
  const toneClass = tone === 'before'
    ? 'border-red-500/20 bg-red-500/6'
    : tone === 'after'
      ? 'border-emerald-500/20 bg-emerald-500/6'
      : 'border-border-subtle bg-bg-secondary/50';

  return (
    <div className={`rounded-xl border overflow-hidden ${toneClass}`}>
      <div className="px-3 py-2 border-b border-border-subtle/50 text-[11px] font-medium text-text-primary">
        {title}
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all text-text-secondary">
        {content || emptyLabel || ''}
      </pre>
    </div>
  );
}

function previewDiffLines(content: string, maxLines = 8): string[] {
  const lines = content.split('\n');
  const normalized = lines.filter((line, index, arr) => !(arr.length === 1 && index === 0 && line === ''));
  return normalized.slice(0, maxLines);
}

function HoverChangePreview({
  filePath,
  beforeContent,
  afterContent,
  added,
  removed,
  isWriteTool,
}: {
  filePath: string;
  beforeContent: string;
  afterContent: string;
  added: number;
  removed: number;
  isWriteTool: boolean;
}) {
  const removedLines = isWriteTool ? [] : previewDiffLines(beforeContent);
  const addedLines = previewDiffLines(afterContent);
  const hiddenRemoved = Math.max(0, beforeContent.split('\n').filter((line, index, arr) => !(arr.length === 1 && index === 0 && line === '')).length - removedLines.length);
  const hiddenAdded = Math.max(0, afterContent.split('\n').filter((line, index, arr) => !(arr.length === 1 && index === 0 && line === '')).length - addedLines.length);

  return (
    <div className="relative inline-flex max-w-full">
      <span className="cursor-default text-[11px] text-text-tertiary transition-smooth hover:text-text-primary">
        查看更改
      </span>
      <div className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-[680px] max-w-[calc(100vw-5rem)] overflow-hidden rounded-2xl border border-border-subtle bg-bg-card/98 opacity-0 shadow-2xl transition-all duration-150 group-hover/change-preview:pointer-events-auto group-hover/change-preview:opacity-100">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle/60 bg-bg-secondary/75 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-[11px] font-mono text-text-primary" title={filePath}>
              {filePath}
            </div>
            <div className="mt-1 text-[10px] text-text-tertiary">
              鼠标移入可快速查看本次改动内容
            </div>
          </div>
          <div className="inline-flex flex-shrink-0 items-center gap-2 text-[11px] font-mono">
            <span className="text-success">+{added}</span>
            <span className="text-error">-{removed}</span>
          </div>
        </div>

        <div className="max-h-[360px] overflow-auto">
          {removedLines.map((line, index) => (
            <div key={`hover-removed-${index}`} className="flex items-start gap-0 bg-red-500/8 text-[11px] font-mono leading-relaxed">
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
            <div className="border-t border-red-500/10 bg-red-500/5 px-3 py-1.5 text-[10px] font-mono text-red-400/80">
              ... -{hiddenRemoved} more lines
            </div>
          )}
          {addedLines.map((line, index) => (
            <div key={`hover-added-${index}`} className="flex items-start gap-0 bg-emerald-500/8 text-[11px] font-mono leading-relaxed">
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
            <div className="border-t border-emerald-500/10 bg-emerald-500/5 px-3 py-1.5 text-[10px] font-mono text-emerald-500/80">
              ... +{hiddenAdded} more lines
            </div>
          )}
          {removedLines.length === 0 && addedLines.length === 0 && (
            <div className="px-3 py-4 text-xs text-text-tertiary">
              当前没有可显示的改动片段。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Tool icon mini SVG */
function ToolIcon({ name }: { name: string }) {
  switch (name) {
    case 'Bash':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <rect x="1" y="2" width="10" height="8" rx="1.5" />
          <path d="M3.5 5.5L5 7l-1.5 1.5M6.5 8.5h2" />
        </svg>
      );
    case 'Read':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
          <path d="M7 1v3h3M4 6.5h4M4 8.5h2" />
        </svg>
      );
    case 'Write':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-accent/70 flex-shrink-0">
          <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
          <path d="M7 1v3h3" />
          <path d="M5 7l1.5-1.5L8 7M6.5 5.5v4" strokeLinecap="round" />
        </svg>
      );
    case 'Edit':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-accent/70 flex-shrink-0">
          <path d="M8.5 1.5l2 2-6.5 6.5H2V8L8.5 1.5z" />
          <path d="M7 3l2 2" />
        </svg>
      );
    case 'Glob':
    case 'Grep':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <circle cx="5.5" cy="5.5" r="3" />
          <path d="M8 8l2.5 2.5" />
        </svg>
      );
    case 'Task':
    case 'Agent':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5v5M3.5 6h5" />
        </svg>
      );
    case 'WebFetch':
    case 'WebSearch':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <circle cx="6" cy="6" r="4.5" />
          <path d="M1.5 6h9M6 1.5c-1.5 1.5-2 3-2 4.5s.5 3 2 4.5M6 1.5c1.5 1.5 2 3 2 4.5s-.5 3-2 4.5" />
        </svg>
      );
    default:
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-text-tertiary flex-shrink-0">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
          <path d="M4.5 5l1.5 1.5L7.5 5" />
        </svg>
      );
  }
}

function getToolLabel(name: string, t: (key: string) => string): string {
  switch (name) {
    case 'Bash': return t('msg.terminal');
    case 'Read': return t('msg.readFile');
    case 'Write': return t('msg.writeFile');
    case 'Edit': return t('msg.editFile');
    case 'Glob': case 'Grep': return t('msg.search');
    case 'Task': case 'Agent': return t('msg.subAgent');
    case 'TodoWrite': return t('msg.todo');
    case 'WebFetch': case 'WebSearch': return t('msg.webFetch');
    case 'ExitPlanMode': case 'EnterPlanMode': return t('msg.planLabel');
    default: return name;
  }
}

export const ToolUseMsg = memo(function ToolUseMsg({ message }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [editViewMode, setEditViewMode] = useState<'diff' | 'before' | 'after'>('diff');
  const [diffLayout, setDiffLayout] = useState<'unified' | 'split'>('unified');
  const [showFileSnapshot, setShowFileSnapshot] = useState(false);
  const [showViewOptions, setShowViewOptions] = useState(false);
  const viewOptionsRef = useRef<HTMLDivElement | null>(null);
  const toolName = message.toolName || 'Tool';
  const label = getToolLabel(toolName, t);
  const input = message.toolInput;
  const filePath = input?.file_path ? String(input.file_path) : '';
  const isEditTool = toolName === 'Edit' && !!input?.file_path;
  const isWriteTool = toolName === 'Write' && !!input?.file_path;
  const isEditCard = isEditTool || isWriteTool;
  const beforeContent = isEditTool ? String(input?.old_string || '') : '';
  const afterContent = isEditTool ? String(input?.new_string || '') : String(input?.content || '');

  useEffect(() => {
    if (!showViewOptions) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (viewOptionsRef.current && !viewOptionsRef.current.contains(event.target as Node)) {
        setShowViewOptions(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showViewOptions]);

  // Compute diff stats for Edit tool
  const editDiff = toolName === 'Edit' ? computeEditDiff(input) : null;
  // Compute line count for Write tool
  const writeLines = toolName === 'Write' ? computeWriteLines(input) : null;

  // Build preview content based on tool type
  const renderPreview = () => {
    if (toolName === 'Bash' && input?.command) {
      return (
        <span className="text-[11px] text-text-tertiary truncate
          font-mono max-w-[350px] bg-bg-secondary/60 px-1.5 py-0.5 rounded">
          {input.command.length > 80 ? input.command.slice(0, 80) + '…' : input.command}
        </span>
      );
    }

    if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && input?.file_path) {
      return (
        <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full flex-wrap">
          <FilePathActions filePath={input.file_path} />
          {/* Diff stats for Edit */}
          {editDiff && (
            <span className="inline-flex items-center gap-1 ml-0.5">
              <span className="text-[10px] font-mono text-success">+{editDiff.added}</span>
              <span className="text-[10px] font-mono text-error">-{editDiff.removed}</span>
            </span>
          )}
          {/* Line count for Write */}
          {writeLines !== null && (
            <span className="text-[10px] font-mono text-success ml-0.5">
              +{writeLines}
            </span>
          )}
        </span>
      );
    }

    if ((toolName === 'Glob' || toolName === 'Grep') && input?.pattern) {
      return (
        <span className="text-[11px] text-text-tertiary truncate
          font-mono max-w-[300px]">
          {input.pattern}
        </span>
      );
    }

    if ((toolName === 'Task' || toolName === 'Agent') && input?.description) {
      return (
        <span className="text-[11px] text-text-tertiary truncate max-w-[300px] italic">
          {input.description}
        </span>
      );
    }

    if (toolName === 'TeamCreate' && (input?.team_name || input?.name)) {
      return (
        <span className="text-[11px] text-text-tertiary truncate max-w-[300px] italic">
          Team: {input.team_name || input.name}
        </span>
      );
    }

    if (toolName === 'TaskCreate' && (input?.subject || input?.description)) {
      return (
        <span className="text-[11px] text-text-tertiary truncate max-w-[300px] italic">
          {input.subject || input.description}
        </span>
      );
    }

    if (toolName === 'SendMessage' && input?.recipient) {
      return (
        <span className="text-[11px] text-text-tertiary truncate max-w-[300px] italic">
          &rarr; {input.recipient}
        </span>
      );
    }

    if ((toolName === 'WebFetch' || toolName === 'WebSearch') && (input?.url || input?.query)) {
      const display = input.url || input.query;
      return (
        <span className="text-[11px] text-accent/70 truncate max-w-[300px] font-mono">
          {display}
        </span>
      );
    }

    return null;
  };

  // Determine if input has meaningful content (not empty {} or null)
  const hasInput = input && typeof input === 'object'
    ? Object.keys(input).length > 0
    : !!input;

  // Whether there's a result to show
  const resultContent = typeof message.toolResultContent === 'string'
    ? message.toolResultContent
    : message.toolResultContent ? JSON.stringify(message.toolResultContent) : '';
  const hasResult = resultContent.length > 0;

  const renderDiffColumn = useCallback((
    title: string,
    lines: string[],
    tone: 'removed' | 'added',
    emptyLabel: string,
  ) => {
    const displayLines = lines.slice(0, 120);
    const hiddenCount = Math.max(0, lines.length - displayLines.length);
    const isRemoved = tone === 'removed';
    const rowClass = isRemoved ? 'bg-red-500/8' : 'bg-emerald-500/8';
    const lineNoClass = isRemoved
      ? 'text-red-400/70 border-r border-red-500/15'
      : 'text-emerald-500/70 border-r border-emerald-500/15';
    const markerClass = isRemoved ? 'text-red-400' : 'text-emerald-500';
    const textClass = isRemoved ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400';

    return (
      <div className="min-w-0 overflow-hidden rounded-xl border border-border-subtle bg-bg-card/85">
        <div className="border-b border-border-subtle/50 bg-bg-secondary/55 px-3 py-2 text-[11px] font-medium text-text-primary">
          {title}
        </div>
        {displayLines.length > 0 ? (
          <div className="max-h-64 overflow-auto">
            {displayLines.map((line: string, index: number) => (
              <div key={`${tone}-${index}`} className={`flex items-start gap-0 text-[11px] font-mono leading-relaxed ${rowClass}`}>
                <span className={`flex-shrink-0 w-8 select-none pr-2 text-right ${lineNoClass}`}>
                  {index + 1}
                </span>
                <span className={`flex-shrink-0 w-5 text-center select-none ${markerClass}`}>
                  {isRemoved ? '-' : '+'}
                </span>
                <span className={`flex-1 px-1 whitespace-pre-wrap break-all ${textClass}`}>
                  {line || '\u00A0'}
                </span>
              </div>
            ))}
            {hiddenCount > 0 && (
              <div className={`border-t px-2 py-1 text-[10px] font-mono ${isRemoved ? 'border-red-500/10 bg-red-500/5 text-red-400/80' : 'border-emerald-500/10 bg-emerald-500/5 text-emerald-500/80'}`}>
                ... {isRemoved ? '-' : '+'}{hiddenCount} more lines
              </div>
            )}
          </div>
        ) : (
          <div className="px-3 py-4 text-xs text-text-tertiary">{emptyLabel}</div>
        )}
      </div>
    );
  }, []);

  const renderSplitEditDiff = useCallback(() => {
    const oldLines = (input?.old_string || '').split('\n').filter((line: string, index: number, arr: string[]) => !(arr.length === 1 && index === 0 && line === ''));
    const newLines = (input?.new_string || '').split('\n').filter((line: string, index: number, arr: string[]) => !(arr.length === 1 && index === 0 && line === ''));
    return (
      <div className="grid gap-3 lg:grid-cols-2">
        {renderDiffColumn('删除内容', oldLines, 'removed', '没有删除内容')}
        {renderDiffColumn('新增内容', newLines, 'added', '没有新增内容')}
      </div>
    );
  }, [input?.new_string, input?.old_string, renderDiffColumn]);

  const renderSplitWriteDiff = useCallback(() => {
    const newLines = (input?.content || '').split('\n').filter((line: string, index: number, arr: string[]) => !(arr.length === 1 && index === 0 && line === ''));
    return (
      <div className="grid gap-3 lg:grid-cols-2">
        {renderDiffColumn('删除内容', [], 'removed', '这个生成没有删除内容')}
        {renderDiffColumn('新增内容', newLines, 'added', '没有新增内容')}
      </div>
    );
  }, [input?.content, renderDiffColumn]);

  const renderCurrentFilePanel = useCallback(() => (
    <SnapshotPanel
      title="当前文件"
      content={afterContent}
      tone="after"
      emptyLabel="暂无可显示的文件内容"
    />
  ), [afterContent]);

  const handleOpenPreview = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!filePath) return;
    previewFilePath(filePath);
  }, [filePath]);

  const handleRevealFolder = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!filePath) return;
    revealFilePath(filePath);
  }, [filePath]);

  const handleJumpToFile = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!filePath) return;
    jumpToFilePath(filePath);
  }, [filePath]);

  const handleToggleSplitDiff = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setExpanded(true);
    setEditViewMode('diff');
    setDiffLayout((current) => current === 'split' ? 'unified' : 'split');
  }, []);

  const handleToggleShowFile = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setExpanded(true);
    setShowFileSnapshot((current) => !current);
  }, []);

  // Render the expanded detail section
  /** Render a side-by-side diff view for Edit tool old_string → new_string */
  const renderEditDiff = () => {
    if (!input?.old_string && !input?.new_string) return null;
    const oldLines = (input.old_string || '').split('\n');
    const newLines = (input.new_string || '').split('\n');

    return (
      <div key="diff" className="rounded-lg border border-border-subtle overflow-hidden
        max-h-48 overflow-y-auto">
        {/* Removed lines */}
        {oldLines.length > 0 && oldLines[0] !== '' && (
          <div>
            {oldLines.map((line: string, i: number) => (
              <div key={`old-${i}`}
                className="flex items-start gap-0 text-[11px] font-mono leading-relaxed
                  bg-red-500/8 dark:bg-red-500/10">
                <span className="flex-shrink-0 w-8 text-right pr-2 text-red-400/60
                  select-none border-r border-red-500/10">
                  {i + 1}
                </span>
                <span className="flex-shrink-0 w-5 text-center text-red-400 select-none">−</span>
                <span className="text-red-600 dark:text-red-400 whitespace-pre-wrap break-all
                  flex-1 px-1">{line}</span>
              </div>
            ))}
          </div>
        )}
        {/* Added lines */}
        {newLines.length > 0 && newLines[0] !== '' && (
          <div>
            {newLines.map((line: string, i: number) => (
              <div key={`new-${i}`}
                className="flex items-start gap-0 text-[11px] font-mono leading-relaxed
                  bg-emerald-500/8 dark:bg-emerald-500/10">
                <span className="flex-shrink-0 w-8 text-right pr-2 text-emerald-500/70
                  select-none border-r border-emerald-500/15">
                  {i + 1}
                </span>
                <span className="flex-shrink-0 w-5 text-center text-emerald-500 select-none">+</span>
                <span className="text-emerald-700 dark:text-emerald-400 whitespace-pre-wrap break-all
                  flex-1 px-1">{line}</span>
              </div>
            ))}
          </div>
        )}
        {/* File path */}
        {input.file_path && (
          <div className="flex items-center justify-between gap-2 px-2 py-1 border-t border-border-subtle/50">
            <span className="min-w-0 flex-1 truncate text-[10px] text-text-tertiary font-mono" title={input.file_path}>
              {input.file_path}
            </span>
            <FilePathActions filePath={input.file_path} compact />
          </div>
        )}
      </div>
    );
  };

  /** Render a Write tool diff — all lines shown as additions (blue) */
  const renderWriteDiff = () => {
    if (!input?.content) return null;
    const allLines = input.content.split('\n');
    const maxDisplay = 20;
    const displayLines = allLines.slice(0, maxDisplay);
    const remaining = allLines.length - maxDisplay;

    return (
      <div key="write-diff" className="rounded-lg border border-border-subtle overflow-hidden
        max-h-48 overflow-y-auto">
        {displayLines.map((line: string, i: number) => (
          <div key={i}
            className="flex items-start gap-0 text-[11px] font-mono leading-relaxed
              bg-emerald-500/8 dark:bg-emerald-500/10">
            <span className="flex-shrink-0 w-8 text-right pr-2 text-emerald-500/70
              select-none border-r border-emerald-500/15">
              {i + 1}
            </span>
            <span className="flex-shrink-0 w-5 text-center text-emerald-500 select-none">+</span>
            <span className="text-emerald-700 dark:text-emerald-400 whitespace-pre-wrap break-all
              flex-1 px-1">{line}</span>
          </div>
        ))}
        {remaining > 0 && (
          <div className="px-2 py-1 text-[10px] font-mono text-emerald-500/80
            bg-emerald-500/5 border-t border-emerald-500/10">
            ... +{remaining} more lines
          </div>
        )}
        {input.file_path && (
          <div className="flex items-center justify-between gap-2 px-2 py-1 border-t border-border-subtle/50">
            <span className="min-w-0 flex-1 truncate text-[10px] text-text-tertiary font-mono" title={input.file_path}>
              {input.file_path}
            </span>
            <FilePathActions filePath={input.file_path} compact />
          </div>
        )}
      </div>
    );
  };

  const renderExpandedContent = () => {
    const sections: React.ReactNode[] = [];

    // Show tool input (if meaningful)
    if (hasInput) {
      if (toolName === 'Bash' && input?.command) {
        sections.push(
          <div key="cmd" className="flex items-start gap-1.5">
            <span className="text-text-tertiary/60 text-[11px] font-mono select-none">$</span>
            <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap break-all">
              {input.command}
            </pre>
          </div>
        );
      } else if (toolName === 'Edit' && (input?.old_string || input?.new_string)) {
        sections.push(
          <div key="edit-review" className="space-y-2">
            <div className="hidden">
              <button
                onClick={() => setEditViewMode('diff')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-smooth ${
                  editViewMode === 'diff'
                    ? 'bg-accent/12 text-accent border border-accent/20'
                    : 'bg-bg-secondary/70 text-text-tertiary border border-border-subtle hover:bg-bg-tertiary'
                }`}
              >
                差异
              </button>
              <button
                onClick={() => setEditViewMode('before')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-smooth ${
                  editViewMode === 'before'
                    ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                    : 'bg-bg-secondary/70 text-text-tertiary border border-border-subtle hover:bg-bg-tertiary'
                }`}
              >
                修改前
              </button>
              <button
                onClick={() => setEditViewMode('after')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-smooth ${
                  editViewMode === 'after'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-bg-secondary/70 text-text-tertiary border border-border-subtle hover:bg-bg-tertiary'
                }`}
              >
                修改后
              </button>
            </div>
            {editViewMode === 'diff'
              ? (diffLayout === 'split' ? renderSplitEditDiff() : renderEditDiff())
              : editViewMode === 'before'
                ? (
                  <SnapshotPanel
                    title="修改前内容"
                    content={beforeContent}
                    tone="before"
                    emptyLabel="修改前为空"
                  />
                )
                : (
                  <SnapshotPanel
                    title="修改后内容"
                    content={afterContent}
                    tone="after"
                    emptyLabel="修改后为空"
                  />
                )}
            {showFileSnapshot && editViewMode !== 'after' && renderCurrentFilePanel()}
          </div>,
        );
      } else if (toolName === 'Write' && input?.content) {
        sections.push(
          <div key="write-review" className="space-y-2">
            <div className="hidden">
              <button
                onClick={() => setEditViewMode('after')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-smooth ${
                  editViewMode === 'after'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-bg-secondary/70 text-text-tertiary border border-border-subtle hover:bg-bg-tertiary'
                }`}
              >
                修改后
              </button>
              <button
                onClick={() => setEditViewMode('diff')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-smooth ${
                  editViewMode === 'diff'
                    ? 'bg-accent/12 text-accent border border-accent/20'
                    : 'bg-bg-secondary/70 text-text-tertiary border border-border-subtle hover:bg-bg-tertiary'
                }`}
              >
                审阅
              </button>
            </div>
            {editViewMode === 'after'
              ? (
                <SnapshotPanel
                  title="生成内容"
                  content={afterContent}
                  tone="after"
                  emptyLabel="暂无生成内容"
                />
              )
              : (diffLayout === 'split' ? renderSplitWriteDiff() : renderWriteDiff())}
            {showFileSnapshot && editViewMode !== 'after' && renderCurrentFilePanel()}
          </div>,
        );
      } else {
        sections.push(
          <pre key="input" className="text-[11px] text-text-tertiary
            overflow-x-auto font-mono leading-relaxed
            max-h-32 overflow-y-auto whitespace-pre-wrap">
            {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
          </pre>
        );
      }
    }

    // Show result content
    if (hasResult) {
      if (hasInput) {
        // Divider between input and result
        sections.push(
          <div key="divider" className="border-t border-border-subtle/50 my-1" />
        );
      }
      sections.push(
        <pre key="result" className="text-[11px] text-text-tertiary
          overflow-x-auto font-mono leading-relaxed
          max-h-48 overflow-y-auto whitespace-pre-wrap">
          {resultContent}
        </pre>
      );
    }

    return sections.length > 0 ? sections : null;
  };

  // Determine if expand makes sense
  const canExpand = hasInput || hasResult;
  const depth = message.subAgentDepth ?? 0;
  const containerClass = depth > 0 ? 'ml-16 pl-3 border-l-2 border-accent/15' : 'ml-11';

  if (isEditCard) {
    const badgeLabel = isWriteTool ? '已创建' : '已编辑';
    const reviewLabel = isWriteTool ? '审阅' : '差异';
    const displayBadgeLabel = isWriteTool ? '已创建' : '已编辑';
    const displayReviewLabel = isWriteTool ? '审阅' : '差异';
    void badgeLabel;
    void reviewLabel;
    const statNode = editDiff
      ? (
        <span className="inline-flex items-center gap-1 ml-0.5">
          <span className="text-[10px] font-mono text-success">+{editDiff.added}</span>
          <span className="text-[10px] font-mono text-error">-{editDiff.removed}</span>
        </span>
      )
      : writeLines !== null
        ? <span className="text-[10px] font-mono text-success">+{writeLines}</span>
        : null;

    return (
      <div className={containerClass}>
        <div className="rounded-2xl border border-border-subtle bg-bg-card/88 shadow-sm overflow-hidden">
          <div
            className={`flex items-start justify-between gap-3 px-3 py-3 ${
              canExpand ? 'cursor-pointer' : ''
            }`}
            onClick={() => canExpand && setExpanded(!expanded)}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-border-subtle bg-bg-secondary/70 px-2 py-0.5 text-[10px] font-semibold text-text-primary">
                  {displayBadgeLabel}
                </span>
                {statNode}
              </div>
              <div className="mt-2 min-w-0">
                <FilePathActions filePath={input.file_path} />
              </div>
              <div className="group/change-preview relative mt-1.5 inline-flex items-center gap-1 text-[11px]">
                <HoverChangePreview
                  filePath={input.file_path}
                  beforeContent={beforeContent}
                  afterContent={afterContent}
                  added={editDiff?.added ?? writeLines ?? 0}
                  removed={editDiff?.removed ?? 0}
                  isWriteTool={isWriteTool}
                />
                <span className="text-text-tertiary">↗</span>
              </div>
            </div>
            {canExpand ? (
              <svg width="12" height="12" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.5"
                className={`mt-1 flex-shrink-0 text-text-tertiary transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>
                <path d="M3 2l4 3-4 3" />
              </svg>
            ) : null}
          </div>

          <div className="hidden">
            <button
              onClick={handleOpenPreview}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium border border-border-subtle bg-bg-secondary/70 text-text-secondary hover:bg-bg-tertiary transition-smooth"
            >
              预览
            </button>
            <button
              onClick={handleRevealFolder}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium border border-border-subtle bg-bg-secondary/70 text-text-secondary hover:bg-bg-tertiary transition-smooth"
            >
              文件夹
            </button>
            <button
              onClick={handleToggleShowFile}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-smooth ${
                showFileSnapshot
                  ? 'border-accent/20 bg-accent/10 text-accent'
                  : 'border-border-subtle bg-bg-secondary/70 text-text-secondary hover:bg-bg-tertiary'
              }`}
            >
              {showFileSnapshot ? '隐藏文件' : '显示文件'}
            </button>
            <button
              onClick={handleJumpToFile}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium border border-border-subtle bg-bg-secondary/70 text-text-secondary hover:bg-bg-tertiary transition-smooth"
            >
              跳转到文件
            </button>
            <button
              onClick={handleToggleSplitDiff}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-smooth ${
                diffLayout === 'split'
                  ? 'border-accent/20 bg-accent/10 text-accent'
                  : 'border-border-subtle bg-bg-secondary/70 text-text-secondary hover:bg-bg-tertiary'
              }`}
            >
              {diffLayout === 'split' ? '统一差异' : '拆分差异'}
            </button>
            <div className="relative" ref={viewOptionsRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowViewOptions((current) => !current);
                }}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-smooth ${
                  showViewOptions
                    ? 'border-accent/20 bg-accent/10 text-accent'
                    : 'border-border-subtle bg-bg-secondary/70 text-text-secondary hover:bg-bg-tertiary'
                }`}
              >
                查看选项
              </button>
              {showViewOptions && (
                <div className="absolute left-0 top-full z-20 mt-2 min-w-[180px] rounded-xl border border-border-subtle bg-bg-card p-1.5 shadow-lg">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded(true);
                      setEditViewMode('diff');
                      setShowViewOptions(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[11px] text-text-primary transition-smooth hover:bg-bg-secondary"
                  >
                    <span>查看差异</span>
                    <span className="font-mono text-text-tertiary">{diffLayout === 'split' ? 'split' : 'unified'}</span>
                  </button>
                  {isEditTool && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded(true);
                        setEditViewMode('before');
                        setShowViewOptions(false);
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[11px] text-text-primary transition-smooth hover:bg-bg-secondary"
                    >
                      <span>修改前</span>
                      <span className="font-mono text-red-400">-</span>
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded(true);
                      setEditViewMode('after');
                      setShowViewOptions(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[11px] text-text-primary transition-smooth hover:bg-bg-secondary"
                  >
                    <span>{isWriteTool ? '文件内容' : '修改后'}</span>
                    <span className="font-mono text-emerald-500">+</span>
                  </button>
                </div>
              )}
            </div>
            {isEditTool && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditViewMode('before');
                  setExpanded(true);
                }}
                className="hidden px-2.5 py-1 rounded-lg text-[11px] font-medium border border-border-subtle bg-bg-secondary/70 text-text-secondary hover:bg-bg-tertiary transition-smooth"
              >
                修改前
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditViewMode('after');
                setExpanded(true);
              }}
              className="hidden px-2.5 py-1 rounded-lg text-[11px] font-medium border border-border-subtle bg-bg-secondary/70 text-text-secondary hover:bg-bg-tertiary transition-smooth"
            >
              {isWriteTool ? '内容' : '修改后'}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditViewMode(isWriteTool ? 'diff' : 'diff');
                setExpanded(true);
              }}
              className="hidden px-2.5 py-1 rounded-lg text-[11px] font-medium border border-accent/20 bg-accent/10 text-accent hover:bg-accent/15 transition-smooth"
            >
              {displayReviewLabel}
            </button>
            {!expanded && hasResult && (
              <span className="inline-flex items-center gap-1 text-[11px] text-success ml-auto">
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                  stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
                  <path d="M2.5 6l2.5 2.5 4.5-4.5" />
                </svg>
                已完成
              </span>
            )}
          </div>

          {expanded && (
            <div className="border-t border-border-subtle/60 px-3 py-3">
              {renderExpandedContent()}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      <button
        onClick={() => canExpand && setExpanded(!expanded)}
        className={`flex items-center gap-1.5 py-1 text-left group
          ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {canExpand ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className={`flex-shrink-0 text-text-tertiary transition-transform
              duration-150 ${expanded ? 'rotate-90' : ''}`}>
            <path d="M3 2l4 3-4 3" />
          </svg>
        ) : (
          <span className="w-[10px] flex-shrink-0" />
        )}
        <ToolIcon name={toolName} />
        <span className="text-xs font-medium text-text-muted">{label}</span>
        {renderPreview()}
        {/* Show a small result indicator when collapsed with result */}
        {!expanded && hasResult && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="text-success flex-shrink-0 ml-0.5">
            <path d="M2.5 6l2.5 2.5 4.5-4.5" />
          </svg>
        )}
      </button>
      {expanded && (
        <div className="ml-5 mt-0.5">
          {renderExpandedContent()}
        </div>
      )}
    </div>
  );
});

/* ================================================================
   ToolResultMsg — inline result
   ================================================================ */
function ToolResultMsg({ message }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const content = safeContent(message.content);
  const depth = message.subAgentDepth ?? 0;

  // Show a short one-line preview on the same line as the "Result" label
  const preview = content.length > 0
    ? content.split('\n')[0].slice(0, 60) + (content.length > 60 ? '…' : '')
    : '';

  return (
    <div className={depth > 0 ? 'ml-16 pl-3 border-l-2 border-accent/15' : 'ml-11'}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-0.5 cursor-pointer group"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform
            duration-150 ${expanded ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" className="text-success flex-shrink-0">
          <path d="M2.5 6l2.5 2.5 4.5-4.5" />
        </svg>
        <span className="text-[11px] text-text-tertiary">{t('msg.result')}</span>
        {!expanded && preview && (
          <span className="text-[11px] text-text-tertiary/60 font-mono truncate max-w-[300px]">
            {preview}
          </span>
        )}
      </button>
      {expanded && content && (
        <pre className="ml-5 mt-0.5 text-[11px] text-text-tertiary
          overflow-x-auto font-mono leading-relaxed
          max-h-48 overflow-y-auto whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </div>
  );
}

/* ================================================================
   ThinkingMsg — minimal collapsible
   ================================================================ */
function ThinkingMsg({ message }: Props) {
  const t = useT();
  return (
    <div className="ml-11">
      <details className="group">
        <summary className="flex items-center gap-1.5 py-1
          cursor-pointer text-[11px] text-text-tertiary list-none select-none">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="transition-transform duration-150 group-open:rotate-90">
            <path d="M3 2l4 3-4 3" />
          </svg>
          {t('msg.thinking')}
        </summary>
        <pre className="ml-5 mt-0.5 text-[11px] text-text-tertiary
          whitespace-pre-wrap max-h-48 overflow-y-auto
          font-mono leading-relaxed">
          {safeContent(message.content)}
        </pre>
      </details>
    </div>
  );
}

/* PermissionMsg — extracted to PermissionCard.tsx */

/* ================================================================
   PlanMsg — inline collapsible list (no card)
   ================================================================ */
function PlanMsg({ message }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const items = message.planItems || (typeof message.content === 'string' ? message.content.split('\n').filter(Boolean) : []);

  return (
    <div className="ml-11">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-1 cursor-pointer"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform
            duration-150 ${expanded ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
        <span className="text-xs font-medium text-text-muted">
          {t('msg.planTitle')}
        </span>
        <span className="text-[11px] text-text-tertiary">
          ({items.length} {t('msg.planSteps')})
        </span>
      </button>
      {expanded && (
        <div className="ml-5 mt-0.5 space-y-0.5">
          {items.map((item, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px] text-text-muted">
              <span className="flex-shrink-0 text-text-tertiary font-mono w-4 text-right">
                {i + 1}.
              </span>
              <span className="leading-relaxed">
                {item.replace(/^[\d]+\.\s*/, '').replace(/^[-•]\s*/, '')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   TodoMsg — tree-style with indent connector lines (Claude Code style)
   ================================================================ */
function TodoMsg({ message }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const items = Array.isArray(message.todoItems) ? message.todoItems : [];
  const completedCount = items.filter((i) => i.status === 'completed').length;
  const inProgressItem = items.find((i) => i.status === 'in_progress');

  return (
    <div className="ml-11">
      {/* Header — collapsible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-1 cursor-pointer text-left"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform
            duration-150 ${expanded ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
        <span className="text-xs font-bold text-text-primary">{t('msg.todo')}</span>
        <span className="text-[10px] text-text-tertiary">
          {completedCount}/{items.length}
        </span>
        {inProgressItem && (
          <span className="text-[10px] text-accent italic ml-1 truncate max-w-[200px]">
            {inProgressItem.activeForm || inProgressItem.content}
          </span>
        )}
      </button>
      {/* Tree-style checklist with connector lines */}
      {expanded && (
        <div className="ml-[7px] mt-0.5">
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <div key={i} className="flex items-stretch">
                {/* Connector line column */}
                <div className="flex flex-col items-center w-4 flex-shrink-0">
                  {/* Horizontal branch + vertical trunk */}
                  <div className="flex items-center h-5">
                    <div className={`w-px h-full ${isLast ? 'h-1/2 self-start' : ''}`}
                      style={{
                        background: 'var(--color-border)',
                        height: isLast ? '50%' : '100%',
                        alignSelf: isLast ? 'flex-start' : undefined,
                      }}
                    />
                    <div className="w-2 h-px" style={{ background: 'var(--color-border)' }} />
                  </div>
                  {/* Continuing trunk below (hidden for last item) */}
                  {!isLast && (
                    <div className="w-px flex-1" style={{ background: 'var(--color-border)' }} />
                  )}
                </div>
                {/* Status icon + text */}
                <div className="flex items-center gap-1.5 py-0.5 min-h-[20px]">
                  {item.status === 'completed' ? (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
                      className="flex-shrink-0">
                      <rect x="0.5" y="0.5" width="11" height="11" rx="2"
                        fill="var(--color-success)" fillOpacity="0.15"
                        stroke="var(--color-success)" strokeWidth="1" />
                      <path d="M3 6l2 2 4-4" stroke="var(--color-success)"
                        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  ) : item.status === 'in_progress' ? (
                    <span className="w-[11px] h-[11px] flex items-center justify-center flex-shrink-0">
                      <span className="w-2.5 h-2.5 rounded-full border-2 border-accent
                        bg-accent/20 animate-pulse-soft" />
                    </span>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
                      className="flex-shrink-0">
                      <rect x="0.5" y="0.5" width="11" height="11" rx="2"
                        fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1"
                        strokeOpacity="0.4" />
                    </svg>
                  )}
                  <span className={`text-[11px] leading-tight
                    ${item.status === 'completed'
                      ? 'text-text-tertiary line-through'
                      : item.status === 'in_progress'
                        ? 'text-text-primary font-medium'
                        : 'text-text-muted'
                    }`}>
                    {item.content}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* PlanReviewMsg — extracted to PlanReviewCard.tsx */

/* QuestionMsg — extracted to QuestionCard.tsx */
