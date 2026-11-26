"use client";

import { useCallback, useEffect, useState } from "react";
import { TimezoneField } from "@/components/timezone-picker";
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
import type { AccountId } from "@/lib/account";
import { api, ApiError } from "@/lib/api";
import type { AutomationSettings, AutomationSettingsView } from "@/lib/automation-settings";
import {
  buildSettingsPatch,
  describeChanges,
  describeLane,
  draftFromSettings,
  draftMatches,
  fieldLabel,
  FILTER_KEYS,
  issuesFor,
  serverSettingsIssues,
  settingsPutBody,
  type FormIssue,
  type LaneDraft,
  type SettingsDraft,
  type SettingsLane,
} from "@/lib/automation-settings-form";
import { SETTINGS_LIMITS } from "@/lib/automation-settings-limits";
import type { Locale } from "@/lib/messages";
import { formatInZone } from "@/lib/run-authorization-body";

const ZH = {
  title: "自动化设置",
  intro: "按账号保存，只写当前选中的账号，另一个账号不受影响。执行读这里保存的值。保存只是配置：不会开始运行，也不会恢复已暂停的关注或取关。",
  stored: "已保存",
  defaults: "默认值",
  updatedAt: "更新于",
  loading: "正在读取自动化设置…",
  retry: "重试",
  zones: "时区",
  scheduleZone: "排程时区",
  scheduleZoneHelp: "时间窗、锚点和槽位按这个时区计。",
  quotaZone: "日上限时区",
  quotaZoneHelp: "每日上限和每日统计在这个时区的午夜重置。可以和排程时区不同。",
  mutualExclusion: "关注与取关互斥",
  mutualHelp: "开启时关注窗和取关窗不能重叠，两条线都不会在对方的窗口里运行。",
  follow: "关注",
  unfollow: "取关",
  batchFollow: "每轮人数",
  batchUnfollow: "每批人数",
  dailyCap: "日上限",
  noCap: "不设日上限",
  workMinutes: "工作分钟",
  restMinutes: "休息分钟",
  anchor: "锚点",
  windows: "时间窗",
  start: "开始",
  end: "结束",
  addWindow: "添加时间窗",
  removeWindow: "删除",
  windowHelp: "按排程时区填 HH:MM，也可以填分钟数。结束早于开始表示跨过午夜；整天是 00:00–24:00；24:00 只能作结束。工作/休息网格每天从锚点重新开始，只在时间窗内的网格起点开槽。",
  defaultsLine: "默认",
  filters: "关注过滤",
  filterBlue: "关注前要求蓝V（Blue Verified）",
  filterLanguage: (accountId: AccountId) => `新关注要求受众语言（${accountId === 1 ? "中文" : "英文"}）`,
  filterActivity: "新关注要求最新公开帖在 12 小时内",
  preview: "当前状态（按已保存的设置）",
  previewAt: "读取于",
  slotWork: "工作槽",
  slotRest: "窗口内，休息中",
  slotClosed: "窗口外",
  quotaDay: "日上限日",
  scheduleDay: "排程日",
  refresh: "刷新状态",
  pending: "将提交：",
  clean: "没有未保存的修改。",
  noChanges: "没有改动，没有提交。",
  save: "保存设置",
  saving: "保存中…",
  discard: "放弃修改",
  reset: "恢复默认",
  resetTitle: (accountId: AccountId) => `恢复账号${accountId}的默认设置？`,
  resetBody: "会删除这个账号已保存的自动化设置，改回默认值（账号1还会沿用旧版保存的日池数字）。另一个账号不受影响。未保存的修改会丢弃。这不会开始运行。",
  cancel: "取消",
  saved: (accountId: AccountId, changes: string) => `已保存账号${accountId}的自动化设置：${changes}。这只是配置，没有开始运行。`,
  resetDone: (accountId: AccountId) => `已恢复账号${accountId}的默认设置。这只是配置，没有开始运行。`,
  fixFirst: "有字段需要修改，这次没有保存：",
  rejected: "服务器拒绝了这次保存，修改仍留在表单里：",
  failed: "请求没有完成。",
  moved: "你开始编辑之后，服务器上的设置变了。保存只提交你改过的字段，其他字段沿用服务器上的值。",
  invalidStored: "已保存的设置里有无法使用的字段，这些字段正在用默认值：",
  limits: () => {
    const l = SETTINGS_LIMITS;
    return `范围：每轮 / 每批 ${l.batchSize.min}–${l.batchSize.max} 人；关注日上限 ${l.followDailyCap.min}–${l.followDailyCap.max}；取关日上限 ${l.unfollowDailyCap.min}–${l.unfollowDailyCap.max} 或不设；工作 ${l.workMinutes.min}–${l.workMinutes.max} 分钟；休息 ${l.restMinutes.min}–${l.restMinutes.max} 分钟；工作加休息不超过 ${l.cycleMinutes.max} 分钟；每条线 ${l.windows.min}–${l.windows.max} 个时间窗。`;
  },
};

