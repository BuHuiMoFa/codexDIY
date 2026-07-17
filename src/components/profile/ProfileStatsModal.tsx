import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { bridge, ProfileStats } from '../../lib/tauri-bridge';
import { displayDeepSeekModelName } from '../../lib/deepseek-models';
import { useSettingsStore } from '../../stores/settingsStore';

interface Props {
  open: boolean;
  onClose: () => void;
}

type ActivityView = 'daily' | 'weekly' | 'total';

function formatTokens(value: number): string {
  if (!value) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return value.toLocaleString();
}

function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function levelFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.45) return 3;
  if (ratio >= 0.2) return 2;
  return 1;
}

function heatColor(level: number): string {
  switch (level) {
    case 4:
      return '#2f95ff';
    case 3:
      return '#4aa6ff';
    case 2:
      return '#72bbff';
    case 1:
      return '#a6d4ff';
    default:
      return 'rgba(255, 255, 255, 0.08)';
  }
}

function monthLabel(date: Date): string {
  return `${date.getMonth() + 1}月`;
}

export function ProfileStatsModal({ open, onClose }: Props) {
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<ActivityView>('daily');
  const userAvatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const userDisplayName = useSettingsStore((s) => s.userDisplayName);

  const loadStats = async () => {
    setLoading(true);
    setError('');
    try {
      setStats(await bridge.getProfileStats());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void loadStats();
    }
  }, [open]);

  const dailyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of stats?.daily ?? []) {
      if (day.date !== 'unknown') map.set(day.date, day.total_tokens);
    }
    return map;
  }, [stats]);

  const heatmap = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let start = addDays(today, -364);
    start = addDays(start, -start.getDay());

    const days: { date: Date; key: string; tokens: number }[] = [];
    for (let d = start; d <= today; d = addDays(d, 1)) {
      const key = dateKey(d);
      days.push({ date: d, key, tokens: dailyMap.get(key) ?? 0 });
    }

    const weeks: typeof days[] = [];
    for (let i = 0; i < days.length; i += 7) {
      weeks.push(days.slice(i, i + 7));
    }
    return weeks;
  }, [dailyMap]);

  const recentDaily = useMemo(() => {
    return [...(stats?.daily ?? [])]
      .filter((d) => d.date !== 'unknown')
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 14);
  }, [stats]);

  const weekly = useMemo(() => {
    const weeks: { label: string; tokens: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 7; i >= 0; i -= 1) {
      const end = addDays(today, -i * 7);
      const start = addDays(end, -6);
      let tokens = 0;

      for (let d = start; d <= end; d = addDays(d, 1)) {
        tokens += dailyMap.get(dateKey(d)) ?? 0;
      }

      weeks.push({ label: `${start.getMonth() + 1}/${start.getDate()}`, tokens });
    }

    return weeks;
  }, [dailyMap]);

  const maxDay = Math.max(stats?.peakDayTokens ?? 0, 1);
  const maxWeek = Math.max(...weekly.map((week) => week.tokens), 1);
  const displayName = userDisplayName.trim() || 'TOKENICODE 用户';

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center px-5 py-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 tokenicode-modal-backdrop" />

      <div
        className="tokenicode-modal-surface relative z-[1] w-[min(920px,calc(100vw-40px))] max-h-[calc(100vh-52px)] overflow-hidden
          rounded-[30px] border border-white/10 bg-bg-card/96 shadow-[0_28px_80px_rgba(0,0,0,0.42)]"
      >
        <button
          onClick={onClose}
          className="absolute right-6 top-6 z-10 rounded-full p-2 text-text-muted transition-smooth
            hover:bg-white/8 hover:text-text-primary"
          title="关闭"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        <div className="max-h-[calc(100vh-52px)] overflow-y-auto px-7 py-7 md:px-9 md:py-8">
          <div className="mx-auto max-w-[820px]">
            <div className="text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center overflow-hidden rounded-[24px] border border-white/10 bg-bg-secondary shadow-sm">
                <img
                  src={userAvatarUrl || '/app-icon.png'}
                  alt=""
                  className="h-full w-full object-cover"
                />
              </div>
              <h2 className="mt-4 text-[30px] font-semibold tracking-tight text-text-primary">{displayName}</h2>
              <p className="mt-2 text-sm text-text-muted">本机 TOKENICODE 使用汇总</p>
            </div>

            {loading && (
              <div className="mt-8 rounded-[22px] border border-white/10 bg-bg-primary/50 px-5 py-4 text-center text-sm text-text-muted">
                正在读取本机会话统计...
              </div>
            )}

            {error && (
              <div className="mt-8 rounded-[22px] border border-error/30 bg-error/10 px-5 py-4 text-sm text-error">
                读取统计失败：{error}
              </div>
            )}

            {stats && !loading && (
              <>
                <section className="mt-8 rounded-[24px] border border-white/10 bg-bg-primary/55 p-3 md:p-4">
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    {[
                      ['累计 Token 数', formatTokens(stats.totalTokens)],
                      ['峰值日 Token 数', formatTokens(stats.peakDayTokens)],
                      ['会话总数', stats.sessionCount.toLocaleString()],
                      ['活跃天数', `${stats.activeDays} 天`],
                      ['消息计数', stats.messageCount.toLocaleString()],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-[18px] border border-white/10 bg-bg-card/45 px-4 py-4 text-center"
                      >
                        <div className="text-[24px] font-semibold leading-none text-text-primary">{value}</div>
                        <div className="mt-2 text-xs text-text-muted">{label}</div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="mt-6 rounded-[24px] border border-white/10 bg-bg-primary/55 p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h3 className="text-base font-semibold text-text-primary">Token 活动</h3>
                    <div className="inline-flex w-fit rounded-full border border-white/10 bg-bg-card/65 p-1">
                      {[
                        ['daily', '每日'],
                        ['weekly', '每周'],
                        ['total', '累计'],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          onClick={() => setView(id as ActivityView)}
                          className={`rounded-full px-3 py-1 text-xs transition-smooth ${
                            view === id
                              ? 'bg-accent text-text-inverse shadow-[0_6px_18px_rgba(0,0,0,0.22)]'
                              : 'text-text-muted hover:text-text-primary'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-5 overflow-x-auto pb-2">
                    <div className="inline-flex min-w-full gap-[5px]">
                      {heatmap.map((week, weekIndex) => (
                        <div key={weekIndex} className="flex flex-col gap-[5px]">
                          {week.map((day) => {
                            const level = levelFor(day.tokens, maxDay);
                            return (
                              <div
                                key={day.key}
                                title={`${day.key}: ${formatTokens(day.tokens)} tokens`}
                                className="h-[13px] w-[13px] rounded-[4px] border border-white/12"
                                style={{ background: heatColor(level) }}
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 flex justify-between gap-2 text-xs text-text-tertiary">
                    {heatmap
                      .filter((week) => week[0]?.date.getDate() <= 7)
                      .slice(-12)
                      .map((week) => (
                        <span key={week[0].key}>{monthLabel(week[0].date)}</span>
                      ))}
                  </div>
                </section>

                <div className="mt-6 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
                  <section className="rounded-[24px] border border-white/10 bg-bg-primary/55 p-5">
                    <h3 className="text-base font-semibold text-text-primary">活动洞察</h3>

                    {view === 'daily' && (
                      <div className="mt-4 space-y-2.5">
                        {recentDaily.length ? (
                          recentDaily.map((day) => (
                            <div key={day.date} className="flex items-center gap-3 text-sm">
                              <span className="w-24 text-text-muted">{day.date.slice(5)}</span>
                              <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-secondary">
                                <div
                                  className="h-full rounded-full bg-accent"
                                  style={{ width: `${Math.max(3, (day.total_tokens / maxDay) * 100)}%` }}
                                />
                              </div>
                              <span className="w-20 text-right text-text-primary">
                                {formatTokens(day.total_tokens)}
                              </span>
                            </div>
                          ))
                        ) : (
                          <p className="mt-4 text-sm text-text-muted">还没有可统计的 Token 活动。</p>
                        )}
                      </div>
                    )}

                    {view === 'weekly' && (
                      <div className="mt-4 space-y-2.5">
                        {weekly.map((week) => (
                          <div key={week.label} className="flex items-center gap-3 text-sm">
                            <span className="w-24 text-text-muted">{week.label}</span>
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-secondary">
                              <div
                                className="h-full rounded-full bg-accent"
                                style={{ width: `${Math.max(3, (week.tokens / maxWeek) * 100)}%` }}
                              />
                            </div>
                            <span className="w-20 text-right text-text-primary">{formatTokens(week.tokens)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {view === 'total' && (
                      <div className="mt-4 space-y-3 text-sm">
                        {[
                          ['输入 Token', stats.totalInputTokens],
                          ['缓存 Token', stats.totalCacheTokens],
                          ['输出 Token', stats.totalOutputTokens],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            className="flex items-center justify-between border-b border-white/10 pb-2"
                          >
                            <span className="text-text-muted">{label}</span>
                            <span className="font-medium text-text-primary">
                              {formatTokens(value as number)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="rounded-[24px] border border-white/10 bg-bg-primary/55 p-5">
                    <h3 className="text-base font-semibold text-text-primary">常用模型</h3>
                    <div className="mt-4 space-y-3">
                      {stats.models.length ? (
                        stats.models.map((model) => (
                          <div key={model.model} className="flex items-center gap-3 rounded-[18px] bg-bg-card/35 px-3 py-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15 text-accent">
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinejoin="round"
                              >
                                <path d="M8 1.5l5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7L8 1.5z" />
                                <path d="M2.8 4.9L8 8l5.2-3.1M8 8v6" />
                              </svg>
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm text-text-primary">
                                {displayDeepSeekModelName(model.model)}
                              </div>
                              <div className="text-xs text-text-tertiary">{model.message_count} 次响应</div>
                            </div>
                            <div className="text-sm text-text-muted">{formatTokens(model.total_tokens)}</div>
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-text-muted">还没有模型使用记录。</p>
                      )}
                    </div>
                  </section>
                </div>

                <div className="mt-6 flex justify-center">
                  <button
                    onClick={loadStats}
                    className="rounded-full border border-white/10 px-5 py-2 text-sm text-text-muted transition-smooth
                      hover:bg-white/8 hover:text-text-primary"
                  >
                    刷新统计
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
