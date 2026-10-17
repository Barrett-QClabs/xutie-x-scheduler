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

export function SettingsScreen() {
  const { t, locale } = useI18n();
  const { state, refresh } = useAppState();
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  function setField(key: keyof typeof empty, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function saveAndTest() {
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/credentials", { method: "PUT", body: JSON.stringify(form) });
      const result = await api<{ username: string }>("/api/credentials/test", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setOk(true);
      setMessage(t("testOk", { handle: result.username }));
      setForm(empty);
      await refresh();
    } catch (error) {
      setOk(false);
      setMessage(explainError(error, locale, t));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function retest() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ username: string }>("/api/credentials/test", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setOk(true);
      setMessage(t("testOk", { handle: result.username }));
      await refresh();
    } catch (error) {
      setOk(false);
      setMessage(explainError(error, locale, t));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/credentials", { method: "DELETE" });
      setConfirmClear(false);
      setOk(true);
      setMessage(t("notConfigured"));
      await refresh();
    } catch (error) {
      setOk(false);
      setMessage(explainError(error, locale, t));
    } finally {
      setBusy(false);
    }
  }

  const filled = Object.values(form).every((value) => value.trim().length > 0);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="font-heading text-3xl tracking-wide">{t("settingsTitle")}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("settingsIntro")}</p>
      </header>

      {state?.mockMode ? (
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm leading-6">{t("mockBanner")}</p>
      ) : null}

      <Card>
        <CardContent className="space-y-2">
          <p className="text-sm">{state?.credentialsConfigured ? t("configured") : t("notConfigured")}</p>
          {state?.account ? (
            <p className="font-heading text-2xl">@{state.account.username}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("notConnected")}</p>
          )}
          {state?.account?.displayName ? (
            <p className="text-sm text-muted-foreground">{state.account.displayName}</p>
          ) : null}
        </CardContent>
      </Card>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void saveAndTest();
        }}
      >
        <SecretField id="apiKey" label={t("apiKey")} value={form.apiKey} onChange={(value) => setField("apiKey", value)} />
        <SecretField
          id="apiSecret"
          label={t("apiSecret")}
          value={form.apiSecret}
          onChange={(value) => setField("apiSecret", value)}
        />
        <SecretField
          id="accessToken"
          label={t("accessToken")}
          value={form.accessToken}
          onChange={(value) => setField("accessToken", value)}
        />
        <SecretField
          id="accessTokenSecret"
          label={t("accessTokenSecret")}
          value={form.accessTokenSecret}
          onChange={(value) => setField("accessTokenSecret", value)}
        />
        <p className="text-xs leading-5 text-muted-foreground">{t("secretHint")}</p>
        <p className="text-xs leading-5 text-destructive">{t("bearerWarn")}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !filled}>
            {busy ? t("working") : t("saveAndTest")}
          </Button>
          <Button type="button" variant="outline" disabled={busy || !state?.credentialsConfigured} onClick={() => void retest()}>
            {t("retest")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy || !state?.credentialsConfigured}
            onClick={() => setConfirmClear(true)}
          >
            {t("clearCreds")}
          </Button>
        </div>
        {message ? <p className={ok ? "text-sm text-emerald-800" : "text-sm text-destructive"}>{message}</p> : null}
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
        name={id}
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
