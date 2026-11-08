"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { useAppState } from "@/components/app-state";
import { useI18n } from "@/components/i18n-provider";
import { LengthMeter } from "@/components/length-meter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { SCHEDULER_STALE_MS } from "@/lib/constants";
import { formatMinSec, formatStamp } from "@/lib/datetime";
import { explainError } from "@/lib/explain-error";
import type { MessageKey } from "@/lib/messages";
import type { ActivityReport, FailureClass, PublicTweet } from "@/lib/types";
import { cn } from "@/lib/utils";
import { inspectTweet } from "@/lib/weighted-length";

export function QueueScreen() {
  const { t, locale } = useI18n();
  const { state, loading, loadError, refresh } = useAppState();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState("15");
  const [randomMinSeconds, setRandomMinSeconds] = useState("60");
  const [randomMaxSeconds, setRandomMaxSeconds] = useState("120");
  const [synced, setSynced] = useState(false);
  const [reschedule, setReschedule] = useState(false);
  const [editing, setEditing] = useState<PublicTweet | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<PublicTweet | null>(null);

  useEffect(() => {
    if (!state || synced) return;
    setIntervalMinutes(String(state.queue.intervalMinutes));
    setRandomMinSeconds(String(state.queue.randomMinSeconds));
    setRandomMaxSeconds(String(state.queue.randomMaxSeconds));
    setSynced(true);
  }, [state, synced]);

  const pendingIds = useMemo(
    () => (state?.tweets ?? []).filter((tweet) => tweet.status === "pending").map((tweet) => tweet.id),
    [state],
  );

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(explainError(caught, locale, t));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !state) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (loadError && !state) {
    return (
      <div className="space-y-3">
        <p className="text-sm">{t("loadError")}</p>
        <Button type="button" variant="outline" onClick={() => void refresh()}>
          {t("retryLoad")}
        </Button>
      </div>
    );
  }
  if (!state) return null;

  const next = state.tweets.find((tweet) => tweet.status === "pending");

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-3xl tracking-wide">{t("queueTitle")}</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{t("queueSubtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {state.queue.paused ? (
            <Button type="button" disabled={busy} onClick={() => void run(() => api("/api/queue/resume", { method: "POST" }))}>
              {t("resumeAll")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => api("/api/queue/pause", { method: "POST" }))}
            >
              {t("pauseAll")}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy || state.counts.failed === 0}
            onClick={() => void run(() => api("/api/queue/retry-failed", { method: "POST" }))}
          >
            {t("retryFailed")}
          </Button>
        </div>
      </header>

      {state.mockMode ? <Notice>{t("mockBanner")}</Notice> : null}
      {!state.credentialsConfigured && !state.mockMode ? <Notice>{t("needCreds")}</Notice> : null}
      {state.queue.paused ? <Notice tone="warn">{pauseCopy(state.queue.pauseReason, t)}</Notice> : null}
      {state.tweets.some((tweet) => tweet.status === "pending" && tweet.delayReason === "manual") ? (
        <Notice tone="warn">{t("manualDelayBanner")}</Notice>
      ) : null}
      {state.activity ? <ActivityPanel activity={state.activity} locale={locale} /> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}

      <div className="grid grid-cols-3 gap-3">
        <Stat label={t("statPending")} value={state.counts.pending} />
        <Stat label={t("statPosted")} value={state.counts.posted} />
        <Stat label={t("statFailed")} value={state.counts.failed} />
      </div>

      <Card>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {next ? <NextPost iso={next.scheduledAt} locale={locale} /> : t("noPending")}
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <Field label={t("intervalLabel")}>
              <Input
                inputMode="numeric"
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(event.target.value)}
              />
            </Field>
            <Field label={`${t("randomLabel")} · ${t("randomMinLabel")}`}>
              <Input
                inputMode="numeric"
                value={randomMinSeconds}
                onChange={(event) => setRandomMinSeconds(event.target.value)}
              />
            </Field>
            <Field label={`${t("randomLabel")} · ${t("randomMaxLabel")}`}>
              <Input
                inputMode="numeric"
                value={randomMaxSeconds}
                onChange={(event) => setRandomMaxSeconds(event.target.value)}
              />
            </Field>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api("/api/queue", {
                    method: "PUT",
                    body: JSON.stringify({
                      intervalMinutes: Number(intervalMinutes),
                      randomMinSeconds: Number(randomMinSeconds),
                      randomMaxSeconds: Number(randomMaxSeconds),
                      reschedule,
                    }),
                  }),
                )
              }
            >
              {t("saveSchedule")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("randomHelp", {
              min: formatMinSec(Number(randomMinSeconds)),
              max: formatMinSec(Number(randomMaxSeconds)),
            })}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={reschedule}
              onChange={(event) => setReschedule(event.target.checked)}
            />
            <span>
              {t("reschedulePending")}
              <span className="mt-1 block text-xs text-muted-foreground">{t("rescheduleHelp")}</span>
            </span>
          </label>
        </CardContent>
      </Card>

      {state.tweets.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-8">
            <h2 className="font-heading text-2xl">{t("emptyTitle")}</h2>
            <p className="max-w-md text-sm leading-6 text-muted-foreground">{t("emptyBody")}</p>
            <Button nativeButton={false} render={<Link href="/import" />}>
              {t("goImport")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ol className="space-y-3">
          {state.tweets.map((tweet) => {
            const pendingIndex = pendingIds.indexOf(tweet.id);
            return (
              <li key={tweet.id}>
                <article className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                  <div className="flex flex-wrap items-center gap-2">
                    <ClientTime iso={tweet.scheduledAt} locale={locale} />
                    <StatusBadge status={tweet.status} label={t(statusKey(tweet.status))} />
                    {tweet.failureClass && tweet.status !== "posted" ? (
                      <Badge variant="outline">{t(failureKey(tweet.failureClass))}</Badge>
                    ) : null}
                    {tweet.isLong ? (
                      <Badge variant="outline" className="bg-amber-100 text-amber-950">
                        {t("longPost")}
                      </Badge>
                    ) : null}
                  </div>
                  {tweet.isLong && tweet.status !== "posted" ? (
                    <p className="mt-2 text-sm text-amber-900">{t("longPostWarning")}</p>
                  ) : null}
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 break-words">{tweet.text}</p>
                  {tweet.status === "pending" && tweet.delayReason === "manual" ? (
                    <p className="mt-2 text-sm text-amber-900">{t("manualDelayRow")}</p>
                  ) : null}
                  {tweet.errorMessage ? <p className="mt-2 text-sm text-destructive">{tweet.errorMessage}</p> : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <LengthMeter text={tweet.text} />
                    {tweet.attemptCount > 0 && tweet.status !== "posted" ? (
                      <span className="text-xs text-muted-foreground">{t("attempts", { count: tweet.attemptCount })}</span>
                    ) : null}
                    <div className="ml-auto flex flex-wrap gap-1">
                      {tweet.status === "pending" ? (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy || pendingIndex <= 0}
                            onClick={() =>
                              void run(() =>
                                api("/api/tweets/reorder", {
                                  method: "POST",
                                  body: JSON.stringify({ id: tweet.id, direction: "up" }),
                                }),
                              )
                            }
                          >
                            <ArrowUp />
                            {t("moveUp")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy || pendingIndex === pendingIds.length - 1}
                            onClick={() =>
                              void run(() =>
                                api("/api/tweets/reorder", {
                                  method: "POST",
                                  body: JSON.stringify({ id: tweet.id, direction: "down" }),
                                }),
                              )
                            }
                          >
                            <ArrowDown />
                            {t("moveDown")}
                          </Button>
                        </>
                      ) : null}
                      {tweet.status !== "posted" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(tweet);
                            setDraft(tweet.text);
                          }}
                        >
                          <Pencil />
                          {t("edit")}
                        </Button>
                      ) : null}
                      {tweet.status === "failed" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run(() => api(`/api/tweets/${tweet.id}/retry`, { method: "POST" }))}
                        >
                          {t("retry")}
                        </Button>
                      ) : null}
                      {tweet.tweetUrl ? (
                        <Button
                          nativeButton={false}
                          size="sm"
                          variant="outline"
                          render={<a href={tweet.tweetUrl} target="_blank" rel="noreferrer" />}
                        >
                          <ExternalLink />
                          {t("viewPost")}
                        </Button>
                      ) : null}
                      <Button type="button" size="sm" variant="ghost" onClick={() => setDeleting(tweet)}>
                        <Trash2 />
                        {t("delete")}
                      </Button>
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("editTitle")}</DialogTitle>
            <DialogDescription>{t("editHelp")}</DialogDescription>
            <p className="text-sm text-muted-foreground">{t("draftEdit")}</p>
          </DialogHeader>
          <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={6} />
          <div className="flex items-center justify-between">
            <LengthMeter text={draft} />
            <span className="text-xs text-muted-foreground">{t("lengthHint")}</span>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              disabled={busy || !inspectTweet(draft).valid}
              onClick={() =>
                void run(async () => {
                  if (!editing) return;
                  await api(`/api/tweets/${editing.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ text: draft }),
                  });
                  setEditing(null);
                })
              }
            >
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>{t("deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!deleting) return;
                  await api(`/api/tweets/${deleting.id}`, { method: "DELETE" });
                  setDeleting(null);
                })
              }
            >
              {t("deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function pauseCopy(
  reason: string | null,
  t: (key: "pauseManual" | "pauseSafeStart" | "pauseMissing" | "pauseDecrypt" | "pauseKey") => string,
) {
  if (reason === "missing_credentials") return t("pauseMissing");
  if (reason === "decrypt_failed") return t("pauseDecrypt");
  if (reason === "encryption_key_missing") return t("pauseKey");
  if (reason === "safe_start") return t("pauseSafeStart");
  if (!reason || reason === "manual") return t("pauseManual");
  return reason;
}

function statusKey(status: PublicTweet["status"]) {
  if (status === "posted") return "statusPosted" as const;
  if (status === "failed") return "statusFailed" as const;
  return "statusPending" as const;
}

function ClientTime({ iso, locale }: { iso: string; locale: "zh" | "en" }) {
  const { t } = useI18n();
  const [label, setLabel] = useState("");
  const [rel, setRel] = useState("");
  useEffect(() => {
    setLabel(formatStamp(iso, locale));
    setRel(relative(iso, t));
  }, [iso, locale, t]);
  return (
    <>
      <time className="text-sm tabular-nums" dateTime={iso}>
        {label || "—"}
      </time>
      <span className="text-xs text-muted-foreground">{rel}</span>
    </>
  );
}

function NextPost({ iso, locale }: { iso: string; locale: "zh" | "en" }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  useEffect(() => {
    setText(t("nextPost", { time: formatStamp(iso, locale) }));
  }, [iso, locale, t]);
  return <>{text || "—"}</>;
}

function failureKey(kind: FailureClass): MessageKey {
  if (kind === "credits") return "failureCredits";
  if (kind === "rate_limit") return "failureRate";
  if (kind === "auth") return "failureAuth";
  if (kind === "duplicate") return "failureDuplicate";
  return "failureOther";
}

function tickKey(action: string | null): MessageKey | null {
  if (action === "paused") return "tickPaused";
  if (action === "rate_limited") return "tickRate";
  if (action === "credits_waiting") return "tickCredits";
  if (action === "busy") return "tickBusy";
  if (action === "idle") return "tickIdle";
  if (action === "no_credentials") return "tickNoCredentials";
  if (action === "posted") return "tickPosted";
  if (action === "failed") return "tickFailed";
  if (action === "auth_paused") return "tickAuth";
  if (action === "retry_later") return "tickRetry";
  if (action === "deferred") return "tickDeferred";
  return null;
}

function ActivityPanel({ activity, locale }: { activity: ActivityReport; locale: "zh" | "en" }) {
  const { t } = useI18n();
  const [blockTime, setBlockTime] = useState("");
  const [tickTime, setTickTime] = useState("");
  const [successTime, setSuccessTime] = useState("");
  const [nextTime, setNextTime] = useState("");
  useEffect(() => {
    setBlockTime(activity.blockUntil ? formatStamp(activity.blockUntil, locale) : "");
    setTickTime(activity.lastTickAt ? formatStamp(activity.lastTickAt, locale) : "");
    setSuccessTime(activity.lastSuccessAt ? formatStamp(activity.lastSuccessAt, locale) : "");
    setNextTime(activity.nextScheduledAt ? formatStamp(activity.nextScheduledAt, locale) : "");
  }, [activity, locale]);

  const actionKey = tickKey(activity.lastTickAction);
  const actionLabel = actionKey ? t(actionKey) : activity.lastTickAction || "";
  const phase = phaseText(activity, { blockTime, nextTime }, t);
  const extraBlock =
    activity.blockUntil && activity.phase !== "credits_waiting" && activity.phase !== "rate_limited"
      ? t("phaseBlockedToo", {
          time: blockTime || "—",
          reason: t(activity.lastError === "credits" ? "failureCredits" : "failureRate"),
        })
      : null;

  return (
    <section className="space-y-2 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10" aria-label={t("activityTitle")}>
      <h2 className="text-sm font-medium">{t("activityTitle")}</h2>
      <p className="text-sm leading-6">{phase}</p>
      {extraBlock ? <p className="text-sm leading-6">{extraBlock}</p> : null}
      <p className="text-sm leading-6 text-muted-foreground">
        {activity.scheduler === "unknown"
          ? t("schedulerUnknown")
          : activity.scheduler === "stale"
            ? t("schedulerStale", { time: tickTime || "—", seconds: Math.round(SCHEDULER_STALE_MS / 1000) })
            : t("schedulerRecent", { time: tickTime || "—", action: actionLabel })}
      </p>
      <p className="text-sm leading-6 text-muted-foreground">
        {activity.lastSuccessAt ? t("lastSuccess", { time: successTime || "—" }) : t("noSuccessYet")}
      </p>
      {activity.failed > 0 ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {t("failureBreakdown", {
            duplicate: activity.failureKinds.duplicate,
            auth: activity.failureKinds.auth,
            credits: activity.failureKinds.credits,
            rateLimit: activity.failureKinds.rate_limit,
            other: activity.failureKinds.other,
          })}
        </p>
      ) : null}
      {activity.other > 0 ? <p className="text-sm leading-6 text-muted-foreground">{t("otherRows", { count: activity.other })}</p> : null}
    </section>
  );
}

function phaseText(
  activity: ActivityReport,
  times: { blockTime: string; nextTime: string },
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
) {
  if (activity.phase === "empty") return t("phaseEmpty");
  if (activity.phase === "idle") return t("phaseIdle", { posted: activity.posted, failed: activity.failed });
  if (activity.phase === "paused") return t("phasePaused");
  if (activity.phase === "no_credentials") return t("phaseNoCredentials");
  if (activity.phase === "auth_blocked") return t("phaseAuth");
  if (activity.phase === "credits_waiting") return t("phaseCredits", { time: times.blockTime || "—" });
  if (activity.phase === "rate_limited") return t("phaseRate", { time: times.blockTime || "—" });
  if (activity.phase === "scheduled") return t("phaseScheduled", { count: activity.pending, time: times.nextTime || "—" });
  return t("phaseDue", { count: activity.dueCount });
}

function relative(
  iso: string,
  t: (key: "dueNow" | "inMinutes" | "overdueMinutes", vars?: Record<string, string | number>) => string,
) {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes > 1) return t("inMinutes", { count: minutes });
  if (minutes < -1) return t("overdueMinutes", { count: Math.abs(minutes) });
  return t("dueNow");
}

function StatusBadge({ status, label }: { status: PublicTweet["status"]; label: string }) {
  return (
    <Badge
      variant={status === "failed" ? "destructive" : "outline"}
      className={cn(
        status === "pending" && "border-amber-800/20 bg-amber-100 text-amber-950",
        status === "posted" && "border-emerald-800/20 bg-emerald-100 text-emerald-950",
      )}
    >
      {label}
    </Badge>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-card px-3 py-3 ring-1 ring-foreground/10">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-heading text-2xl tabular-nums">{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" | "bad" }) {
  return (
    <p
      role="status"
      className={cn(
        "rounded-lg px-3 py-2 text-sm leading-6",
        tone === "info" && "bg-secondary text-secondary-foreground",
        tone === "warn" && "bg-amber-100 text-amber-950",
        tone === "bad" && "bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </p>
  );
}
