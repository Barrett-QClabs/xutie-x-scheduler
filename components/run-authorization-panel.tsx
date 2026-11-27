"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { NewAdmissionView, RunAuthorizationView } from "@/lib/follow-new-admission";
import type { Locale } from "@/lib/messages";
import {
  authorizeRunRequest,
  formatInZone,
  instantToZonedInput,
  RUN_AUTHORIZATION_NOTE_MAX,
  runAuthorizationActions,
  runAuthorizationPhase,
  runControlBody,
  type AuthorizationIssue,
  type RunAuthorizationAction,
  type RunAuthorizationPhase,
} from "@/lib/run-authorization-body";

export type ApprovalState = Pick<NewAdmissionView, "approvalSource" | "approval">;

const ZH = {
  title: "新关注持续授权 · 账号1",
  intro: "开启后，账号1的新关注（kind=new）在已保存的时间窗和工作槽里自动继续，不需要每天重新授权：跨过午夜仍然有效，直到你暂停、撤销，或到达你设的到期时间。每日上限照常在日上限时区的午夜重置。回关不看这份授权。账号2的新关注不需要授权。",
  notRun: "授权只是放行，不会打开关注开关，也不会恢复已暂停的关注：执行仍要求 XUTIE_ACCOUNT1_FOLLOW=on、关注已恢复、身份已确认。",
  oneDay: "这不是旧的「当天授权」（follow_new_approval）。当天授权只覆盖一个台北日、最晚到当天 24:00，仍只能用 POST /api/follow/new-approval 写入，这里只显示它的状态。暂停或撤销持续授权之后，之前写入的当天授权也不再放行。",
  phase: { active: "生效中", expired: "已到期", paused: "已暂停", revoked: "已撤销", none: "未授权" } as Record<RunAuthorizationPhase, string>,
  loading: "读取中",
  authorizedAt: "授权于",
  expiresAt: "到期",
  noExpiry: "不设到期",
  note: "备注",
  noNote: "无",
  updatedAt: "更新于",
  source: "当前放行新关注的是：",
  sourcePersistent: "持续授权",
  sourceDaily: "当天授权",
  sourceNone: "没有授权。新关注留在池里不执行，回关照常。",
  sourceUnknown: "读不到当前放行来源。",
  dailyRow: (day: string, start: string, end: string, active: boolean) => `当天授权记录：台北日 ${day}，${start} 到 ${end}${active ? "" : "（现在不放行）"}。`,
  pause: "暂停",
  resume: "恢复",
  revoke: "撤销",
  stopHelp: "暂停和撤销随时一键生效，不需要确认。暂停保留原授权和到期时间，恢复后沿用；撤销后要重新授权。",
  authorizeTitle: "授权持续运行",
  updateTitle: "更新持续授权",
  expiryLabel: (zone: string) => `到期时间（可选，按 ${zone} 时间）`,
  expiryHelp: "留空表示不设到期，一直有效到暂停或撤销。",
  zoneLoading: "正在读取排程时区，读到之前只能不设到期。",
  noteLabel: `备注（可选，最多 ${RUN_AUTHORIZATION_NOTE_MAX} 字）`,
  authorize: "授权持续运行",
  reauthorize: "重新授权（重写到期和备注）",
  done: {
    authorize: "已授权：账号1的新关注会跨午夜继续，直到暂停、撤销或到期。每日上限照常重置。",
    pause: "已暂停持续授权。新关注不再放行，回关不受影响。恢复后沿用原到期时间。",
    resume: "已恢复持续授权，沿用原到期时间。",
    revoke: "已撤销持续授权。新关注不再放行，之前写入的当天授权也不再放行。要再运行需要重新授权。",
  } as Record<RunAuthorizationAction, string>,
  fixFirst: "有字段需要修改，没有提交。",
  failed: "请求没有完成。",
  refresh: "刷新",
};

type PanelText = typeof ZH;

