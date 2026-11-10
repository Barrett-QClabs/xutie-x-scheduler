"use client";

import { useState } from "react";
import { useAppState } from "@/components/app-state";
import { useI18n } from "@/components/i18n-provider";
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
import { api } from "@/lib/api";
import { explainError } from "@/lib/explain-error";

const empty = { apiKey: "", apiSecret: "", accessToken: "", accessTokenSecret: "" };
type Fields = typeof empty;
type Slot = 1 | 2;

const blankForms = (): Record<Slot, Fields> => ({ 1: { ...empty }, 2: { ...empty } });

export function SettingsScreen() {
  const { t, locale } = useI18n();
  const { state, refresh, accountId, setAccountId } = useAppState();
  const [forms, setForms] = useState(blankForms);
  const [busySlot, setBusySlot] = useState<Slot | null>(null);
  const [messages, setMessages] = useState<Record<Slot, { ok: boolean; text: string } | null>>({ 1: null, 2: null });
  const [confirmClear, setConfirmClear] = useState(false);
  const slot = accountId;
  const form = forms[slot];
  const message = messages[slot];

  function setField(key: keyof Fields, value: string) {
    const editing = slot;
    setForms((current) => ({ ...current, [editing]: { ...current[editing], [key]: value } }));
  }

  function note(target: Slot, ok: boolean, text: string | null) {
    setMessages((current) => ({ ...current, [target]: text === null ? null : { ok, text } }));
  }

  async function saveAndTest() {
    const target = slot;
    const payload = { ...forms[target] };
    setBusySlot(target);
    note(target, false, null);
    try {
      await api("/api/credentials", { method: "PUT", body: JSON.stringify({ ...payload, accountId: target }) });
      const result = await api<{ username: string }>("/api/credentials/test", {
        method: "POST",
        body: JSON.stringify({ accountId: target }),
      });
      note(target, true, t("testOk", { handle: result.username }));
      setForms((current) => ({ ...current, [target]: { ...empty } }));
      await refresh();
    } catch (error) {
      note(target, false, explainError(error, locale, t));
      await refresh();
    } finally {
      setBusySlot((current) => (current === target ? null : current));
    }
  }

  async function retest() {
    const target = slot;
    setBusySlot(target);
    note(target, false, null);
    try {
      const result = await api<{ username: string }>("/api/credentials/test", {
        method: "POST",
        body: JSON.stringify({ accountId: target }),
      });
      note(target, true, t("testOk", { handle: result.username }));
      await refresh();
    } catch (error) {
      note(target, false, explainError(error, locale, t));
    } finally {
      setBusySlot((current) => (current === target ? null : current));
    }
  }

  async function clear() {
    const target = slot;
    setBusySlot(target);
    note(target, false, null);
    try {
      await api(`/api/credentials?accountId=${target}`, { method: "DELETE" });
      setConfirmClear(false);
      note(target, true, t("notConfigured"));
      setForms((current) => ({ ...current, [target]: { ...empty } }));
      await refresh();
    } catch (error) {
      note(target, false, explainError(error, locale, t));
    } finally {
      setBusySlot((current) => (current === target ? null : current));
    }
  }

  const slotReady = state?.accountId === slot;
  const slotLabel = slot === 1 ? "账号1" : "账号2";
  const busy = busySlot === slot;
  const filled = Object.values(form).every((value) => value.trim().length > 0);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="font-heading text-3xl tracking-wide">{t("settingsTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="slot-label">
          {slotLabel}
        </p>
        <div className="mt-3 flex gap-2">
          {([1, 2] as const).map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`settings-slot-${id}`}
              onClick={() => setAccountId(id)}
              className={`rounded-lg px-3 py-2 text-sm ${slot === id ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            >
              {id === 1 ? "账号1" : "账号2"}
            </button>
          ))}
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("settingsIntro")}</p>
      </header>

      {state?.mockMode ? (
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm leading-6">{t("mockBanner")}</p>
      ) : null}

      <Card>
        <CardContent className="space-y-2">
          <p className="text-sm">
            {slotReady ? (state?.credentialsConfigured ? t("configured") : t("notConfigured")) : t("loading")}
          </p>
          {slotReady && state?.account ? (
            <p className="font-heading text-2xl" data-testid="connected-handle">
              @{state.account.username}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{slotReady ? t("notConnected") : null}</p>
          )}
          {slotReady && state?.account?.displayName ? (
            <p className="text-sm text-muted-foreground">{state.account.displayName}</p>
          ) : null}
        </CardContent>
      </Card>

      <form
        key={slot}
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void saveAndTest();
        }}
      >
        <SecretField id={`apiKey-${slot}`} label={t("apiKey")} value={form.apiKey} onChange={(value) => setField("apiKey", value)} />
        <SecretField
          id={`apiSecret-${slot}`}
          label={t("apiSecret")}
          value={form.apiSecret}
          onChange={(value) => setField("apiSecret", value)}
        />
        <SecretField
          id={`accessToken-${slot}`}
          label={t("accessToken")}
          value={form.accessToken}
          onChange={(value) => setField("accessToken", value)}
        />
        <SecretField
          id={`accessTokenSecret-${slot}`}
          label={t("accessTokenSecret")}
          value={form.accessTokenSecret}
          onChange={(value) => setField("accessTokenSecret", value)}
        />
        <p className="text-xs leading-5 text-muted-foreground">{t("secretHint")}</p>
        <p className="text-xs leading-5 text-destructive">{t("bearerWarn")}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" data-testid="save-and-test" disabled={busy || !filled || !slotReady}>
            {busy ? t("working") : `${t("saveAndTest")} · ${slotLabel}`}
          </Button>
          <Button type="button" variant="outline" disabled={busy || !slotReady || !state?.credentialsConfigured} onClick={() => void retest()}>
            {t("retest")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy || !slotReady || !state?.credentialsConfigured}
            onClick={() => setConfirmClear(true)}
          >
            {t("clearCreds")}
          </Button>
        </div>
        {message ? <p className={message.ok ? "text-sm text-emerald-800" : "text-sm text-destructive"}>{message.text}</p> : null}
      </form>

      <details className="rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
        <summary className="cursor-pointer text-sm font-medium">{t("howToTitle")}</summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
          <li>{t("step1")}</li>
          <li>{t("step2")}</li>
          <li>{t("step3")}</li>
          <li>{t("step4")}</li>
        </ol>
      </details>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("clearTitle")}</DialogTitle>
            <DialogDescription>{t("clearBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmClear(false)}>
              {t("cancel")}
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void clear()}>
              {t("clearCreds")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SecretField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={`${id}`}
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
