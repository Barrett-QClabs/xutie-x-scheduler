"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccountId } from "@/lib/account";
import type { AccountIdentityView, IdentityState } from "@/lib/account-identity";
import { api } from "@/lib/api";
import { explainError } from "@/lib/explain-error";
import {
  credentialsTestBody,
  DISPLAY_NAME_MAX,
  emptyManualIdentity,
  manualIdentityRequest,
  type IdentityIssue,
  type ManualIdentityInput,
} from "@/lib/identity-body";
import type { Locale, MessageKey } from "@/lib/messages";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

type Feedback = { ok: boolean; text: string } | null;

const STATE_KEYS: Record<IdentityState, { label: MessageKey; help: MessageKey }> = {
  confirmed: { label: "identityStateConfirmed", help: "identityHelpConfirmed" },
  missing: { label: "identityStateMissing", help: "identityHelpMissing" },
  conflict: { label: "identityStateConflict", help: "identityHelpConflict" },
  reserved: { label: "identityStateReserved", help: "identityHelpReserved" },
};

const SOURCE_KEYS: Record<string, MessageKey> = {
  verify: "identitySourceVerify",
  manual: "identitySourceManual",
  evidence: "identitySourceEvidence",
  legacy: "identitySourceLegacy",
};

/**
 * Identity of the visible slot: stored state from `GET /api/credentials/identity`, an explicit
 * re-verify (`POST /api/credentials/test` with `reverify: true`), and the manual fallback
 * (`PUT /api/credentials/identity`). Every request names the slot that was visible when it started.
 */
export function IdentityPanel(props: {
  accountId: AccountId;
  mockMode: boolean;
  /** Bump after the credentials change so the stored identity is read again. */
  version: number;
  onChanged: () => void | Promise<void>;
}) {
  const { accountId, mockMode, version, onChanged } = props;
  const { t, locale } = useI18n();
  const [views, setViews] = useState<Record<AccountId, AccountIdentityView | null>>({ 1: null, 2: null });
  const [loadErrors, setLoadErrors] = useState<Record<AccountId, string | null>>({ 1: null, 2: null });
  const [forms, setForms] = useState<Record<AccountId, ManualIdentityInput>>({ 1: emptyManualIdentity(), 2: emptyManualIdentity() });
  const [issues, setIssues] = useState<Record<AccountId, IdentityIssue[]>>({ 1: [], 2: [] });
  const [messages, setMessages] = useState<Record<AccountId, Feedback>>({ 1: null, 2: null });
  const [busySlot, setBusySlot] = useState<AccountId | null>(null);

  const note = useCallback((target: AccountId, value: Feedback) => {
    setMessages((current) => ({ ...current, [target]: value }));
  }, []);

  const load = useCallback(async (target: AccountId) => {
    try {
      const view = await api<AccountIdentityView>(`/api/credentials/identity?accountId=${target}`);
      if (view.accountId !== target) return;
      setViews((current) => ({ ...current, [target]: view }));
      setLoadErrors((current) => ({ ...current, [target]: null }));
    } catch (error) {
      setLoadErrors((current) => ({ ...current, [target]: error instanceof Error ? error.message : "" }));
    }
  }, []);

  useEffect(() => {
    void load(accountId);
  }, [accountId, version, load]);

  async function reverify() {
    const target = accountId;
    setBusySlot(target);
    note(target, null);
    try {
      const result = await api<{ username: string; userId: string }>("/api/credentials/test", {
        method: "POST",
        body: JSON.stringify(credentialsTestBody(target, { reverify: true })),
      });
      note(target, { ok: true, text: t("identityReverifyOk", { handle: result.username, id: result.userId }) });
      await load(target);
      await onChanged();
    } catch (error) {
      const explained = explainError(error, locale, t);
      // Live read failures already name the manual endpoint; add the page's own hint otherwise.
      const hint = explained.includes("/api/credentials/identity") ? "" : ` ${t("identityFallback")}`;
      note(target, { ok: false, text: `${explained}${hint}` });
      await load(target);
    } finally {
      setBusySlot((current) => (current === target ? null : current));
    }
  }

  async function saveManual() {
    const target = accountId;
    const request = manualIdentityRequest(target, forms[target]);
    setIssues((current) => ({ ...current, [target]: request.issues }));
    if (!request.body) {
      note(target, { ok: false, text: request.issues.map((issue) => issue[locale]).join(" ") });
      return;
    }
    setBusySlot(target);
    note(target, null);
    try {
      const view = await api<AccountIdentityView>("/api/credentials/identity", {
        method: "PUT",
        body: JSON.stringify(request.body),
      });
      if (view.accountId !== target) throw new Error(t("requestFailed"));
      setViews((current) => ({ ...current, [target]: view }));
      setForms((current) => ({ ...current, [target]: emptyManualIdentity() }));
      note(target, { ok: true, text: t("identityManualOk", { handle: view.username ?? "", id: view.userId ?? "" }) });
      await onChanged();
    } catch (error) {
      note(target, { ok: false, text: explainError(error, locale, t) });
    } finally {
      setBusySlot((current) => (current === target ? null : current));
    }
  }

  return (
    <IdentityCard
      t={t}
      locale={locale}
      accountId={accountId}
      view={views[accountId]}
      loadError={loadErrors[accountId]}
      form={forms[accountId]}
      issues={issues[accountId]}
      busy={busySlot === accountId}
      mockMode={mockMode}
      message={messages[accountId]}
      onField={(key, value) => {
        const editing = accountId;
        setForms((current) => ({ ...current, [editing]: { ...current[editing], [key]: value } }));
      }}
      onReverify={() => void reverify()}
      onSaveManual={() => void saveManual()}
      onRefresh={() => void load(accountId)}
    />
  );
}

