"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AccountOps } from "@/lib/account-ops";
import { api } from "@/lib/api";
import type { AutomationSettingsView } from "@/lib/automation-settings";
import { dailyPoolOpsBody } from "@/lib/automation-settings-form";
import type { Locale } from "@/lib/messages";

const ZH = {
  label: "每天一次候选池（日池）",
  help: "日池只决定两件事：账号1遇到 429 或 403 时是否暂停取关，以及新人入池时是否替换已过期的人。每轮人数、日上限、时区、时间窗和工作/休息分钟都在上面的「自动化设置」里改。",
  how: "保存这个开关时，页面先读当前已保存的设置，把每轮人数和取关日上限原样带回旧接口；不提交工作/休息分钟、锚点或时间窗，所以已保存的节奏不会被改。",
  legacy: (batch: number, work: number, rest: number) => `旧晚间新关注数字已停用，只为回滚保留并原样带回：每轮 ${batch}，工作 ${work} / 休息 ${rest} 分钟。`,
  save: "保存日池开关",
  saving: "保存中…",
  saved: (on: boolean) => `已保存账号1的日池开关：${on ? "开" : "关"}。节奏、时间窗和上限没有改。这只是配置，没有开始运行。`,
  noCap: "取关现在不设日上限，旧日池接口存不了这个值，所以这次没有保存开关。先在「自动化设置」里给取关设一个日上限，再改日池开关。",
  failed: "请求没有完成。",
};

type ControlText = typeof ZH;

const EN: ControlText = {
  label: "Once-a-day candidate pool (daily pool)",
  help: "The daily pool decides two things only: whether account 1 pauses its unfollow lane on a 429 or 403, and whether new-follow admission replaces expired entries. Batch sizes, daily caps, time zones, windows, and work/rest minutes are edited in Automation settings above.",
  how: "Saving this switch first reads the saved settings and echoes the batch sizes and unfollow cap back to the legacy endpoint unchanged. No work/rest minutes, anchor, or window is sent, so the saved cadence is not touched.",
  legacy: (batch: number, work: number, rest: number) => `The legacy evening new-follow numbers are retired and are echoed back unchanged for rollback only: ${batch} per round, work ${work} / rest ${rest} min.`,
  save: "Save daily-pool switch",
  saving: "Saving…",
  saved: (on: boolean) => `Saved account 1 daily-pool switch: ${on ? "on" : "off"}. Cadence, windows, and caps were not changed. This is configuration only and does not start a run.`,
  noCap: "The unfollow lane has no daily cap now, and the legacy daily-pool endpoint cannot store that, so the switch was not saved. Set an unfollow daily cap in Automation settings first, then change the daily pool.",
  failed: "The request did not finish.",
};

const TEXT: Record<Locale, ControlText> = { zh: ZH, en: EN };

/** Account 1 only. Saves just the daily-pool switch through `PUT /api/follow/config`. */
export function DailyPoolControl<T extends { accountId: number; ops?: unknown }>(props: {
  locale: Locale;
  ops: AccountOps;
  onSaved: (config: T) => void;
}) {
  const { locale, ops, onSaved } = props;
  const text = TEXT[locale];
  const [checked, setChecked] = useState(ops.dailyPool);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setChecked(ops.dailyPool);
  }, [ops.dailyPool]);

  async function save() {
    setBusy(true);
    setFeedback(null);
    try {
      const fresh = await api<AutomationSettingsView>("/api/automation/settings?accountId=1");
      if (fresh.accountId !== 1) throw new Error(text.failed);
      const body = dailyPoolOpsBody(checked, fresh.settings, ops.newFollow);
      if (!body) {
        setFeedback({ ok: false, text: text.noCap });
        return;
      }
      const saved = await api<T>("/api/follow/config", { method: "PUT", body: JSON.stringify(body) });
      onSaved(saved);
      setFeedback({ ok: true, text: text.saved(checked) });
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof Error && error.message ? error.message : text.failed });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm" data-testid="daily-pool-control">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={checked} aria-label={text.label} onChange={(event) => setChecked(event.target.checked)} />
        {text.label}
      </label>
      <p className="text-xs leading-5 text-muted-foreground">{text.help}</p>
      <p className="text-xs leading-5 text-muted-foreground">{text.how}</p>
      <p className="text-xs leading-5 text-muted-foreground">{text.legacy(ops.newFollow.batchSize, ops.newFollow.workMinutes, ops.newFollow.restMinutes)}</p>
      <Button type="button" variant="outline" disabled={busy} data-testid="daily-pool-save" onClick={() => void save()}>
        {busy ? text.saving : text.save}
      </Button>
      {feedback ? (
        <p role="status" aria-live="polite" className={feedback.ok ? "text-sm text-emerald-800" : "text-sm text-destructive"}>
          {feedback.text}
        </p>
      ) : null}
    </div>
  );
}
