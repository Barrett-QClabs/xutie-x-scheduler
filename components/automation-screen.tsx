"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { StatsPanel } from "@/components/stats-panel";

type Entry = { time?: string; username?: string; result?: string; pending?: boolean; detail?: string | null; keyword?: string | null; followers?: number | null };
type DaemonStatus = { state?: string; resumeAt?: string; why?: string; reason?: string; targetsRemaining?: number; updated?: string; error?: string };
type Status = {
  day: string;
  config: { unfollow: { enabled: boolean }; followback: { enabled: boolean }; keywordfollow: { enabled: boolean; keywords: string[]; poolSize: number; maxFollowers: number }; combinedFollowDailyCap: number };
  caps: { combinedFollows: number; unfollows: number; unfollowPerRun: number; followWindow15m: number };
  counts: { unfollowed: number; followedBack: number; keywordFollowed: number; combinedFollows: number };
  followWindow15m: number;
  stopForToday: { reason: string; by: string; time: string } | null;
  daemons: {
    unfollow: { running: boolean; pid: number | null; lastLines: string[] };
    followback: { running: boolean; pid: number | null; status: DaemonStatus | null };
    keywordfollow: { running: boolean; pid: number | null; status: DaemonStatus | null };
  };
  pool: { date: string; count: number; target: number; remaining: number; postsRead: number; error: unknown; sample: { username: string; followers: number; keyword: string }[] } | null;
  recent: { unfollow: Entry[]; followback: Entry[]; keywordfollow: Entry[] };
  rules: string;
  unfollowPlan?: { updated: string; following: number; inPlan: number; nonBlueV: number; nonBlueVMutual: number; blueVNonMutual: number; mutualInPlan: number; blueVMutualNever: number; blueVRecentProtected: number; whitelisted: number; protectedTop20: number; dailyCap: number; daysAtCap: number } | null;
};

const L = {
  zh: {
    title: "自动关注 / 取关", sub: "取关、回关、关键词关注三个任务的今日状态（按上海时间计日）。",
    unfollowed: "今日取关", followedBack: "今日回关", keyword: "今日关键词关注", combined: "关注合计",
    window: "15 分钟内关注", running: "运行中", stopped: "未运行", start: "启动", on: "已开启", off: "已关闭",
    turnOn: "开启", turnOff: "关闭", keywords: "关键词（逗号分隔）", save: "保存关键词", pool: "今日候选池",
    remaining: "剩余", recent: "最近记录", rules: "规则", stopDay: "今日已停止关注", resume: "恢复于", refresh: "刷新",
    hourly: "每小时运行一次", pid: "进程",
  },
  en: {
    title: "Auto follow / unfollow", sub: "Today's status of unfollow, follow-back and keyword follow (Asia/Shanghai day).",
    unfollowed: "Unfollowed today", followedBack: "Followed back today", keyword: "Keyword follows today", combined: "Follows combined",
    window: "Follows in 15 min", running: "running", stopped: "not running", start: "Start", on: "on", off: "off",
    turnOn: "Turn on", turnOff: "Turn off", keywords: "Keywords (comma separated)", save: "Save keywords", pool: "Today's candidate pool",
    remaining: "remaining", recent: "Recent", rules: "Rules", stopDay: "Follows stopped for today", resume: "resumes", refresh: "Refresh",
    hourly: "runs hourly", pid: "pid",
  },
};

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

