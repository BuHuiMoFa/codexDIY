import { useSettingsStore, SecondaryPanelTab } from '../../stores/settingsStore';
import { FileExplorer } from '../files/FileExplorer';
import { SkillsPanel } from '../skills/SkillsPanel';
import { PluginsPanel } from '../plugins/PluginsPanel';
import { PreviewPanel } from '../preview/PreviewPanel';
import { useT } from '../../lib/i18n';
import { TaskInspectorPanel } from './TaskInspectorPanel';

const tabs: {
  id: SecondaryPanelTab;
  label: string;
  hint: string;
  icon: string;
}[] = [
  { id: 'overview', label: 'Overview', hint: 'Live trace', icon: 'M2 3h12M2 8h8M2 13h10' },
  { id: 'files', label: 'Files', hint: 'Tree & edits', icon: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3z' },
  { id: 'preview', label: 'Preview', hint: 'Render view', icon: 'M2 4h12v8H2zM5 14h6' },
  { id: 'skills', label: 'Skills', hint: 'Available tools', icon: 'M8 1L1 4.5l7 3.5 7-3.5L8 1zM1 11.5l7 3.5 7-3.5M1 8l7 3.5L15 8' },
  { id: 'plugins', label: 'Plugins', hint: 'Extensions', icon: 'M6 2v4M10 2v4M4 6h8v3a4 4 0 01-4 4h0a4 4 0 01-4-4V6zM8 13v2' },
];

export function SecondaryPanel() {
  const t = useT();
  const activeTab = useSettingsStore((s) => s.secondaryPanelTab);
  const toggleTab = useSettingsStore((s) => s.toggleSecondaryTab);
  const togglePanel = useSettingsStore((s) => s.toggleSecondaryPanel);
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-3 border-b border-border-subtle bg-bg-sidebar/90 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.2em] text-text-tertiary">
              Workspace
            </div>
            <div className="mt-1 text-sm font-semibold text-text-primary truncate">
              {active.label}
            </div>
            <div className="mt-0.5 text-[11px] text-text-tertiary">
              {active.hint}
            </div>
          </div>
          <button
            onClick={togglePanel}
            className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-tertiary transition-smooth"
            title={t('panel.close')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l6 6M10 4l-6 6" />
            </svg>
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-1.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => toggleTab(tab.id)}
              className={`rounded-xl border px-2.5 py-2 text-left transition-smooth ${
                activeTab === tab.id
                  ? 'border-accent/30 bg-accent/10 text-accent'
                  : 'border-border-subtle bg-bg-secondary/60 text-text-muted hover:text-text-primary hover:bg-bg-secondary'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
                  <path d={tab.icon} />
                </svg>
                <span className="text-[12px] font-medium">{tab.label}</span>
              </div>
              <div className="mt-1 text-[10px] text-current/70">{tab.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === 'overview' && <TaskInspectorPanel />}
        {activeTab === 'files' && <FileExplorer />}
        {activeTab === 'preview' && <PreviewPanel />}
        {activeTab === 'skills' && <SkillsPanel />}
        {activeTab === 'plugins' && <PluginsPanel />}
      </div>
    </div>
  );
}
