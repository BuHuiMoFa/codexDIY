import { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { ConversationList } from '../conversations/ConversationList';
import { useT } from '../../lib/i18n';
import { IS_ALPHA } from '../../lib/edition';
import { ProfileStatsModal } from '../profile/ProfileStatsModal';

export function Sidebar() {
  const [profileOpen, setProfileOpen] = useState(false);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const toggleSettings = useSettingsStore((s) => s.toggleSettings);
  const toggleSecondaryTab = useSettingsStore((s) => s.toggleSecondaryTab);
  const updateAvailable = useSettingsStore((s) => s.updateAvailable);
  const cliUpdateAvailable = useSettingsStore((s) => s.cliUpdateAvailable);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const sessions = useSessionStore((s) => s.sessions);
  const t = useT();
  const compact = sidebarWidth <= 240;

  return (
    <div className={`flex h-full flex-col ${compact ? 'pt-6 pb-3' : 'pt-8 pb-4'}`}>
      <div className={`${compact ? 'mb-4 px-4' : 'mb-5 px-5'} flex items-center justify-between cursor-default`}>
        <div className="flex items-center">
          {IS_ALPHA ? (
            <>
              <span className="text-[14px] font-bold tracking-tight text-text-primary">
                TC<span style={{ color: 'var(--color-accent)' }}>/</span>Alpha
              </span>
              <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none text-accent">
                alpha
              </span>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setProfileOpen(true)}
                className="rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/40"
                title="个人资料"
              >
                <img src="/app-icon.png" alt="" className={`${compact ? 'h-7 w-7' : 'h-8 w-8'} rounded-lg shadow-sm`} />
              </button>
              <span className={`${compact ? 'text-[16px]' : 'text-[18px]'} font-bold tracking-wide text-text-primary`}>
                TOKEN<span className="text-accent">/</span>CODE
              </span>
            </div>
          )}
        </div>
        <button
          onClick={toggleSidebar}
          className="rounded-lg p-1.5 text-text-tertiary transition-smooth hover:bg-bg-tertiary"
          title={t('sidebar.hide')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10 4L6 8L10 12" />
          </svg>
        </button>
      </div>

      <div className={`${compact ? 'px-2.5' : 'px-3'} mb-2 flex items-center justify-between`}>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
          工作区与会话
        </span>
        <span className="text-[11px] text-text-tertiary">{sessions.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden -mr-1.5 pr-1.5">
        <ConversationList />
      </div>

      <div className={`${compact ? 'px-2.5 pt-2.5' : 'px-3 pt-3'} mt-3 border-t border-border-subtle`}>
        <button
          onClick={() => toggleSecondaryTab('preview')}
          className={`flex w-full items-center rounded-xl text-text-muted transition-smooth hover:bg-bg-secondary hover:text-text-primary ${compact ? 'gap-2 px-2.5 py-2 text-[13px]' : 'gap-2.5 px-3 py-2 text-sm'}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M2 4h12v8H2zM5 14h6" />
          </svg>
          {t('panel.preview')}
        </button>
        <button
          onClick={() => toggleSecondaryTab('skills')}
          className={`flex w-full items-center rounded-xl text-text-muted transition-smooth hover:bg-bg-secondary hover:text-text-primary ${compact ? 'gap-2 px-2.5 py-2 text-[13px]' : 'gap-2.5 px-3 py-2 text-sm'}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M8 1L1 4.5l7 3.5 7-3.5L8 1zM1 11.5l7 3.5 7-3.5M1 8l7 3.5L15 8" />
          </svg>
          {t('panel.skills')}
        </button>
        <button
          onClick={toggleSettings}
          className={`flex w-full items-center rounded-xl text-text-muted transition-smooth hover:bg-bg-secondary hover:text-text-primary ${compact ? 'gap-2 px-2.5 py-2 text-[13px]' : 'gap-2.5 px-3 py-2 text-sm'}`}
        >
          <div className="relative">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="2" />
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
            </svg>
            {(updateAvailable || cliUpdateAvailable) && (
              <span className={`absolute -top-1 -right-1.5 h-2 w-2 rounded-full border-[1.5px] border-bg-sidebar ${
                cliUpdateAvailable ? 'bg-red-500' : 'bg-green-500'
              }`}
              />
            )}
          </div>
          {t('settings.title')}
        </button>
      </div>

      <ProfileStatsModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </div>
  );
}