export function AutomationScreen() {
  const { locale } = useI18n();
  const t = L[locale];
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kw, setKw] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<Status>("/api/automation");
      setS(data); setErr(null);
      setKw((cur) => (cur ? cur : data.config.keywordfollow.keywords.join(", ")));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 20_000); return () => clearInterval(id); }, [load]);

  async function patch(body: object) {
    setBusy(true);
    try { await api("/api/automation/config", { method: "PATCH", body: JSON.stringify(body) }); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function start(daemon: string) {
    setBusy(true);
    try { await api("/api/automation/start", { method: "POST", body: JSON.stringify({ daemon }) }); setTimeout(load, 3000); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  if (!s) return <p className="text-sm text-muted-foreground">{err ?? "…"}</p>;
  const tiles = [
    { label: t.unfollowed, value: `${s.counts.unfollowed} / ${s.caps.unfollows}` },
    { label: t.followedBack, value: String(s.counts.followedBack) },
    { label: t.keyword, value: String(s.counts.keywordFollowed) },
    { label: t.combined, value: `${s.counts.combinedFollows} / ${s.caps.combinedFollows}` },
    { label: t.window, value: `${s.followWindow15m} / ${s.caps.followWindow15m}` },
  ];

  const daemonCard = (key: "unfollow" | "followback" | "keywordfollow", title: string) => {
    const d = s.daemons[key];
    const enabled = s.config[key].enabled;
    const st = "status" in d ? d.status : null;
    return (
      <Card key={key}>
        <CardContent className="space-y-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-heading text-lg">{title}</h3>
            <Badge variant={enabled ? "default" : "outline"}>{enabled ? t.on : t.off}</Badge>
          </div>
          <p className="text-sm">
            {key === "unfollow" ? `${t.hourly} · ` : ""}
            <span className={d.running ? "text-primary" : "text-muted-foreground"}>{d.running ? t.running : t.stopped}</span>
            {d.pid ? ` · ${t.pid} ${d.pid}` : ""}
          </p>
          {st?.state && (
            <p className="text-sm text-muted-foreground">
              {st.state}{st.why ? ` · ${st.why}` : ""}{st.reason ? ` · ${st.reason}` : ""}
              {st.resumeAt ? ` · ${t.resume} ${fmt(st.resumeAt)}` : ""}
              {typeof st.targetsRemaining === "number" ? ` · targets ${st.targetsRemaining}` : ""}
            </p>
          )}
          {"lastLines" in d && d.lastLines.length > 0 && <p className="truncate text-xs text-muted-foreground">{d.lastLines[d.lastLines.length - 1]}</p>}
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => patch({ [key]: { enabled: !enabled } })}>{enabled ? t.turnOff : t.turnOn}</Button>
            {key !== "unfollow" && enabled && !d.running && <Button size="sm" disabled={busy} onClick={() => start(key)}>{t.start}</Button>}
          </div>
        </CardContent>
      </Card>
    );
  };

  const log = (title: string, entries: Entry[]) => (
    <Card key={title}>
      <CardContent className="p-4">
        <h3 className="mb-2 font-heading text-base">{title}</h3>
        <ul className="space-y-1 text-xs">
          {entries.length === 0 && <li className="text-muted-foreground">—</li>}
          {entries.map((e, i) => (
            <li key={i} className="flex justify-between gap-2">
              <span className="truncate">{fmt(e.time)} @{e.username}{e.keyword ? ` [${e.keyword}]` : ""}{typeof e.followers === "number" ? ` (${e.followers})` : ""}</span>
              <span className={e.result === "ok" ? "text-primary" : "text-destructive"}>{e.result}{e.pending ? " ·pending" : ""}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl">{t.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.sub} {s.day}</p>
        </div>
        <Button size="sm" variant="outline" onClick={load}>{t.refresh}</Button>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {s.stopForToday && <p className="rounded-lg border border-destructive p-3 text-sm text-destructive">{t.stopDay}: {s.stopForToday.reason} ({s.stopForToday.by})</p>}
      <StatsPanel zh={locale === "zh"} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((x) => (
          <Card key={x.label}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{x.label}</p><p className="mt-1 font-heading text-2xl">{x.value}</p></CardContent></Card>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {daemonCard("unfollow", locale === "zh" ? "取关" : "Unfollow")}
        {daemonCard("keywordfollow", locale === "zh" ? "关键词关注新人（优先）" : "Keyword follow (priority)")}
        {daemonCard("followback", locale === "zh" ? "回关" : "Follow-back")}
      </div>
      <p className="text-xs text-muted-foreground">
        {locale === "zh"
          ? "只关注蓝V：回关和关键词关注都不会关注非蓝V账号。取关计划：① 你关注的所有非蓝V账号（无论是否互关、是否刚关注）；② 没有回关你的蓝V（最近关注的 400 个除外，给对方回关时间）。互关的蓝V永不取关；whitelist.txt 和关注列表最前 20 个始终不动。先取关非蓝V，再取关未回关蓝V，各自最早关注的先取关，约 3 分钟一个，每小时运行 ≤ 10，每天 ≤ 100，取关过的不会再关注。"
          : "Blue-V only: follow-back and keyword follow never follow non-blue-V accounts. Unfollow plan: (1) every non-blue-V account you follow (mutual or not, recent or not); (2) blue-V accounts that don't follow you back, except the 400 most recent follows (time to follow back). Blue-V mutuals are never unfollowed; whitelist.txt and the first 20 of the following list are always protected. Non-blue-V first, then blue-V non-mutuals, oldest first within each; ~3 min apart, ≤ 10 per hourly run, ≤ 100/day; unfollowed accounts are never re-followed."}
        {s.unfollowPlan && (locale === "zh"
          ? ` 当前取关计划：${s.unfollowPlan.inPlan} 人 = 非蓝V ${s.unfollowPlan.nonBlueV}（其中互关 ${s.unfollowPlan.nonBlueVMutual}）+ 未回关蓝V ${s.unfollowPlan.blueVNonMutual}；按每天 100 约需 ${s.unfollowPlan.daysAtCap} 天（${fmt(s.unfollowPlan.updated)} 更新）。`
          : ` Current unfollow plan: ${s.unfollowPlan.inPlan} = ${s.unfollowPlan.nonBlueV} non-blue-V (${s.unfollowPlan.nonBlueVMutual} mutual) + ${s.unfollowPlan.blueVNonMutual} blue-V non-mutual; ~${s.unfollowPlan.daysAtCap} days at 100/day (updated ${fmt(s.unfollowPlan.updated)}).`)}
      </p>
      <p className="text-xs text-muted-foreground">
        {locale === "zh"
          ? "统一节奏：每轮最多共关注 10 人（关键词新人优先占名额，回关补齐同一轮剩余名额），然后共同休息 10–15 分钟（此期间双方都不关注），再进入下一轮。两者合计每天 ≤ 350，仍共用 X 的 15 分钟约 50 次限额，同一时间只有一个在关注。回关还会为关键词预留当天还能完成的名额（250 − 今日关键词已关注）。"
          : "Shared pace: at most 10 follows total per work window (keyword new people take slots first; follow-back fills the rest in the same window), then a shared 10–15 min rest with zero follows, then repeat. Combined ≤ 350/day, shared X 50/15 min limit, one daemon follows at a time. Follow-back also leaves daily room reserved for keyword (250 − keyword follows today)."}
      </p>
      <Card>
        <CardContent className="space-y-3 p-4">
          <label className="text-sm">{t.keywords}</label>
          <div className="flex gap-2">
            <Input value={kw} onChange={(e) => setKw(e.target.value)} />
            <Button disabled={busy} onClick={() => patch({ keywordfollow: { keywords: kw.split(/[,，]/).map((k) => k.trim()).filter(Boolean) } })}>{t.save}</Button>
          </div>
          {s.pool && (
            <div className="text-sm">
              <p>{t.pool} {s.pool.date}: {s.pool.count}/{s.pool.target} · {t.remaining} {s.pool.remaining}</p>
              <p className="mt-1 text-xs text-muted-foreground">{s.pool.sample.map((c) => `@${c.username} (${c.followers}, ${c.keyword})`).join(" · ")}</p>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-3 md:grid-cols-3">
        {log(`${t.recent} · ${locale === "zh" ? "取关" : "unfollow"}`, s.recent.unfollow)}
        {log(`${t.recent} · ${locale === "zh" ? "回关" : "follow-back"}`, s.recent.followback)}
        {log(`${t.recent} · ${locale === "zh" ? "关键词" : "keyword"}`, s.recent.keywordfollow)}
      </div>
      <Card><CardContent className="p-4"><h3 className="mb-2 font-heading text-base">{t.rules}</h3><pre className="whitespace-pre-wrap text-xs text-muted-foreground">{s.rules}</pre></CardContent></Card>
    </div>
  );
}
