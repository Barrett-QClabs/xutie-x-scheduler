"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAppState } from "@/components/app-state";
import { useI18n } from "@/components/i18n-provider";
import { LengthMeter } from "@/components/length-meter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { MAX_IMPORT_BATCH } from "@/lib/constants";
import { formatMinSec, toDatetimeLocal } from "@/lib/datetime";
import { explainError } from "@/lib/explain-error";
import type { MessageKey } from "@/lib/messages";
import { parseImport } from "@/lib/parse-import";
import type { ImportMode, InvalidTweet } from "@/lib/types";
import { cn } from "@/lib/utils";
import { inspectTweet } from "@/lib/weighted-length";

const MODE_KEYS: Record<ImportMode, MessageKey> = {
  lines: "modeLines",
  paragraphs: "modeParagraphs",
  separator: "modeSeparator",
  csv: "modeCsv",
};

export function ImportScreen() {
  const { t, locale } = useI18n();
  const { state, refresh } = useAppState();
  const [source, setSource] = useState("");
  const [format, setFormat] = useState<"text" | "csv">("text");
  const [startAt, setStartAt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(String(state?.queue.intervalMinutes ?? 15));
  const [randomMinSeconds, setRandomMinSeconds] = useState(String(state?.queue.randomMinSeconds ?? 60));
  const [randomMaxSeconds, setRandomMaxSeconds] = useState(String(state?.queue.randomMaxSeconds ?? 120));
  const [scheduleSynced, setScheduleSynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!state || scheduleSynced) return;
    const pending = state.tweets.filter((tweet) => tweet.status === "pending");
    if (pending.length > 0) {
      const last = pending[pending.length - 1];
      setStartAt(
        toDatetimeLocal(
          new Date(
            new Date(last.scheduledAt).getTime() +
              state.queue.intervalMinutes * 60_000 +
              state.queue.randomMaxSeconds * 1000 +
              60_000,
          ),
        ),
      );
    } else {
      setStartAt(toDatetimeLocal(new Date(Date.now() + 2 * 60_000)));
    }
    setIntervalMinutes(String(state.queue.intervalMinutes));
    setRandomMinSeconds(String(state.queue.randomMinSeconds));
    setRandomMaxSeconds(String(state.queue.randomMaxSeconds));
    setScheduleSynced(true);
  }, [state, scheduleSynced]);

  const preview = useMemo(() => {
    const parsed = parseImport(source, format);
    let validSeen = 0;
    const items = parsed.tweets.map((text, index) => {
      const inspected = inspectTweet(text);
      const overCap = inspected.valid ? ++validSeen > MAX_IMPORT_BATCH : false;
      return { index, ...inspected, raw: text, overCap };
    });
    return { mode: parsed.mode, items };
  }, [source, format]);

  const validCount = preview.items.filter((item) => item.valid).length;
  const acceptedCount = Math.min(validCount, MAX_IMPORT_BATCH);
  const omittedCount = Math.max(0, validCount - MAX_IMPORT_BATCH);
  const invalidCount = preview.items.length - validCount;
  const longCount = preview.items.filter((item) => item.valid && item.isLong && !item.overCap).length;

  async function onUpload(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setSource(text);
    setFormat(file.name.toLowerCase().endsWith(".csv") ? "csv" : "text");
    setNotice(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ queuedCount: number; invalid: InvalidTweet[]; longCount?: number; omittedCount: number; batchLimit: number }>(
        "/api/tweets/import",
        {
        method: "POST",
        body: JSON.stringify({
          source,
          format,
          startAt: new Date(startAt).toISOString(),
          intervalMinutes: Number(intervalMinutes),
          randomMinSeconds: Number(randomMinSeconds),
          randomMaxSeconds: Number(randomMaxSeconds),
        }),
      });
      const limit = result.batchLimit || MAX_IMPORT_BATCH;
      if (result.omittedCount > 0 && result.invalid.length > 0) {
        setNotice(
          t("importCappedPartial", {
            count: result.queuedCount,
            skipped: result.invalid.length,
            omitted: result.omittedCount,
            limit,
          }),
        );
      } else if (result.omittedCount > 0) {
        setNotice(t("importCapped", { count: result.queuedCount, omitted: result.omittedCount, limit }));
      } else if (result.invalid.length > 0) {
        setNotice(t("importPartial", { count: result.queuedCount, skipped: result.invalid.length }));
      } else {
        setNotice(t("importDone", { count: result.queuedCount }));
      }
      if (result.longCount) {
        setNotice((current) => `${current ?? ""} ${t("importLong", { count: result.longCount ?? 0 })}`.trim());
      }
      if (result.invalid.length === 0 && result.omittedCount === 0) setSource("");
      await refresh();
    } catch (caught) {
      setError(explainError(caught, locale, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-heading text-3xl tracking-wide">{t("importTitle")}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{t("importSubtitle")}</p>
      </header>

      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t("importHint")}</p>
      <p className="text-xs text-muted-foreground">{t("lengthHint")}</p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant={format === "text" ? "default" : "outline"} onClick={() => setFormat("text")}>
          {t("formatText")}
        </Button>
        <Button type="button" variant={format === "csv" ? "default" : "outline"} onClick={() => setFormat("csv")}>
          {t("formatCsv")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setFormat("text");
            setSource(t("sample"));
          }}
        >
          {t("fillSample")}
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="posts">{t("pasteLabel")}</Label>
        <Textarea id="posts" value={source} onChange={(event) => setSource(event.target.value)} rows={12} className="min-h-64" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="file">{t("uploadLabel")}</Label>
        <Input
          id="file"
          type="file"
          accept=".txt,.csv,text/plain,text/csv"
          onChange={(event) => void onUpload(event.target.files?.[0])}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="start">{t("startAt")}</Label>
          <Input id="start" type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="interval">{t("intervalLabel")}</Label>
          <Input id="interval" inputMode="numeric" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="random-min">{`${t("randomLabel")} · ${t("randomMinLabel")}`}</Label>
          <Input
            id="random-min"
            inputMode="numeric"
            value={randomMinSeconds}
            onChange={(event) => setRandomMinSeconds(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="random-max">{`${t("randomLabel")} · ${t("randomMaxLabel")}`}</Label>
          <Input
            id="random-max"
            inputMode="numeric"
            value={randomMaxSeconds}
            onChange={(event) => setRandomMaxSeconds(event.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("randomHelp", {
          min: formatMinSec(Number(randomMinSeconds)),
          max: formatMinSec(Number(randomMaxSeconds)),
        })}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={busy || acceptedCount === 0 || !startAt} onClick={() => void submit()}>
          {busy ? t("working") : t("addToQueue", { count: acceptedCount })}
        </Button>
        {notice ? <span className="text-sm">{notice}</span> : null}
        {notice && !error ? (
          <Button nativeButton={false} variant="outline" render={<Link href="/" />}>
            {t("openQueue")}
          </Button>
        ) : null}
      </div>
      {omittedCount > 0 ? (
        <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm leading-6 text-amber-950">
          {t("batchCapWarning", { limit: MAX_IMPORT_BATCH, omitted: omittedCount })}
        </p>
      ) : null}
      {longCount > 0 ? (
        <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm leading-6 text-amber-950">
          {t("longPostPreview", { count: longCount })}
        </p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-heading text-xl">{t("preview")}</h2>
          <p className="text-xs text-muted-foreground">
            {preview.items.length === 0
              ? t("nothingParsed")
              : `${t(MODE_KEYS[preview.mode])} · ${t("summary", {
                  total: preview.items.length,
                  valid: validCount,
                  invalid: invalidCount,
                })}`}
          </p>
        </div>
        {preview.items.length > 0 ? (
          <ul className="max-h-[28rem] space-y-2 overflow-auto pr-1">
            {preview.items.map((item) => (
              <li key={`${item.index}-${item.raw.slice(0, 24)}`} className="rounded-lg bg-card px-3 py-2 ring-1 ring-foreground/10">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">{item.index + 1}</span>
                  <Badge
                    variant={item.valid && !item.overCap ? "outline" : "destructive"}
                    className={cn(item.valid && !item.overCap && "bg-emerald-100 text-emerald-950")}
                  >
                    {item.overCap
                      ? t("overCap", { limit: MAX_IMPORT_BATCH })
                      : item.valid
                        ? t("valid")
                        : item.reason === "too_long"
                          ? t("reasonTooLong")
                          : t("reasonEmpty")}
                  </Badge>
                  {item.valid && item.isLong && !item.overCap ? (
                    <Badge variant="outline" className="bg-amber-100 text-amber-950" title={t("longPostWarning")}>
                      {t("longPost")}
                    </Badge>
                  ) : null}
                  <LengthMeter text={item.raw} className="ml-auto" />
                </div>
                {item.valid && item.isLong && !item.overCap ? (
                  <p className="mb-1 text-xs text-amber-900">{t("longPostWarning")}</p>
                ) : null}
                <p className="whitespace-pre-wrap text-sm leading-6 break-words">{item.raw}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