/** Presentational identity card. */
export function IdentityCard(props: {
  t: Translate;
  locale: Locale;
  accountId: AccountId;
  view: AccountIdentityView | null;
  loadError: string | null;
  form: ManualIdentityInput;
  issues: IdentityIssue[];
  busy: boolean;
  mockMode: boolean;
  message: Feedback;
  onField: (key: keyof ManualIdentityInput, value: string) => void;
  onReverify: () => void;
  onSaveManual: () => void;
  onRefresh: () => void;
}) {
  const { t, locale, accountId, view } = props;
  const slot = accountId;
  const configured = view?.credentialsConfigured === true;
  const state = view ? STATE_KEYS[view.state] : null;
  const issueFor = (field: keyof ManualIdentityInput) => props.issues.filter((issue) => issue.field === field).map((issue) => issue[locale]);
  const source = view?.source ? (SOURCE_KEYS[view.source] ? t(SOURCE_KEYS[view.source]) : view.source) : "—";
  const recorded = view?.verifiedAt && !Number.isNaN(Date.parse(view.verifiedAt))
    ? new Date(view.verifiedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-GB")
    : "—";

  return (
    <Card data-testid="identity-panel">
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-heading text-lg">{t("identityTitle")} · {slot === 1 ? "账号1" : "账号2"}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("identityIntro")}</p>
          </div>
          <div className="flex items-center gap-2">
            {view && state ? (
              <Badge variant={view.state === "confirmed" ? "default" : "destructive"} data-testid="identity-state">
                {t(state.label)}
              </Badge>
            ) : null}
            <Button type="button" size="xs" variant="ghost" onClick={props.onRefresh}>
              {t("identityRefresh")}
            </Button>
          </div>
        </div>

        {view && state ? (
          <div className="space-y-2">
            <p className={view.state === "confirmed" ? "text-sm" : "text-sm text-destructive"}>{t(state.help)}</p>
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2" data-testid="identity-details">
              <div><dt className="inline text-muted-foreground">{t("identityUserId")}：</dt><dd className="inline font-mono" data-testid="identity-user-id">{view.userId ?? "—"}</dd></div>
              <div><dt className="inline text-muted-foreground">{t("identityUsername")}：</dt><dd className="inline">{view.username ? `@${view.username}` : "—"}</dd></div>
              <div><dt className="inline text-muted-foreground">{t("identityDisplayName")}：</dt><dd className="inline">{view.displayName ?? "—"}</dd></div>
              <div><dt className="inline text-muted-foreground">{t("identitySource")}：</dt><dd className="inline">{source}</dd></div>
              <div><dt className="inline text-muted-foreground">{t("identityVerifiedAt")}：</dt><dd className="inline">{recorded}</dd></div>
              <div>
                <dt className="inline text-muted-foreground">{t("identityExecution")}：</dt>
                <dd className={view.executionAllowed ? "inline text-emerald-800" : "inline text-destructive"} data-testid="identity-execution">
                  {view.executionAllowed ? t("identityExecutionAllowed") : t("identityExecutionBlocked")}
                </dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className={props.loadError !== null ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {props.loadError !== null ? props.loadError || t("requestFailed") : t("identityLoading")}
          </p>
        )}

        <div className="space-y-1">
          <Button type="button" variant="outline" data-testid="identity-reverify" disabled={props.busy || !configured} onClick={props.onReverify}>
            {props.busy ? t("working") : t("identityReverify")}
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("identityReverifyHelp")}
            {props.mockMode ? ` ${t("identityReverifyMock")}` : ""}
          </p>
        </div>

        <form
          key={slot}
          className="space-y-3 rounded-lg border px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSaveManual();
          }}
        >
          <p className="text-sm font-medium">{t("identityManualTitle")}</p>
          <p className="text-xs leading-5 text-muted-foreground">{configured ? t("identityManualHelp") : t("identityManualNeedsCreds")}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <ManualField
              id={`identity-userId-${slot}`}
              label={t("identityUserId")}
              placeholder={view?.userId ?? t("identityUserIdHint")}
              value={props.form.userId}
              inputMode="numeric"
              issues={issueFor("userId")}
              disabled={!configured}
              onChange={(value) => props.onField("userId", value)}
            />
            <ManualField
              id={`identity-username-${slot}`}
              label={t("identityUsername")}
              placeholder={view?.username ? `@${view.username}` : t("identityUsernameHint")}
              value={props.form.username}
              issues={issueFor("username")}
              disabled={!configured}
              onChange={(value) => props.onField("username", value)}
            />
            <ManualField
              id={`identity-displayName-${slot}`}
              label={t("identityDisplayName")}
              placeholder={t("identityDisplayNameHint")}
              value={props.form.displayName}
              maxLength={DISPLAY_NAME_MAX}
              issues={issueFor("displayName")}
              disabled={!configured}
              onChange={(value) => props.onField("displayName", value)}
            />
          </div>
          <Button
            type="submit"
            data-testid="identity-manual-save"
            disabled={props.busy || !configured || !props.form.userId.trim() || !props.form.username.trim()}
          >
            {props.busy ? t("working") : `${t("identityManualSave")} · ${slot === 1 ? "账号1" : "账号2"}`}
          </Button>
        </form>

        {props.message ? (
          <p
            role="status"
            aria-live="polite"
            data-testid="identity-message"
            className={props.message.ok ? "text-sm text-emerald-800" : "text-sm text-destructive"}
          >
            {props.message.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ManualField(props: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  issues: string[];
  disabled: boolean;
  inputMode?: "numeric";
  maxLength?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        name={props.id}
        value={props.value}
        placeholder={props.placeholder}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        disabled={props.disabled}
        aria-invalid={props.issues.length > 0}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.issues.map((issue) => (
        <p key={issue} className="text-xs leading-5 text-destructive">{issue}</p>
      ))}
    </div>
  );
}
