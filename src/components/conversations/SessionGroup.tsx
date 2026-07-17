import { useMemo } from 'react';
import { SessionListItem } from '../../lib/tauri-bridge';
import { SessionItem } from './SessionItem';
import { useT } from '../../lib/i18n';

function getDateCategory(ms: number): 'today' | 'yesterday' | 'thisWeek' | 'earlier' {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const dayOfWeek = now.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = todayStart - daysToMonday * 86400000;

  if (ms >= todayStart) return 'today';
  if (ms >= yesterdayStart) return 'yesterday';
  if (ms >= weekStart) return 'thisWeek';
  return 'earlier';
}

interface SessionGroupProps {
  projectKey: string;
  projectLabel: string;
  projectPath: string;
  sessions: SessionListItem[];
  isExpanded: boolean;
  selectedId: string | null;
  runningSessions: Set<string>;
  pinnedSessions: Set<string>;
  archivedSessions: Set<string>;
  customPreviews: Record<string, string>;
  multiSelect: boolean;
  selectedIds: Set<string>;
  onToggleCollapse: (project: string) => void;
  onContextMenu: (e: React.MouseEvent, session: SessionListItem) => void;
  onDelete: (session: SessionListItem) => void;
  onProjectContextMenu: (e: React.MouseEvent, project: string) => void;
  onLoadSession: (session: SessionListItem) => void;
  onRename: (sessionId: string, newName: string) => void;
  onNewSession: (project: string) => void;
  onToggleCheck: (sessionId: string, shiftKey?: boolean) => void;
  renamingSessionId?: string | null;
  onRenameDone?: () => void;
  isSavedWorkspace?: boolean;
  isActiveWorkspace?: boolean;
  onActivateWorkspace?: (path: string) => void;
}