type PanelText = typeof ZH;

const EN: PanelText = {
  title: "Automation settings",
  intro: "Saved per account. Only the selected account is written; the other one is not touched. Execution reads these saved values. Saving is configuration only: it does not start a run or resume a paused follow or unfollow lane.",
  stored: "saved",
  defaults: "defaults",
  updatedAt: "updated",
  loading: "Loading automation settings…",
  retry: "Retry",
  zones: "Time zones",
  scheduleZone: "Schedule time zone",
  scheduleZoneHelp: "Windows, anchors, and slots use this zone.",
  quotaZone: "Quota time zone",
  quotaZoneHelp: "Daily caps and daily stats reset at midnight in this zone. It can differ from the schedule zone.",
  mutualExclusion: "Follow / unfollow mutual exclusion",
  mutualHelp: "When on, follow and unfollow windows must not overlap, and neither lane runs inside the other's window.",
  follow: "Follow",
  unfollow: "Unfollow",
  batchFollow: "Per round",
  batchUnfollow: "Per batch",
  dailyCap: "Daily cap",
  noCap: "No daily cap",
  workMinutes: "Work minutes",
  restMinutes: "Rest minutes",
  anchor: "Anchor",
  windows: "Windows",
  start: "Start",
  end: "End",
  addWindow: "Add window",
  removeWindow: "Remove",
  windowHelp: "HH:MM in the schedule zone, or minutes after midnight. An end before the start wraps past midnight; the whole day is 00:00–24:00; 24:00 is only valid as an end. The work/rest grid restarts at the anchor every day, and a slot opens only on a grid start inside a window.",
  defaultsLine: "Defaults",
  filters: "Follow filters",
  filterBlue: "Require Blue Verified before a follow",
  filterLanguage: (accountId: AccountId) => `Require the audience language for new follows (${accountId === 1 ? "Chinese" : "English"})`,
  filterActivity: "Require a public post in the last 12 hours for new follows",
  preview: "Current state (saved settings)",
  previewAt: "read at",
  slotWork: "work slot",
  slotRest: "inside the window, resting",
  slotClosed: "outside the window",
  quotaDay: "Quota day",
  scheduleDay: "Schedule day",
  refresh: "Refresh state",
  pending: "Will save: ",
  clean: "No unsaved changes.",
  noChanges: "Nothing changed, nothing was sent.",
  save: "Save settings",
  saving: "Saving…",
  discard: "Discard changes",
  reset: "Reset to defaults",
  resetTitle: (accountId: AccountId) => `Reset account ${accountId} to defaults?`,
  resetBody: "This deletes the saved automation settings for this account and goes back to the defaults (account 1 also keeps the legacy saved daily-pool numbers). The other account is not touched. Unsaved changes are discarded. This does not start a run.",
  cancel: "Cancel",
  saved: (accountId: AccountId, changes: string) => `Saved account ${accountId} automation settings: ${changes}. This is configuration only and does not start a run.`,
  resetDone: (accountId: AccountId) => `Account ${accountId} is back on its defaults. This is configuration only and does not start a run.`,
  fixFirst: "Some fields need fixing, so nothing was saved: ",
  rejected: "The server refused this save. Your edits are still in the form: ",
  failed: "The request did not finish.",
  moved: "The saved settings changed on the server after you started editing. Saving sends only the fields you changed; every other field keeps the server's value.",
  invalidStored: "Some saved fields could not be used and are running on defaults: ",
  limits: () => {
    const l = SETTINGS_LIMITS;
    return `Limits: batch ${l.batchSize.min}–${l.batchSize.max}; follow daily cap ${l.followDailyCap.min}–${l.followDailyCap.max}; unfollow daily cap ${l.unfollowDailyCap.min}–${l.unfollowDailyCap.max} or none; work ${l.workMinutes.min}–${l.workMinutes.max} min; rest ${l.restMinutes.min}–${l.restMinutes.max} min; work plus rest at most ${l.cycleMinutes.max} min; ${l.windows.min}–${l.windows.max} windows per lane.`;
  },
};