const EN: PanelText = {
  title: "Persistent new-follow authorization · Account 1",
  intro: "When active, account 1 new follows (kind=new) keep running in the saved windows and work slots without a daily renewal. It stays valid across midnights until you pause it, revoke it, or reach the expiry you set. Daily caps still reset at midnight in the quota time zone. Follow-backs do not use this authorization. Account 2 new follows need no authorization.",
  notRun: "Authorizing only permits new follows. It does not turn the follow lane on or resume a paused lane: execution still needs XUTIE_ACCOUNT1_FOLLOW=on, a resumed follow lane, and a confirmed identity.",
  oneDay: "This is not the old one-day approval (follow_new_approval). A one-day approval covers a single Taipei day, ending by 24:00 that day, and is still written only through POST /api/follow/new-approval; this card only shows its state. After you pause or revoke the persistent authorization, an earlier one-day approval stops counting too.",
  phase: { active: "active", expired: "expired", paused: "paused", revoked: "revoked", none: "not authorized" },
  loading: "loading",
  authorizedAt: "Authorized",
  expiresAt: "Expires",
  noExpiry: "no expiry",
  note: "Note",
  noNote: "none",
  updatedAt: "Updated",
  source: "New follows are currently permitted by: ",
  sourcePersistent: "the persistent authorization",
  sourceDaily: "a one-day approval",
  sourceNone: "nothing. New follows wait in the pool; follow-backs run as usual.",
  sourceUnknown: "Could not read what currently permits new follows.",
  dailyRow: (day: string, start: string, end: string, active: boolean) => `One-day approval on record: Taipei day ${day}, ${start} to ${end}${active ? "" : " (not permitting now)"}.`,
  pause: "Pause",
  resume: "Resume",
  revoke: "Revoke",
  stopHelp: "Pause and revoke take effect in one click, with no confirmation. Pause keeps the grant and its expiry for a later resume; after a revoke you must authorize again.",
  authorizeTitle: "Authorize self-running",
  updateTitle: "Update the persistent authorization",
  expiryLabel: (zone: string) => `Expiry (optional, ${zone} time)`,
  expiryHelp: "Leave blank for no expiry: it stays valid until paused or revoked.",
  zoneLoading: "Loading the schedule time zone. Until then only no-expiry is possible.",
  noteLabel: `Note (optional, up to ${RUN_AUTHORIZATION_NOTE_MAX} characters)`,
  authorize: "Authorize self-running",
  reauthorize: "Authorize again (rewrites expiry and note)",
  done: {
    authorize: "Authorized: account 1 new follows continue across midnights until paused, revoked, or expired. Daily caps still reset.",
    pause: "Persistent authorization paused. New follows stop; follow-backs are not affected. Resume keeps the original expiry.",
    resume: "Persistent authorization resumed with its original expiry.",
    revoke: "Persistent authorization revoked. New follows stop, and an earlier one-day approval no longer counts. Authorize again to run.",
  },
  fixFirst: "Some fields need fixing, so nothing was sent.",
  failed: "The request did not finish.",
  refresh: "Refresh",
};

const TEXT: Record<Locale, PanelText> = { zh: ZH, en: EN };

type Feedback = { ok: boolean; text: string } | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/**
 * Account 1 only. Reads and writes `/api/follow/authorization`; every request names account 1.
 * Pause and revoke stay enabled while other requests are in flight.
 */
