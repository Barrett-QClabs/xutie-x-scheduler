"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";

type Day = {
  day: string; isToday: boolean; window: { local: string };
  follows: { total: number; followBack: number; keyword: number };
  keywordFollowedBack: number | null; followBackRatio: number | null; unfollows: number;
  "postsBy序帖": number | null; replies: number | null; impressions: number | null;
  timeline: { fetchedAt: string; complete: boolean } | null;
};
type Stats = { days: Day[]; timelineError: string | null; dayDefinition: string };

const NA = "unavailable";
const num = (v: number | null | undefined) => (v === null || v === undefined ? NA : v.toLocaleString());

export function StatsPanel({ zh }: { zh: boolean }) {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try { setS(await api<Stats>(`/api/stats/daily?days=7${refresh ? "&refresh=1" : ""}`)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, []);
  // Auto-refresh every 30 min while the tab is visible (the server caches X reads anyway).
  useEffect(() => { load(); const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30 * 60_000); return () => clearInterval(id); }, [load]);

  const cols = zh
    ? ["X 日（UTC）", "关注多少人", "回关多少人", "回关关注比", "取关多少人", "发了多少贴", "回复多少条", "曝光量"]
    : ["X day (UTC)", "Followed", "Followed back", "Back ratio", "Unfollowed", "Posts", "Replies", "Impressions"];
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="font-heading text-lg">{zh ? "每日数据" : "Daily stats"}</h3>
            <p className="text-xs text-muted-foreground">{zh ? "按 X 日计（UTC 日 = 台北/北京 08:00–次日 08:00）。回关 = 关键词关注的人现在已关注你。" : "By X day (UTC = 08:00–08:00 UTC+8). Followed back = keyword-followed accounts now following you."}</p>
          </div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => load(true)}>{zh ? "刷新" : "Refresh"}</Button>
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        {s?.timelineError && <p className="text-xs text-destructive">{zh ? "X 时间线读取失败：" : "Timeline fetch failed: "}{s.timelineError}</p>}
        {s && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground">{cols.map((c) => <th key={c} className="px-2 py-1 font-normal whitespace-nowrap">{c}</th>)}</tr></thead>
              <tbody>
                {s.days.map((d) => (
                  <tr key={d.day} className={d.isToday ? "bg-muted/60" : ""}>
                    <td className="px-2 py-1 whitespace-nowrap" title={d.window.local}>{d.day}{d.isToday ? (zh ? "（今天）" : " (today)") : ""}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{d.follows.total} <span className="text-xs text-muted-foreground">({zh ? "回关" : "fb"} {d.follows.followBack} / {zh ? "关键词" : "kw"} {d.follows.keyword})</span></td>
                    <td className="px-2 py-1">{num(d.keywordFollowedBack)}</td>
                    <td className="px-2 py-1">{d.followBackRatio === null ? (d.follows.keyword ? NA : "—") : `${d.followBackRatio}%`}</td>
                    <td className="px-2 py-1">{d.unfollows}</td>
                    <td className="px-2 py-1">{num(d["postsBy序帖"])}</td>
                    <td className="px-2 py-1" title={d.timeline ? `fetched ${d.timeline.fetchedAt}` : ""}>{num(d.replies)}</td>
                    <td className="px-2 py-1" title={d.timeline ? `fetched ${d.timeline.fetchedAt}` : ""}>{num(d.impressions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
