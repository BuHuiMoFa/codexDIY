import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../../lib/tauri-bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFileStore } from '../../stores/fileStore';
import { shortFilePath, relativeTime } from '../../lib/turns';
import { useRewind } from '../../hooks/useRewind';

type GitTab = 'unstaged' | 'staged' | 'commit' | 'branch' | 'rewind';

type GitStatusEntry = {
  path: string;
  x: string;
  y: string;
  label: string;
};

type GitCommitEntry = {
  hash: string;
  summary: string;
};

function parseStatusEntries(output: string): GitStatusEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith('##'))
    .map((line) => {
      const x = line[0] || ' ';
      const y = line[1] || ' ';
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() || rawPath : rawPath;
      let label = 'modified';
      if (line.startsWith('??')) label = 'untracked';
      else if (x === 'A' || y === 'A') label = 'added';
      else if (x === 'D' || y === 'D') label = 'deleted';
      else if (x === 'R' || y === 'R') label = 'renamed';
      return { path, x, y, label };
    });
}

function parseCommits(output: string): GitCommitEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split(' ');
      return { hash, summary: rest.join(' ') };
    });
}

function labelForEntry(entry: GitStatusEntry) {
  switch (entry.label) {
    case 'untracked': return '未跟踪';
    case 'added': return '新增';
    case 'deleted': return '删除';
    case 'renamed': return '重命名';
    default: return '修改';
  }
}

function tabLabel(tab: GitTab) {
  switch (tab) {
    case 'unstaged': return '未暂存';
    case 'staged': return '已暂存';
    case 'commit': return '提交';
    case 'branch': return '分支/仓库';
    case 'rewind': return '上一轮';
  }
}

