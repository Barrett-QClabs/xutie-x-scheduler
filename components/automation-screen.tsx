"use client";

import { useCallback, useEffect, useState } from "react";
import { ApprovedListFollowControl } from "@/components/approved-list-follow-control";
import { AutomationSettingsPanel } from "@/components/automation-settings-panel";
import { FollowAllowlistControl } from "@/components/follow-allowlist-control";
import { DailyPoolControl } from "@/components/daily-pool-control";
import { useI18n } from "@/components/i18n-provider";
import { RunAuthorizationPanel } from "@/components/run-authorization-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AccountId } from "@/lib/account";
import type { AccountOps } from "@/lib/account-ops";
import { api } from "@/lib/api";
import type { AutomationSettingsView } from "@/lib/automation-settings";
import { quotaDayLabel } from "@/lib/automation-settings-form";
import type { Locale } from "@/lib/messages";
import { StatsPanel } from "@/components/stats-panel";
import { useAppState } from "@/components/app-state";

type Entry = { time?: string; username?: string; result?: string; pending?: boolean; detail?: string | null; keyword?: string | null; followers?: number | null };
type DaemonStatus = { state?: string; resumeAt?: string; why?: string; reason?: string; targetsRemaining?: number; updated?: string; error?: string };
type Status = {
  supervisor?: "on" | "off";
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

/** `GET/PUT /api/follow/config` for one account. */
type FollowConfig = {
  accountId: AccountId;
  keywords: string[];
  running: boolean;
  reserve: { gap: number; constraint: string | null };
  dailyCap: number;
  savesDoNotStart: boolean;
  approvedListFollow?: boolean;
  approvedListFollowLocked?: boolean;
  approvedListStatus?: string;
  ops?: AccountOps | { dailyPool: false; locked: true };
};

const L = {
  zh: {
    title: "自动关注 / 取关", sub: "取关、回关、关键词关注三个任务的今日状态（按上海时间计日）。",
    unfollowed: "今日取关", followedBack: "今日回关", keyword: "今日关键词关注", combined: "关注合计",
    window: "15 分钟内关注", running: "运行中", stopped: "未运行", start: "启动", on: "已开启", off: "已关闭",
    turnOn: "开启", turnOff: "关闭", keywords: "关键词（逗号分隔）", save: "保存关键词", pool: "今日候选池",
    remaining: "剩余", recent: "最近记录", rules: "规则", stopDay: "今日已停止关注", resume: "恢复于", refresh: "刷新",
    hourly: "每小时运行一次", pid: "进程",
    supervisorOff: "关注自动化默认关闭。启动按钮不可用。只有在进程环境里把 XUTIE_AUTOMATION_SUPERVISOR 设为 on 并重启后，才会启动关注或取关进程。",
    account2Authorization: "账号2的新关注不需要授权：账号2没有持续授权，也没有当天授权。账号2按下面自己保存的设置运行。",
  },
  en: {
    title: "Auto follow / unfollow", sub: "Today's status of unfollow, follow-back and keyword follow (Asia/Shanghai day).",
    unfollowed: "Unfollowed today", followedBack: "Followed back today", keyword: "Keyword follows today", combined: "Follows combined",
    window: "Follows in 15 min", running: "running", stopped: "not running", start: "Start", on: "on", off: "off",
    turnOn: "Turn on", turnOff: "Turn off", keywords: "Keywords (comma separated)", save: "Save keywords", pool: "Today's candidate pool",
    remaining: "remaining", recent: "Recent", rules: "Rules", stopDay: "Follows stopped for today", resume: "resumes", refresh: "Refresh",
    hourly: "runs hourly", pid: "pid",
    supervisorOff: "Follow automation is off by default, so Start is unavailable. Set XUTIE_AUTOMATION_SUPERVISOR=on and restart before any follow or unfollow process can start.",
    account2Authorization: "Account 2 new follows need no authorization: account 2 has no persistent or one-day approval. It runs on its own saved settings below.",
  },
};

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

/**
 * Per-account summary line. The cap wording follows the saved quota zone (the two default zones keep
 * their established labels); before the settings load, account 1 falls back to its config view.
 */
export function followConfigNote(config: FollowConfig, view: AutomationSettingsView | null, locale: Locale): string {
  const zone = view?.settings.quotaTimezone ?? (config.ops && "quotaTimezone" in config.ops ? config.ops.quotaTimezone : null);
  const cap = view ? view.settings.follow.dailyCap : config.dailyCap;
  const constraint = config.reserve.constraint;
  if (locale === "zh") {
    const capText = zone ? `${quotaDayLabel(zone, "zh")}关注加回关上限 ${cap}` : `关注加回关日上限 ${cap}`;
    return `账号${config.accountId} 单独配置。保存不会开始运行。运行中：${config.running ? "是" : "否"}。${capText}。证据或候选缺口 ${config.reserve.gap}${constraint ? `（${constraint}）` : ""}。`;
  }
  const capText = zone ? `${quotaDayLabel(zone, "en")} follow cap ${cap}` : `Daily follow cap ${cap}`;
  return `Account ${config.accountId} has its own keywords. Saving does not start a run. Running: ${config.running ? "yes" : "no"}. ${capText}. Evidence or candidate gap ${config.reserve.gap}${constraint ? ` (${constraint})` : ""}.`;
}

export function AutomationScreen() {
  const { locale } = useI18n();
  const { accountId } = useAppState();
  const t = L[locale];
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kw, setKw] = useState("");
  const [configs, setConfigs] = useState<Record<AccountId, FollowConfig | null>>({ 1: null, 2: null });
  const [views, setViews] = useState<Record<AccountId, AutomationSettingsView | null>>({ 1: null, 2: null });
  const [actionNotes, setActionNotes] = useState<Record<AccountId, string>>({ 1: "", 2: "" });
  const [settingsReload, setSettingsReload] = useState(0);
  const [approvedListFollow, setApprovedListFollow] = useState<Record<AccountId, boolean>>({ 1: false, 2: false });
  const [approvedListLocked, setApprovedListLocked] = useState<Record<AccountId, boolean>>({ 1: false, 2: false });
  const [approvedListStatus, setApprovedListStatus] = useState<Record<AccountId, string>>({ 1: "", 2: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<Status>("/api/automation");
      setS(data); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 20_000); return () => clearInterval(id); }, [load]);

  const rememberConfig = useCallback((config: FollowConfig) => {
    setConfigs((current) => ({ ...current, [config.accountId]: config }));
  }, []);
  const rememberView = useCallback((view: AutomationSettingsView) => {
    setViews((current) => ({ ...current, [view.accountId]: view }));
  }, []);
  const noteFor = (target: AccountId, text: string) => setActionNotes((current) => ({ ...current, [target]: text }));

  useEffect(() => {
    let cancel = false;
    setKw("");
    void api<FollowConfig>(`/api/follow/config?accountId=${accountId}`)
      .then((config) => {
        if (cancel || config.accountId !== accountId) return;
        rememberConfig(config);
        setKw(config.keywords.join(", "));
        setApprovedListFollow((current) => ({ ...current, [config.accountId]: config.approvedListFollow === true }));
        setApprovedListLocked((current) => ({ ...current, [config.accountId]: config.approvedListFollowLocked !== false }));
        setApprovedListStatus((current) => ({ ...current, [config.accountId]: config.approvedListStatus ?? "" }));
      })
      .catch((error) => { if (!cancel) setErr(error instanceof Error ? error.message : String(error)); });
    return () => { cancel = true; };
  }, [accountId, rememberConfig]);

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

  const supervisorOn = s?.supervisor === "on";
  const config = configs[accountId];
  const actionNote = actionNotes[accountId];
  const tiles = s ? [
    { label: t.unfollowed, value: `${s.counts.unfollowed} / ${s.caps.unfollows}` },
    { label: t.followedBack, value: String(s.counts.followedBack) },
    { label: t.keyword, value: String(s.counts.keywordFollowed) },
    { label: t.combined, value: `${s.counts.combinedFollows} / ${s.caps.combinedFollows}` },
    { label: t.window, value: `${s.followWindow15m} / ${s.caps.followWindow15m}` },
  ] : [];

  const daemonCard = (status: Status, key: "unfollow" | "followback" | "keywordfollow", title: string) => {
    const d = status.daemons[key];
    const enabled = status.config[key].enabled;
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
            {supervisorOn && key !== "unfollow" && enabled && !d.running && <Button size="sm" disabled={busy} onClick={() => start(key)}>{t.start}</Button>}
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

  // The per-account panels keep the same position in the tree whether or not the legacy status has
  // loaded, so their unsaved edits survive and pause / revoke stay reachable if /api/automation fails.
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl">{t.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.sub} {s?.day ?? ""}</p>
        </div>
        <Button size="sm" variant="outline" onClick={load}>{t.refresh}</Button>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {!s && !err ? <p className="text-sm text-muted-foreground">…</p> : null}
      {s && !supervisorOn ? <p className="rounded-lg bg-secondary px-3 py-2 text-sm leading-6">{t.supervisorOff}</p> : null}
      <p className="rounded-lg border px-3 py-2 text-sm leading-6">{locale === "zh" ? "下面三张旧卡片和旧关键词是全局共享的，不随账号切换分开。旧 supervisor 保持关闭，这里不能启动固定账号1脚本。" : "The three legacy cards and the old keyword file are one shared config. They do not change with the account switch, and the legacy supervisor stays off."}</p>
      {config ? <p className="rounded-lg bg-secondary px-3 py-2 text-sm leading-6" data-testid="account-config-note">{followConfigNote(config, views[accountId], locale)}</p> : null}
      {actionNote ? <p className="rounded-lg bg-secondary px-3 py-2 text-sm leading-6">{actionNote}</p> : null}
      {s?.stopForToday ? <p className="rounded-lg border border-destructive p-3 text-sm text-destructive">{t.stopDay}: {s.stopForToday.reason} ({s.stopForToday.by})</p> : null}
      {accountId === 1 ? (
        <RunAuthorizationPanel locale={locale} scheduleTimezone={views[1]?.settings.scheduleTimezone ?? null} />
      ) : (
        <p className="rounded-lg border px-3 py-2 text-sm leading-6">{t.account2Authorization}</p>
      )}
      <AutomationSettingsPanel accountId={accountId} locale={locale} onView={rememberView} reloadKey={settingsReload} />
      <StatsPanel zh={locale === "zh"} />
      {s ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {tiles.map((x) => (
              <Card key={x.label}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{x.label}</p><p className="mt-1 font-heading text-2xl">{x.value}</p></CardContent></Card>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {daemonCard(s, "unfollow", locale === "zh" ? "取关" : "Unfollow")}
            {daemonCard(s, "followback", locale === "zh" ? "回关蓝V（优先）" : "Follow-back (priority)")}
            {daemonCard(s, "keywordfollow", locale === "zh" ? "关键词关注新人" : "Keyword follow")}
          </div>
          <p className="text-xs text-muted-foreground">
            {locale === "zh"
              ? "只关注蓝V：回关和关键词关注都不会关注非蓝V账号。取关计划：① 你关注的所有非蓝V账号（无论是否互关、是否刚关注）；② 没有回关你的蓝V（最近关注的 400 个除外，给对方回关时间）。互关的蓝V永不取关；whitelist.txt 白名单始终不动。先取关非蓝V，再取关未回关蓝V，各自最早关注的先取关，约 3 分钟一个，每小时运行 ≤ 10，每天 ≤ 100，取关过的不会再关注。"
              : "Blue-V only: follow-back and keyword follow never follow non-blue-V accounts. Unfollow plan: (1) every non-blue-V account you follow (mutual or not, recent or not); (2) blue-V accounts that don't follow you back, except the 400 most recent follows (time to follow back). Blue-V mutuals are never unfollowed; whitelist.txt is always protected. Non-blue-V first, then blue-V non-mutuals, oldest first within each; ~3 min apart, ≤ 10 per hourly run, ≤ 100/day; unfollowed accounts are never re-followed."}
            {s.unfollowPlan && (locale === "zh"
              ? ` 当前取关计划：${s.unfollowPlan.inPlan} 人 = 非蓝V ${s.unfollowPlan.nonBlueV}（其中互关 ${s.unfollowPlan.nonBlueVMutual}）+ 未回关蓝V ${s.unfollowPlan.blueVNonMutual}；按每天 100 约需 ${s.unfollowPlan.daysAtCap} 天（${fmt(s.unfollowPlan.updated)} 更新）。`
              : ` Current unfollow plan: ${s.unfollowPlan.inPlan} = ${s.unfollowPlan.nonBlueV} non-blue-V (${s.unfollowPlan.nonBlueVMutual} mutual) + ${s.unfollowPlan.blueVNonMutual} blue-V non-mutual; ~${s.unfollowPlan.daysAtCap} days at 100/day (updated ${fmt(s.unfollowPlan.updated)}).`)}
          </p>
          <p className="text-xs text-muted-foreground">
            {locale === "zh"
              ? "统一节奏：每轮最多共关注 10 人（优先回关关注你的蓝V，关键词新人补齐同一轮剩余名额），然后共同休息 10–15 分钟（此期间双方都不关注），再进入下一轮。两者合计每天 ≤ 350，仍共用 X 的 15 分钟约 50 次限额，同一时间只有一个在关注。关键词关注会为回关预留当天还待回关的蓝V名额，只用剩下的名额关注 250 人候选池里的新人。关键词关注只关注中文区：搜索加 lang:zh（英文关键词也只搜中文帖），候选人的帖子必须是中文，且昵称或简介含中文（日文假名不算；昵称和简介都没有中日文字时才看帖子内容），关注前再检查一次；英文区账号不关注。回关不受影响。"
              : "Shared pace: at most 10 follows total per work window (following back blue-V followers goes first; keyword new people fill the rest of the same window), then a shared 10–15 min rest with zero follows, then repeat. Combined ≤ 350/day, shared X 50/15 min limit, one daemon follows at a time. Keyword follow leaves daily room for the blue-V follow-backs still waiting and only uses what is left for the 250-candidate pool. Keyword follow is Chinese-zone only: searches use lang:zh (English keywords too), the matched post must be Chinese and the name or bio must contain Chinese (Japanese kana doesn't count; the post text is used only when name and bio have no CJK), re-checked right before each follow; English-zone accounts are never followed. Follow-back is not affected."}
          </p>
        </>
      ) : null}
      <Card>
        <CardContent className="space-y-3 p-4">
          <label className="text-sm">{t.keywords}</label>
          <div className="flex gap-2">
            <Input value={kw} onChange={(e) => setKw(e.target.value)} />
            <Button disabled={busy} onClick={async () => {
              const target = accountId;
              setBusy(true);
              try {
                const saved = await api<FollowConfig>("/api/follow/config", { method: "PUT", body: JSON.stringify({ accountId: target, keywords: kw.split(/[,，]/).map((item) => item.trim()).filter(Boolean) }) });
                if (saved.accountId === target) rememberConfig(saved);
                noteFor(target, locale === "zh" ? `已保存账号${target}的关键词。这只是配置，没有开始运行。` : `Saved account ${target} keywords. This is configuration only and does not start a run.`);
              } catch (error) { setErr(error instanceof Error ? error.message : String(error)); }
              finally { setBusy(false); }
            }}>{t.save}</Button>
          </div>
          <ApprovedListFollowControl
            accountId={accountId}
            checked={approvedListFollow[accountId]}
            locked={approvedListLocked[accountId]}
            status={approvedListStatus[accountId]}
            busy={busy || !config}
            onChecked={(checked) => setApprovedListFollow((current) => ({ ...current, [accountId]: checked }))}
            onSave={async (body) => {
              setBusy(true);
              try {
                const saved = await api<FollowConfig>("/api/follow/config", { method: "PUT", body: JSON.stringify(body) });
                rememberConfig(saved);
                setApprovedListFollow((current) => ({ ...current, [saved.accountId]: saved.approvedListFollow === true }));
                setApprovedListLocked((current) => ({ ...current, [saved.accountId]: saved.approvedListFollowLocked !== false }));
                setApprovedListStatus((current) => ({ ...current, [saved.accountId]: saved.approvedListStatus ?? "" }));
                noteFor(saved.accountId, saved.approvedListStatus ?? "");
              } catch (error) { setErr(error instanceof Error ? error.message : String(error)); }
              finally { setBusy(false); }
            }}
          />
          <FollowAllowlistControl key={accountId} accountId={accountId} locale={locale} />
          {accountId === 1 && config?.ops && "followback" in config.ops ? (
            <DailyPoolControl
              locale={locale}
              ops={config.ops}
              onSaved={(saved: FollowConfig) => {
                if (saved.accountId === 1) rememberConfig(saved);
                setSettingsReload((current) => current + 1);
              }}
            />
          ) : null}
          {s?.pool && (
            <div className="text-sm">
              <p>{t.pool} {s.pool.date}: {s.pool.count}/{s.pool.target} · {t.remaining} {s.pool.remaining}</p>
              <p className="mt-1 text-xs text-muted-foreground">{s.pool.sample.map((c) => `@${c.username} (${c.followers}, ${c.keyword})`).join(" · ")}</p>
            </div>
          )}
        </CardContent>
      </Card>
      {s ? (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            {log(`${t.recent} · ${locale === "zh" ? "取关" : "unfollow"}`, s.recent.unfollow)}
            {log(`${t.recent} · ${locale === "zh" ? "回关" : "follow-back"}`, s.recent.followback)}
            {log(`${t.recent} · ${locale === "zh" ? "关键词" : "keyword"}`, s.recent.keywordfollow)}
          </div>
          <Card><CardContent className="p-4"><h3 className="mb-2 font-heading text-base">{t.rules}</h3><pre className="whitespace-pre-wrap text-xs text-muted-foreground">{s.rules}</pre></CardContent></Card>
        </>
      ) : null}
    </div>
  );
}