const TEXT: Record<Locale, PanelText> = { zh: ZH, en: EN };

type Feedback = { ok: boolean; text: string } | null;

type SlotState = {
  /** Latest payload from the server (saved settings, defaults, preview). */
  view: AutomationSettingsView;
  /** Saved settings the draft was started from. Saves send only what differs from this. */
  base: AutomationSettings;
  draft: SettingsDraft;
};

function withLane(draft: SettingsDraft, lane: SettingsLane, patch: Partial<LaneDraft>): SettingsDraft {
  return lane === "follow"
    ? { ...draft, follow: { ...draft.follow, ...patch } }
    : { ...draft, unfollow: { ...draft.unfollow, ...patch } };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Per-account automation settings. Reads and writes `/api/automation/settings` for the visible
 * account only, keeps unsaved edits per account, and saves only the fields that were changed.
 */
export function AutomationSettingsPanel(props: {
  accountId: AccountId;
  locale: Locale;
  onView?: (view: AutomationSettingsView) => void;
  /** Bump to re-read the saved settings (unsaved edits are kept). */
  reloadKey?: number;
}) {
  const { accountId, locale, onView, reloadKey = 0 } = props;
  const text = TEXT[locale];
  const [slots, setSlots] = useState<Record<AccountId, SlotState | null>>({ 1: null, 2: null });
  const [serverIssues, setServerIssues] = useState<Record<AccountId, FormIssue[]>>({ 1: [], 2: [] });
  const [feedback, setFeedback] = useState<Record<AccountId, Feedback>>({ 1: null, 2: null });
  const [loadError, setLoadError] = useState<Record<AccountId, string | null>>({ 1: null, 2: null });
  const [busySlot, setBusySlot] = useState<AccountId | null>(null);
  const [resetTarget, setResetTarget] = useState<AccountId | null>(null);

  const note = useCallback((target: AccountId, value: Feedback) => {
    setFeedback((current) => ({ ...current, [target]: value }));
  }, []);

  const load = useCallback(async (target: AccountId) => {
    try {
      const view = await api<AutomationSettingsView>(`/api/automation/settings?accountId=${target}`);
      if (view.accountId !== target) return;
      setSlots((current) => {
        const previous = current[target];
        if (previous && !draftMatches(previous.draft, previous.base)) {
          return { ...current, [target]: { ...previous, view } };
        }
        return { ...current, [target]: { view, base: view.settings, draft: draftFromSettings(view.settings) } };
      });
      setLoadError((current) => ({ ...current, [target]: null }));
      onView?.(view);
    } catch (error) {
      // "" means the request failed without a message; the render picks the localized fallback.
      setLoadError((current) => ({ ...current, [target]: errorText(error, "") }));
    }
  }, [onView]);

  useEffect(() => {
    void load(accountId);
  }, [accountId, load, reloadKey]);

  function updateDraft(target: AccountId, update: (draft: SettingsDraft) => SettingsDraft) {
    setSlots((current) => {
      const slot = current[target];
      return slot ? { ...current, [target]: { ...slot, draft: update(slot.draft) } } : current;
    });
    setServerIssues((current) => (current[target].length ? { ...current, [target]: [] } : current));
  }

  async function save() {
    const target = accountId;
    const slot = slots[target];
    if (!slot || busySlot === target) return;
    const sent = slot.draft;
    const result = buildSettingsPatch(slot.base, sent);
    if (result.issues.length > 0) {
      note(target, { ok: false, text: `${text.fixFirst}${result.issues.map((issue) => issue[locale]).join(locale === "zh" ? "；" : "; ")}` });
      return;
    }
    if (result.changes.length === 0) {
      note(target, { ok: true, text: text.noChanges });
      return;
    }
    setBusySlot(target);
    note(target, null);
    try {
      const view = await api<AutomationSettingsView>("/api/automation/settings", {
        method: "PUT",
        body: JSON.stringify(settingsPutBody(target, result.patch)),
      });
      if (view.accountId !== target) throw new Error(text.failed);
      setSlots((current) => {
        const previous = current[target];
        // Edits typed while the save was in flight stay; everything else now shows the saved values.
        const draft = previous && previous.draft !== sent ? previous.draft : draftFromSettings(view.settings);
        return { ...current, [target]: { view, base: view.settings, draft } };
      });
      setServerIssues((current) => ({ ...current, [target]: [] }));
      note(target, { ok: true, text: text.saved(target, describeChanges(result.changes, locale)) });
      onView?.(view);
    } catch (error) {
      const message = errorText(error, text.failed);
      if (error instanceof ApiError && error.code === "invalid_settings") {
        setServerIssues((current) => ({ ...current, [target]: serverSettingsIssues(message) }));
        note(target, { ok: false, text: `${text.rejected}${message}` });
      } else {
        note(target, { ok: false, text: message });
      }
    } finally {
      setBusySlot((current) => (current === target ? null : current));
    }
  }

  function discard() {
    const target = accountId;
    setSlots((current) => {
      const slot = current[target];
      return slot ? { ...current, [target]: { view: slot.view, base: slot.view.settings, draft: draftFromSettings(slot.view.settings) } } : current;
    });
    setServerIssues((current) => ({ ...current, [target]: [] }));
    note(target, null);
  }

  async function reset(target: AccountId) {
    setBusySlot(target);
    note(target, null);
    try {
      const view = await api<AutomationSettingsView>(`/api/automation/settings?accountId=${target}`, { method: "DELETE" });
      if (view.accountId !== target) throw new Error(text.failed);
      setSlots((current) => ({ ...current, [target]: { view, base: view.settings, draft: draftFromSettings(view.settings) } }));
      setServerIssues((current) => ({ ...current, [target]: [] }));
      note(target, { ok: true, text: text.resetDone(target) });
      onView?.(view);
    } catch (error) {
      note(target, { ok: false, text: errorText(error, text.failed) });
    } finally {
      setResetTarget(null);
      setBusySlot((current) => (current === target ? null : current));
    }
  }

  const slot = slots[accountId];
  return (
    <Card data-testid="automation-settings">
      <CardContent className="space-y-4 p-4">
        {slot ? (
          <AutomationSettingsForm
            accountId={accountId}
            locale={locale}
            view={slot.view}
            base={slot.base}
            draft={slot.draft}
            serverIssues={serverIssues[accountId]}
            feedback={feedback[accountId]}
            busy={busySlot === accountId}
            onDraft={(update) => updateDraft(accountId, update)}
            onSave={() => void save()}
            onDiscard={discard}
            onReset={() => setResetTarget(accountId)}
            onRefresh={() => void load(accountId)}
          />
        ) : (
          <div className="space-y-2">
            <h2 className="font-heading text-lg">{text.title} · {locale === "zh" ? `账号${accountId}` : `Account ${accountId}`}</h2>
            <p className={loadError[accountId] !== null ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
              {loadError[accountId] !== null ? loadError[accountId] || text.failed : text.loading}
            </p>
            {loadError[accountId] !== null ? (
              <Button type="button" size="sm" variant="outline" onClick={() => void load(accountId)}>
                {text.retry}
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
      <Dialog open={resetTarget !== null} onOpenChange={(open) => { if (!open) setResetTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{text.resetTitle(resetTarget ?? accountId)}</DialogTitle>
            <DialogDescription>{text.resetBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setResetTarget(null)}>
              {text.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={resetTarget === null || busySlot === resetTarget}
              data-testid="automation-settings-reset-confirm"
              onClick={() => {
                if (resetTarget !== null) void reset(resetTarget);
              }}
            >
              {text.reset}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Presentational form. All state lives in the caller; `onDraft` receives functional updates. */
export function AutomationSettingsForm(props: {
  accountId: AccountId;
  locale: Locale;
  view: AutomationSettingsView;
  base: AutomationSettings;
  draft: SettingsDraft;
  serverIssues: FormIssue[];
  feedback: Feedback;
  busy: boolean;
  now?: Date;
  onDraft: (update: (draft: SettingsDraft) => SettingsDraft) => void;
  onSave: () => void;
  onDiscard: () => void;
  onReset: () => void;
  onRefresh: () => void;
}) {
  const { accountId, locale, view, draft } = props;
  const text = TEXT[locale];
  const idPrefix = `settings-${accountId}`;
  const pending = buildSettingsPatch(props.base, draft);
  const dirty = !draftMatches(draft, props.base);
  const moved = JSON.stringify(props.base) !== JSON.stringify(view.settings);
  const live = dirty ? pending.issues : [];
  const all = [...live, ...props.serverIssues];
  const issues = (field: string, nested = false) => issuesFor(all, field, locale, nested);
  const serverOnly = (field: string) => issuesFor(props.serverIssues, field, locale);
  const known = /^(scheduleTimezone|quotaTimezone|mutualExclusion|follow\.|unfollow\.|filters\.)/;
  const general = props.serverIssues.filter((issue) => !known.test(issue.field));
  const now = props.now ?? new Date();
  const preview = view.preview;
  const laneState = (slot: string | null, open: boolean) => (slot ? `${text.slotWork} ${slot}` : open ? text.slotRest : text.slotClosed);
  const accountLabel = locale === "zh" ? `账号${accountId}` : `Account ${accountId}`;

  return (
    <div className="space-y-4" data-testid={`automation-settings-${accountId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-heading text-lg">{text.title} · {accountLabel}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{text.intro}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={view.stored ? "default" : "outline"}>{view.stored ? text.stored : text.defaults}</Badge>
          {view.updatedAt ? <span>{text.updatedAt} {formatInZone(view.updatedAt, view.settings.scheduleTimezone)}</span> : null}
        </div>
      </div>

      {view.invalidStoredFields.length > 0 ? (
        <p className="rounded-lg border border-destructive px-3 py-2 text-xs leading-5 text-destructive">
          {text.invalidStored}{view.invalidStoredFields.map((field) => fieldLabel(field, locale)).join(locale === "zh" ? "、" : ", ")}
        </p>
      ) : null}
      {dirty && moved ? <p className="rounded-lg bg-secondary px-3 py-2 text-xs leading-5">{text.moved}</p> : null}

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{text.zones}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <TimezoneField
            id={`${idPrefix}-schedule-timezone`}
            testId="settings-schedule-timezone"
            label={`${text.scheduleZone} (scheduleTimezone)`}
            help={text.scheduleZoneHelp}
            value={draft.scheduleTimezone}
            locale={locale}
            now={now}
            issues={serverOnly("scheduleTimezone")}
            onChange={(value) => props.onDraft((current) => ({ ...current, scheduleTimezone: value }))}
          />
          <TimezoneField
            id={`${idPrefix}-quota-timezone`}
            testId="settings-quota-timezone"
            label={`${text.quotaZone} (quotaTimezone)`}
            help={text.quotaZoneHelp}
            value={draft.quotaTimezone}
            locale={locale}
            now={now}
            issues={serverOnly("quotaTimezone")}
            onChange={(value) => props.onDraft((current) => ({ ...current, quotaTimezone: value }))}
          />
        </div>
      </section>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.mutualExclusion}
            data-testid="settings-mutual-exclusion"
            onChange={(event) => {
              const checked = event.target.checked;
              props.onDraft((current) => ({ ...current, mutualExclusion: checked }));
            }}
          />
          {text.mutualExclusion}
        </label>
        <p className="text-xs leading-5 text-muted-foreground">{text.mutualHelp}</p>
        {issues("mutualExclusion").map((issue) => (
          <p key={issue} className="text-xs leading-5 text-destructive">{issue}</p>
        ))}
      </div>

      {(["follow", "unfollow"] as const).map((lane) => (
        <LaneSection
          key={lane}
          lane={lane}
          idPrefix={idPrefix}
          locale={locale}
          draft={draft[lane]}
          defaults={view.defaults}
          issues={issues}
          onDraft={props.onDraft}
        />
      ))}
      <p className="text-xs leading-5 text-muted-foreground">{text.windowHelp}</p>
      <p className="text-xs leading-5 text-muted-foreground">{text.limits()}</p>

      <fieldset className="space-y-2 rounded-lg border px-3 py-3">
        <legend className="px-1 font-heading text-base">{text.filters}</legend>
        {FILTER_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.filters[key]}
              data-testid={`settings-filter-${key}`}
              onChange={(event) => {
                const checked = event.target.checked;
                props.onDraft((current) => ({ ...current, filters: { ...current.filters, [key]: checked } }));
              }}
            />
            {key === "blueVerified" ? text.filterBlue : key === "language" ? text.filterLanguage(accountId) : text.filterActivity}
          </label>
        ))}
        {issues("filters", true).map((issue) => (
          <p key={issue} className="text-xs leading-5 text-destructive">{issue}</p>
        ))}
      </fieldset>

      <section className="space-y-1 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5" data-testid="settings-preview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{text.preview}</p>
          <Button type="button" size="xs" variant="ghost" onClick={props.onRefresh}>
            {text.refresh}
          </Button>
        </div>
        <p>{text.follow}：{laneState(preview.followSlot, preview.followOpen)}</p>
        <p>{text.unfollow}：{laneState(preview.unfollowSlot, preview.unfollowOpen)}</p>
        <p>
          {text.quotaDay} {preview.quotaDay}（{view.settings.quotaTimezone}） · {text.scheduleDay} {preview.scheduleDay}（{view.settings.scheduleTimezone}）
        </p>
        <p className="text-muted-foreground">
          {text.previewAt} {formatInZone(preview.at, view.settings.scheduleTimezone)}（{view.settings.scheduleTimezone}）
        </p>
      </section>

      <div className="space-y-2">
        <p className="text-xs leading-5 text-muted-foreground" data-testid="settings-pending">
          {pending.changes.length > 0 ? `${text.pending}${describeChanges(pending.changes, locale)}` : text.clean}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" data-testid="settings-save" disabled={props.busy || !dirty} onClick={props.onSave}>
            {props.busy ? text.saving : `${text.save} · ${accountLabel}`}
          </Button>
          <Button type="button" variant="outline" disabled={props.busy || !dirty} onClick={props.onDiscard}>
            {text.discard}
          </Button>
          <Button type="button" variant="ghost" data-testid="settings-reset" disabled={props.busy} onClick={props.onReset}>
            {text.reset}
          </Button>
        </div>
        {general.map((issue) => (
          <p key={`${issue.field}:${issue.zh}`} className="text-xs leading-5 text-destructive">{issue[locale]}</p>
        ))}
        {props.feedback ? (
          <p
            role="status"
            aria-live="polite"
            data-testid="settings-feedback"
            className={props.feedback.ok ? "text-sm text-emerald-800" : "text-sm text-destructive"}
          >
            {props.feedback.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NumberField(props: {
  id: string;
  label: string;
  value: string;
  limit: { min: number; max: number };
  issues: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id} className="text-xs">{props.label}</Label>
      <Input
        id={props.id}
        name={props.id}
        type="number"
        inputMode="numeric"
        min={props.limit.min}
        max={props.limit.max}
        step={1}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.issues.length > 0}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <p className="text-[0.7rem] text-muted-foreground">{props.limit.min}–{props.limit.max}</p>
      {props.issues.map((issue) => (
        <p key={issue} className="text-xs leading-5 text-destructive">{issue}</p>
      ))}
    </div>
  );
}

function ClockField(props: { id: string; label: string; value: string; issues?: string[]; onChange: (value: string) => void }) {
  const issues = props.issues ?? [];
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id} className="text-xs">{props.label}</Label>
      <Input
        id={props.id}
        name={props.id}
        className="w-24"
        inputMode="numeric"
        placeholder="HH:MM"
        autoComplete="off"
        value={props.value}
        aria-invalid={issues.length > 0}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {issues.map((issue) => (
        <p key={issue} className="text-xs leading-5 text-destructive">{issue}</p>
      ))}
    </div>
  );
}

function LaneSection(props: {
  lane: SettingsLane;
  idPrefix: string;
  locale: Locale;
  draft: LaneDraft;
  defaults: AutomationSettings;
  issues: (field: string, nested?: boolean) => string[];
  onDraft: (update: (draft: SettingsDraft) => SettingsDraft) => void;
}) {
  const { lane, draft } = props;
  const text = TEXT[props.locale];
  const id = (name: string) => `${props.idPrefix}-${lane}-${name}`;
  const set = (patch: Partial<LaneDraft>) => props.onDraft((current) => withLane(current, lane, patch));
  const setWindows = (update: (windows: LaneDraft["windows"]) => LaneDraft["windows"]) =>
    props.onDraft((current) => withLane(current, lane, { windows: update(current[lane].windows) }));
  const capLimit = lane === "follow" ? SETTINGS_LIMITS.followDailyCap : SETTINGS_LIMITS.unfollowDailyCap;
  return (
    <fieldset className="space-y-3 rounded-lg border px-3 py-3" data-testid={`settings-lane-${lane}`}>
      <legend className="px-1 font-heading text-base">{lane === "follow" ? text.follow : text.unfollow}</legend>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <NumberField
          id={id("batch")}
          label={lane === "follow" ? text.batchFollow : text.batchUnfollow}
          value={draft.batchSize}
          limit={SETTINGS_LIMITS.batchSize}
          issues={props.issues(`${lane}.batchSize`)}
          onChange={(value) => set({ batchSize: value })}
        />
        <div className="space-y-1.5">
          <NumberField
            id={id("cap")}
            label={text.dailyCap}
            value={draft.noCap ? "" : draft.dailyCap}
            limit={capLimit}
            disabled={draft.noCap}
            issues={props.issues(`${lane}.dailyCap`)}
            onChange={(value) => set({ dailyCap: value })}
          />
          {lane === "unfollow" ? (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.noCap}
                data-testid="settings-unfollow-no-cap"
                onChange={(event) => set({ noCap: event.target.checked })}
              />
              {text.noCap}
            </label>
          ) : null}
        </div>
        <NumberField
          id={id("work")}
          label={text.workMinutes}
          value={draft.workMinutes}
          limit={SETTINGS_LIMITS.workMinutes}
          issues={props.issues(`${lane}.workMinutes`)}
          onChange={(value) => set({ workMinutes: value })}
        />
        <NumberField
          id={id("rest")}
          label={text.restMinutes}
          value={draft.restMinutes}
          limit={SETTINGS_LIMITS.restMinutes}
          issues={props.issues(`${lane}.restMinutes`)}
          onChange={(value) => set({ restMinutes: value })}
        />
        <ClockField
          id={id("anchor")}
          label={text.anchor}
          value={draft.anchorMinute}
          issues={props.issues(`${lane}.anchorMinute`)}
          onChange={(value) => set({ anchorMinute: value })}
        />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">{text.windows}</p>
        {draft.windows.map((range, index) => (
          <div key={index} className="space-y-1">
            <div className="flex flex-wrap items-end gap-2">
              <ClockField
                id={id(`window-${index}-start`)}
                label={`${text.start} ${index + 1}`}
                value={range.start}
                onChange={(value) => setWindows((windows) => windows.map((item, at) => (at === index ? { ...item, start: value } : item)))}
              />
              <span className="pb-2 text-muted-foreground">–</span>
              <ClockField
                id={id(`window-${index}-end`)}
                label={`${text.end} ${index + 1}`}
                value={range.end}
                onChange={(value) => setWindows((windows) => windows.map((item, at) => (at === index ? { ...item, end: value } : item)))}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={draft.windows.length <= SETTINGS_LIMITS.windows.min}
                onClick={() => setWindows((windows) => windows.filter((_, at) => at !== index))}
              >
                {text.removeWindow}
              </Button>
            </div>
            {props.issues(`${lane}.windows[${index}]`).map((issue) => (
              <p key={issue} className="text-xs leading-5 text-destructive">{issue}</p>
            ))}
          </div>
        ))}
        {props.issues(`${lane}.windows`).map((issue) => (
          <p key={issue} className="text-xs leading-5 text-destructive">{issue}</p>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={draft.windows.length >= SETTINGS_LIMITS.windows.max}
          onClick={() => setWindows((windows) => [...windows, { start: "", end: "" }])}
        >
          {text.addWindow}
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {text.defaultsLine}：{describeLane(lane, props.defaults, props.locale)}
      </p>
    </fieldset>
  );
}