export function SessionGroup({
  projectKey,
  projectLabel: label,
  projectPath,
  sessions,
  isExpanded,
  selectedId,
  runningSessions,
  pinnedSessions,
  archivedSessions,
  customPreviews,
  multiSelect,
  selectedIds,
  onToggleCollapse,
  onContextMenu,
  onDelete,
  onProjectContextMenu,
  onLoadSession,
  onRename,
  onNewSession,
  onToggleCheck,
  renamingSessionId,
  onRenameDone,
  isSavedWorkspace = false,
  isActiveWorkspace = false,
  onActivateWorkspace,
}: SessionGroupProps) {
  const t = useT();

  const { pinnedItems, dateGroups } = useMemo(() => {
    const pinned: SessionListItem[] = [];
    const unpinned: SessionListItem[] = [];

    for (const session of sessions) {
      if (pinnedSessions.has(session.id)) {
        pinned.push(session);
      } else {
        unpinned.push(session);
      }
    }

    const groups: { category: string; label: string; items: SessionListItem[] }[] = [];
    const categoryMap = new Map<string, SessionListItem[]>();

    for (const session of unpinned) {
      const category = getDateCategory(session.modifiedAt);
      if (!categoryMap.has(category)) categoryMap.set(category, []);
      categoryMap.get(category)!.push(session);
    }

    const categoryOrder: Array<{ key: string; label: string }> = [
      { key: 'today', label: t('conv.today') },
      { key: 'yesterday', label: t('conv.yesterday') },
      { key: 'thisWeek', label: t('conv.thisWeek') },
      { key: 'earlier', label: t('conv.older') },
    ];

    for (const { key, label } of categoryOrder) {
      const items = categoryMap.get(key);
      if (items && items.length > 0) {
        groups.push({ category: key, label, items });
      }
    }

    return { pinnedItems: pinned, dateGroups: groups };
  }, [sessions, pinnedSessions, t]);

  const getDisplayName = (session: SessionListItem) =>
    customPreviews[session.id] || session.preview || '';

  const folderTone = isActiveWorkspace
    ? 'bg-accent/10'
    : 'bg-bg-card/45 hover:bg-bg-card/70';

  return (
    <div className="mb-2">
      <div
        onClick={() => onToggleCollapse(projectKey)}
        onContextMenu={(e) => onProjectContextMenu(e, projectKey)}
        className={`group w-full rounded-2xl transition-smooth ${folderTone}`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onToggleCollapse(projectKey);
        }}
      >
        <div className="flex items-start gap-2 px-3 py-2.5">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`mt-2 flex-shrink-0 text-accent transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          >
            <path d="M3 1l4 4-4 4" />
          </svg>

          <span
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
              isActiveWorkspace ? 'bg-accent text-text-inverse' : 'bg-bg-secondary text-text-muted'
            }`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2.5 4.5h4l1.2 1.5h5.8v6.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
            </svg>
          </span>

          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-text-primary">
                {label}
              </span>
              {isActiveWorkspace && (
                <span className="flex-shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.16em] text-accent">
                  当前
                </span>
              )}
              {!isActiveWorkspace && isSavedWorkspace && (
                <span className="flex-shrink-0 rounded-full bg-bg-secondary/80 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.16em] text-text-tertiary">
                  工作区
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-text-tertiary">
              {sessions.length > 0 ? `${sessions.length} ${t('conv.sessions')}` : '暂无会话'}
            </div>
          </div>

          <div className="ml-auto flex flex-shrink-0 items-center gap-1 self-center">
            {onActivateWorkspace && !isActiveWorkspace && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onActivateWorkspace(projectPath);
                }}
                className="rounded-lg px-2 py-1 text-[10px] font-medium text-text-tertiary transition-smooth hover:bg-bg-secondary hover:text-text-primary"
                title="切换工作区"
              >
                切换
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onNewSession(projectKey);
              }}
              className="flex-shrink-0 rounded-lg p-1 text-text-tertiary transition-smooth hover:bg-bg-secondary hover:text-accent"
              title={t('conv.newChat')}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="px-4 pb-1 pt-1">
          <span className="block truncate text-[11px] text-text-tertiary">{projectPath}</span>
        </div>
      )}

      {isExpanded && (
        <div className="mt-1">
          {sessions.length === 0 && (
            <div className="mx-2 rounded-xl bg-bg-secondary/35 px-3 py-3 text-[11px] text-text-tertiary">
              这个工作区暂时还没有历史会话。
            </div>
          )}

          {pinnedItems.length > 0 && (
            <>
              {pinnedItems.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isSelected={selectedId === session.id}
                  isRunning={runningSessions.has(session.id)}
                  isPinned={true}
                  isArchived={archivedSessions.has(session.id)}
                  displayName={getDisplayName(session)}
                  multiSelect={multiSelect}
                  isChecked={selectedIds.has(session.id)}
                  onSelect={onLoadSession}
                  onContextMenu={onContextMenu}
                  onRename={onRename}
                  onDelete={onDelete}
                  onToggleCheck={onToggleCheck}
                  triggerRename={renamingSessionId === session.id}
                  onRenameDone={onRenameDone}
                />
              ))}
              {dateGroups.length > 0 && <div className="mx-7 my-1 border-t border-border-subtle/50" />}
            </>
          )}

          {dateGroups.map(({ category, label: dateLabel, items }) => (
            <div key={category}>
              <div className="mt-1 select-none px-7 py-1 text-[11px] font-medium text-text-tertiary">
                {dateLabel}
              </div>
              {items.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isSelected={selectedId === session.id}
                  isRunning={runningSessions.has(session.id)}
                  isPinned={false}
                  isArchived={archivedSessions.has(session.id)}
                  displayName={getDisplayName(session)}
                  multiSelect={multiSelect}
                  isChecked={selectedIds.has(session.id)}
                  onSelect={onLoadSession}
                  onContextMenu={onContextMenu}
                  onRename={onRename}
                  onDelete={onDelete}
                  onToggleCheck={onToggleCheck}
                  triggerRename={renamingSessionId === session.id}
                  onRenameDone={onRenameDone}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