export function RunAuthorizationPanel(props: { locale: Locale; scheduleTimezone: string | null }) {
  const { locale, scheduleTimezone } = props;
  const text = TEXT[locale];
  const [view, setView] = useState<RunAuthorizationView | null>(null);
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("");
  const [expiryEdited, setExpiryEdited] = useState(false);
  const [note, setNote] = useState("");
  const [noteEdited, setNoteEdited] = useState(false);
  const [pending, setPending] = useState<RunAuthorizationAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [issues, setIssues] = useState<AuthorizationIssue[]>([]);
  const generation = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const token = ++generation.current;
    try {
      const [auth, follow] = await Promise.all([
        api<RunAuthorizationView>("/api/follow/authorization?accountId=1"),
        api<{ accountId?: number; newAdmission?: ApprovalState }>("/api/follow?accountId=1").catch(() => null),
      ]);
      if (!mounted.current || token !== generation.current || auth.accountId !== 1) return;
      setView(auth);
      setApproval(follow && follow.accountId === 1 && follow.newAdmission
        ? { approvalSource: follow.newAdmission.approvalSource, approval: follow.newAdmission.approval }
        : null);
      setLoadError(null);
    } catch (error) {
      if (!mounted.current || token !== generation.current) return;
      setLoadError(errorText(error));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // Prefill from the stored record until the operator edits the field.
  useEffect(() => {
    if (expiryEdited || !view || !scheduleTimezone) return;
    const future = view.expiresAt && Date.parse(view.expiresAt) > Date.now() ? view.expiresAt : null;
    setExpiry(instantToZonedInput(future, scheduleTimezone));
  }, [view, scheduleTimezone, expiryEdited]);

  useEffect(() => {
    if (noteEdited || !view) return;
    setNote(view.note ?? "");
  }, [view, noteEdited]);

  async function act(action: RunAuthorizationAction) {
    let body: object;
    if (action === "authorize") {
      const request = authorizeRunRequest({ expiry, zone: scheduleTimezone, note, noteEdited, now: new Date() });
      setIssues(request.issues);
      if (!request.body) {
        setFeedback({ ok: false, text: text.fixFirst });
        return;
      }
      body = request.body;
    } else {
      body = runControlBody(action);
    }
    const token = ++generation.current;
    setPending(action);
    setFeedback(null);
    try {
      const next = await api<RunAuthorizationView>("/api/follow/authorization", { method: "POST", body: JSON.stringify(body) });
      if (!mounted.current) return;
      if (token === generation.current) setView(next);
      if (action === "authorize") {
        setExpiryEdited(false);
        setNoteEdited(false);
        setIssues([]);
      }
      setFeedback({ ok: true, text: text.done[action] });
      void load();
    } catch (error) {
      if (!mounted.current) return;
      setFeedback({ ok: false, text: errorText(error) || text.failed });
    } finally {
      if (mounted.current) setPending((current) => (current === action ? null : current));
    }
  }

  return (
    <RunAuthorizationCard
      locale={locale}
      view={view}
      approval={approval}
      loadError={loadError}
      scheduleTimezone={scheduleTimezone}
      expiry={expiry}
      note={note}
      issues={issues}
      pending={pending}
      feedback={feedback}
      onExpiry={(value) => {
        setExpiry(value);
        setExpiryEdited(true);
      }}
      onNote={(value) => {
        setNote(value);
        setNoteEdited(true);
      }}
      onAction={(action) => void act(action)}
      onRefresh={() => void load()}
    />
  );
}

/** Presentational card for the persistent authorization. */
export function RunAuthorizationCard(props: {
  locale: Locale;
  view: RunAuthorizationView | null;
  approval: ApprovalState | null;
  loadError: string | null;
  scheduleTimezone: string | null;
  expiry: string;
  note: string;
  issues: AuthorizationIssue[];
  pending: RunAuthorizationAction | null;
  feedback: Feedback;
  onExpiry: (value: string) => void;
  onNote: (value: string) => void;
  onAction: (action: RunAuthorizationAction) => void;
  onRefresh: () => void;
}) {
  const { locale, view, scheduleTimezone } = props;
  const text = TEXT[locale];
  const phase = view ? runAuthorizationPhase(view) : null;
  // Before the record loads, the safety stops stay clickable and the server decides.
  const actions = view ? runAuthorizationActions(view) : { authorize: false, pause: true, resume: false, revoke: true };
  const zone = scheduleTimezone ?? "UTC";
  const when = (iso: string | null) => (iso ? `${formatInZone(iso, zone)}（${zone}）` : "");
  const issueFor = (field: AuthorizationIssue["field"]) => props.issues.filter((issue) => issue.field === field).map((issue) => issue[locale]);
  const busy = props.pending !== null;
  const source = props.approval?.approvalSource ?? null;
  const daily = props.approval?.approval ?? null;
  const badgeVariant = phase === "active" ? "default" : phase === "paused" || phase === "expired" ? "secondary" : "outline";

  return (
    <Card data-testid="run-authorization">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="max-w-2xl">
            <h2 className="font-heading text-lg">{text.title}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{text.intro}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={badgeVariant} data-testid="run-authorization-status">{phase ? text.phase[phase] : text.loading}</Badge>
            <Button type="button" size="xs" variant="ghost" onClick={props.onRefresh}>
              {text.refresh}
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="run-authorization-pause"
              disabled={!actions.pause || props.pending === "pause"}
              onClick={() => props.onAction("pause")}
            >
              {text.pause}
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="run-authorization-revoke"
              disabled={props.pending === "revoke"}
              onClick={() => props.onAction("revoke")}
            >
              {text.revoke}
            </Button>
            {actions.resume ? (
              <Button
                type="button"
                variant="outline"
                data-testid="run-authorization-resume"
                disabled={busy}
                onClick={() => props.onAction("resume")}
              >
                {text.resume}
              </Button>
            ) : null}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{text.stopHelp}</p>
        </div>

        {props.loadError !== null ? <p className="text-sm text-destructive">{props.loadError || text.failed}</p> : null}

        {view ? (
          <dl className="grid gap-x-4 gap-y-1 text-xs leading-5 sm:grid-cols-2" data-testid="run-authorization-details">
            <div><dt className="inline text-muted-foreground">{text.authorizedAt}：</dt><dd className="inline">{when(view.authorizedAt) || "—"}</dd></div>
            <div><dt className="inline text-muted-foreground">{text.expiresAt}：</dt><dd className="inline">{when(view.expiresAt) || text.noExpiry}</dd></div>
            <div><dt className="inline text-muted-foreground">{text.note}：</dt><dd className="inline">{view.note || text.noNote}</dd></div>
            <div><dt className="inline text-muted-foreground">{text.updatedAt}：</dt><dd className="inline">{when(view.updatedAt) || "—"}</dd></div>
          </dl>
        ) : null}

        <div className="space-y-1 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5" data-testid="run-authorization-source">
          <p>
            {props.approval === null
              ? text.sourceUnknown
              : `${text.source}${source === "persistent" ? text.sourcePersistent : source === "daily" ? text.sourceDaily : text.sourceNone}`}
          </p>
          {daily ? <p>{text.dailyRow(daily.poolDay, when(daily.approvedStart), when(daily.approvedEnd), daily.active)}</p> : null}
          <p className="text-muted-foreground">{text.oneDay}</p>
        </div>

        <form
          className="space-y-3 rounded-lg border px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            props.onAction("authorize");
          }}
        >
          <p className="text-sm font-medium">{view && view.status === "active" ? text.updateTitle : text.authorizeTitle}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="run-authorization-expiry">{text.expiryLabel(scheduleTimezone ?? "—")}</Label>
              <Input
                id="run-authorization-expiry"
                name="run-authorization-expiry"
                type="datetime-local"
                value={props.expiry}
                disabled={!scheduleTimezone}
                aria-invalid={issueFor("expiresAt").length > 0}
                onChange={(event) => props.onExpiry(event.target.value)}
              />
              <p className="text-xs leading-5 text-muted-foreground">{scheduleTimezone ? text.expiryHelp : text.zoneLoading}</p>
              {issueFor("expiresAt").map((issue) => (
                <p key={issue} className="text-xs leading-5 text-destructive">{issue}</p>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="run-authorization-note">{text.noteLabel}</Label>
              <Input
                id="run-authorization-note"
                name="run-authorization-note"
                value={props.note}
                maxLength={RUN_AUTHORIZATION_NOTE_MAX}
                aria-invalid={issueFor("note").length > 0}
                onChange={(event) => props.onNote(event.target.value)}
              />
              {issueFor("note").map((issue) => (
                <p key={issue} className="text-xs leading-5 text-destructive">{issue}</p>
              ))}
            </div>
          </div>
          <Button type="submit" data-testid="run-authorization-authorize" disabled={!actions.authorize || busy}>
            {props.pending === "authorize" ? "…" : view && view.status === "active" ? text.reauthorize : text.authorize}
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">{text.notRun}</p>
        </form>

        {props.feedback ? (
          <p
            role="status"
            aria-live="polite"
            data-testid="run-authorization-feedback"
            className={props.feedback.ok ? "text-sm text-emerald-800" : "text-sm text-destructive"}
          >
            {props.feedback.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