export function GitActionMenu() {
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const selectFile = useFileStore((s) => s.selectFile);
  const setSecondaryTab = useSettingsStore((s) => s.setSecondaryTab);
  const { turns, executeRewind, canRewind } = useRewind();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<GitTab>('branch');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notRepo, setNotRepo] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [currentBranch, setCurrentBranch] = useState('');
  const [unstaged, setUnstaged] = useState<GitStatusEntry[]>([]);
  const [staged, setStaged] = useState<GitStatusEntry[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [commits, setCommits] = useState<GitCommitEntry[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteInput, setRemoteInput] = useState('');

  const recentTurns = useMemo(() => turns.slice(0, -1).slice(-6).reverse(), [turns]);

  const runGit = useCallback(async (args: string[]) => {
    if (!workingDirectory) throw new Error('No workspace selected');
    return bridge.runGitCommand(workingDirectory, args);
  }, [workingDirectory]);

  const refresh = useCallback(async () => {
    if (!workingDirectory) {
      setNotRepo(false);
      setError('');
      setCurrentBranch('');
      setUnstaged([]);
      setStaged([]);
      setBranches([]);
      setCommits([]);
      return;
    }

    setLoading(true);
    setError('');
    try {
      await runGit(['rev-parse', '--is-inside-work-tree']);
    } catch {
      setNotRepo(true);
      setCurrentBranch('');
      setUnstaged([]);
      setStaged([]);
      setBranches([]);
      setCommits([]);
      setLoading(false);
      return;
    }

    try {
      const [statusOutput, branchOutput, branchListOutput, commitOutput, fetchedRemoteUrl] = await Promise.all([
        runGit(['status', '--porcelain', '-b']),
        runGit(['branch', '--show-current']),
        runGit(['branch', '--format=%(refname:short)']),
        runGit(['log', '--oneline', '-n', '12']),
        bridge.getGitRemoteUrl(workingDirectory, 'origin'),
      ]);
      const statusEntries = parseStatusEntries(statusOutput);
      setNotRepo(false);
      setCurrentBranch(branchOutput.trim() || 'detached');
      setUnstaged(statusEntries.filter((entry) => entry.path && (entry.y !== ' ' || entry.x === '?')));
      setStaged(statusEntries.filter((entry) => entry.path && entry.x !== ' ' && entry.x !== '?'));
      setBranches(branchListOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
      setCommits(parseCommits(commitOutput));
      setRemoteUrl(fetchedRemoteUrl?.trim() || '');
      setRemoteInput(fetchedRemoteUrl?.trim() || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runGit, workingDirectory]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [workingDirectory]);

  const withAction = useCallback(async (key: string, fn: () => Promise<void>, success?: string) => {
    setActionLoading(key);
    setFeedback('');
    setError('');
    try {
      await fn();
      if (success) setFeedback(success);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(null);
    }
  }, [refresh]);

  const openFile = (path: string) => {
    setSecondaryTab('files');
    void selectFile(path);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-secondary/65 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-tertiary transition-smooth"
        title={workingDirectory ? '查看 Git 与上一轮功能' : '请先选择工作目录'}
      >
        <span className="max-w-[120px] truncate">{currentBranch || '分支'}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2 3.5L5 6.5L8 3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[420px] overflow-hidden rounded-2xl border border-border-subtle bg-bg-card shadow-2xl">
          <div className="border-b border-border-subtle bg-bg-secondary/55 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.18em] text-text-tertiary">Git Tools</div>
                <div className="mt-1 truncate text-sm font-semibold text-text-primary">
                  {workingDirectory ? shortFilePath(workingDirectory) : '未选择工作目录'}
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg p-1 text-text-tertiary hover:bg-bg-tertiary transition-smooth"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(['unstaged', 'staged', 'commit', 'branch', 'rewind'] as GitTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`rounded-lg px-2.5 py-1 text-[11px] transition-smooth ${
                    activeTab === tab
                      ? 'bg-bg-card text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
                  }`}
                >
                  {tabLabel(tab)}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-[420px] overflow-y-auto p-3">
            {feedback && (
              <div className="mb-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                {feedback}
              </div>
            )}
            {error && (
              <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                {error}
              </div>
            )}
            {loading ? (
              <div className="py-10 text-center text-sm text-text-tertiary">正在读取 Git 状态...</div>
            ) : !workingDirectory ? (
              <div className="py-10 text-center text-sm text-text-tertiary">请先选择一个工作目录。</div>
            ) : notRepo ? (
              activeTab === 'branch' ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 p-3">
                    <div className="text-xs font-semibold text-text-primary">当前目录还不是 Git 仓库</div>
                    <div className="mt-1 text-[11px] leading-5 text-text-tertiary">
                      你可以在这里直接初始化 Git 仓库，并且同时绑定 GitHub 仓库地址。
                    </div>
                    <div className="mt-3 flex flex-col gap-2">
                      <input
                        value={remoteInput}
                        onChange={(event) => setRemoteInput(event.target.value)}
                        placeholder="https://github.com/用户名/仓库.git"
                        className="w-full rounded-xl border border-border-subtle bg-bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-border-focus"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => withAction(
                            'init-repo',
                            async () => {
                              if (!workingDirectory) return;
                              await bridge.initGitRepository(workingDirectory, null, 'origin');
                            },
                            '已初始化 Git 仓库',
                          )}
                          disabled={!!actionLoading}
                          className="rounded-lg bg-bg-card px-3 py-2 text-[11px] text-text-primary disabled:opacity-40"
                        >
                          初始化仓库
                        </button>
                        <button
                          onClick={() => withAction(
                            'init-repo-remote',
                            async () => {
                              if (!workingDirectory) return;
                              const updatedUrl = await bridge.initGitRepository(workingDirectory, remoteInput.trim(), 'origin');
                              setRemoteUrl(updatedUrl);
                              setRemoteInput(updatedUrl);
                            },
                            '已初始化仓库并绑定地址',
                          )}
                          disabled={!remoteInput.trim() || !!actionLoading}
                          className="rounded-lg bg-accent px-3 py-2 text-[11px] text-text-inverse disabled:opacity-40"
                        >
                          初始化并绑定地址
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="py-10 text-center text-sm text-text-tertiary">
                  当前目录还不是 Git 仓库。切到“分支/仓库”页签后，可以直接初始化并绑定 Git 地址。
                </div>
              )
            ) : (
              <>
                {activeTab === 'unstaged' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold text-text-primary">未暂存文件</div>
                      <button
                        onClick={() => withAction('stage-all', () => runGit(['add', '-A', '--', '.']).then(() => Promise.resolve()), '已全部暂存')}
                        disabled={unstaged.length === 0 || !!actionLoading}
                        className="rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-accent disabled:opacity-40"
                      >
                        全部暂存
                      </button>
                    </div>
                    {unstaged.length === 0 ? (
                      <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-3 py-4 text-xs text-text-tertiary">
                        当前没有未暂存内容。
                      </div>
                    ) : (
                      unstaged.map((entry) => (
                        <div key={`unstaged-${entry.path}`} className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-500">{labelForEntry(entry)}</span>
                            <button
                              onClick={() => openFile(entry.path)}
                              className="min-w-0 flex-1 truncate text-left text-xs text-text-primary hover:text-accent hover:underline"
                              title={entry.path}
                            >
                              {shortFilePath(entry.path)}
                            </button>
                            <button
                              onClick={() => withAction(`stage:${entry.path}`, () => runGit(['add', '--', entry.path]).then(() => Promise.resolve()), '文件已暂存')}
                              disabled={!!actionLoading}
                              className="rounded-lg border border-border-subtle px-2 py-1 text-[11px] text-accent disabled:opacity-40"
                            >
                              暂存
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {activeTab === 'staged' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold text-text-primary">已暂存文件</div>
                      <button
                        onClick={() => withAction('unstage-all', () => runGit(['reset', 'HEAD', '--', '.']).then(() => Promise.resolve()), '已全部取消暂存')}
                        disabled={staged.length === 0 || !!actionLoading}
                        className="rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-secondary disabled:opacity-40"
                      >
                        全部取消暂存
                      </button>
                    </div>
                    {staged.length === 0 ? (
                      <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-3 py-4 text-xs text-text-tertiary">
                        当前没有已暂存内容。
                      </div>
                    ) : (
                      staged.map((entry) => (
                        <div key={`staged-${entry.path}`} className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-500">{labelForEntry(entry)}</span>
                            <button
                              onClick={() => openFile(entry.path)}
                              className="min-w-0 flex-1 truncate text-left text-xs text-text-primary hover:text-accent hover:underline"
                              title={entry.path}
                            >
                              {shortFilePath(entry.path)}
                            </button>
                            <button
                              onClick={() => withAction(`unstage:${entry.path}`, () => runGit(['reset', 'HEAD', '--', entry.path]).then(() => Promise.resolve()), '文件已取消暂存')}
                              disabled={!!actionLoading}
                              className="rounded-lg border border-border-subtle px-2 py-1 text-[11px] text-text-secondary disabled:opacity-40"
                            >
                              取消暂存
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {activeTab === 'commit' && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 p-3">
                      <div className="text-xs font-semibold text-text-primary">提交已暂存内容</div>
                      <textarea
                        value={commitMessage}
                        onChange={(event) => setCommitMessage(event.target.value)}
                        rows={3}
                        placeholder="输入提交说明"
                        className="mt-2 w-full rounded-xl border border-border-subtle bg-bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-border-focus"
                      />
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <div className="text-[11px] text-text-tertiary">
                          当前已暂存 {staged.length} 个文件
                        </div>
                        <button
                          onClick={() => withAction(
                            'commit',
                            () => runGit(['commit', '-m', commitMessage.trim()]).then(() => Promise.resolve()),
                            '提交成功',
                          ).then(() => setCommitMessage(''))}
                          disabled={!commitMessage.trim() || staged.length === 0 || !!actionLoading}
                          className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-text-inverse disabled:opacity-40"
                        >
                          立即提交
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 text-xs font-semibold text-text-primary">最近提交</div>
                      <div className="space-y-2">
                        {commits.map((commit) => (
                          <div key={commit.hash} className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-3 py-2">
                            <div className="text-xs font-medium text-text-primary">{commit.summary || commit.hash}</div>
                            <div className="mt-1 text-[11px] font-mono text-text-tertiary">{commit.hash}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'branch' && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 p-3">
                      <div className="text-xs font-semibold text-text-primary">当前分支</div>
                      <div className="mt-1 text-sm text-accent">{currentBranch || 'detached'}</div>
                      <div className="mt-3 flex gap-2">
                        <input
                          value={newBranchName}
                          onChange={(event) => setNewBranchName(event.target.value)}
                          placeholder="新分支名"
                          className="flex-1 rounded-xl border border-border-subtle bg-bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-border-focus"
                        />
                        <button
                          onClick={() => withAction(
                            'create-branch',
                            () => runGit(['switch', '-c', newBranchName.trim()]).then(() => Promise.resolve()),
                            '已创建并切换分支',
                          ).then(() => setNewBranchName(''))}
                          disabled={!newBranchName.trim() || !!actionLoading}
                          className="rounded-lg bg-bg-card px-3 py-2 text-[11px] text-text-primary disabled:opacity-40"
                        >
                          新建
                        </button>
                      </div>
                    </div>

                    <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 p-3">
                      <div className="text-xs font-semibold text-text-primary">Git 仓库地址</div>
                      <div className="mt-1 break-all text-[11px] text-text-tertiary">
                        {remoteUrl || '当前还没有绑定 origin 仓库地址'}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <input
                          value={remoteInput}
                          onChange={(event) => setRemoteInput(event.target.value)}
                          placeholder="https://github.com/用户名/仓库.git"
                          className="flex-1 rounded-xl border border-border-subtle bg-bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-border-focus"
                        />
                        <button
                          onClick={() => withAction(
                            'set-remote',
                            async () => {
                              if (!workingDirectory) return;
                              const updatedUrl = await bridge.setGitRemoteUrl(workingDirectory, remoteInput.trim(), 'origin');
                              setRemoteUrl(updatedUrl);
                              setRemoteInput(updatedUrl);
                            },
                            remoteUrl ? '已更新仓库地址' : '已添加仓库地址',
                          )}
                          disabled={!remoteInput.trim() || !!actionLoading}
                          className="rounded-lg bg-bg-card px-3 py-2 text-[11px] text-text-primary disabled:opacity-40"
                        >
                          {remoteUrl ? '更新地址' : '添加地址'}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {branches.map((branch) => {
                        const isCurrent = branch === currentBranch;
                        return (
                          <div key={branch} className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className={`rounded-full px-2 py-0.5 text-[10px] ${isCurrent ? 'bg-accent/10 text-accent' : 'bg-bg-card text-text-tertiary'}`}>
                                {isCurrent ? '当前' : '分支'}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{branch}</span>
                              {!isCurrent && (
                                <button
                                  onClick={() => withAction(`switch:${branch}`, () => runGit(['switch', branch]).then(() => Promise.resolve()), `已切换到 ${branch}`)}
                                  disabled={!!actionLoading}
                                  className="rounded-lg border border-border-subtle px-2 py-1 text-[11px] text-accent disabled:opacity-40"
                                >
                                  切换
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {activeTab === 'rewind' && (
                  <div className="space-y-3">
                    {!canRewind || recentTurns.length === 0 ? (
                      <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-3 py-4 text-xs text-text-tertiary">
                        当前还没有可回到的上一轮。
                      </div>
                    ) : (
                      recentTurns.map((turn) => (
                        <div key={turn.userMessageId} className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-3 py-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-text-primary">第 {turn.index} 轮</div>
                              <div className="mt-1 line-clamp-2 text-xs text-text-secondary">{turn.userContent}</div>
                              <div className="mt-1 text-[11px] text-text-tertiary">{relativeTime(turn.timestamp)}</div>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              onClick={() => {
                                setOpen(false);
                                void executeRewind(turn, 'restore_conversation');
                              }}
                              className="rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-primary"
                            >
                              恢复任务
                            </button>
                            <button
                              onClick={() => {
                                setOpen(false);
                                void executeRewind(turn, 'restore_all');
                              }}
                              className="rounded-lg bg-accent px-2.5 py-1 text-[11px] text-text-inverse"
                            >
                              恢复代码和任务
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
