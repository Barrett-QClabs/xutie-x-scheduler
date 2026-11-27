"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AccountId } from "@/lib/account";
import { api } from "@/lib/api";
import type { FollowAllowlistView } from "@/lib/follow-allowlist";
import type { Locale } from "@/lib/messages";

export function FollowAllowlistControl({ accountId, locale }: { accountId: AccountId; locale: Locale }) {
  const [enforced, setEnforced] = useState(false);
  const [ids, setIds] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const zh = locale === "zh";
  const prefix = `follow-allowlist-${accountId}`;

  useEffect(() => {
    let cancel = false;
    setLoaded(false);
    setNote("");
    setError("");
    void api<FollowAllowlistView>(`/api/follow/allowlist?accountId=${accountId}`)
      .then((view) => {
        if (cancel || view.accountId !== accountId) return;
        setEnforced(view.enforced);
        setIds(view.targetUserIds.join("\n"));
        setLoaded(true);
      })
      .catch((reason) => { if (!cancel) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancel = true; };
  }, [accountId]);

  async function save() {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const targetUserIds = ids.split(/[\s,，]+/).filter(Boolean);
      const view = await api<FollowAllowlistView>("/api/follow/allowlist", {
        method: "PUT",
        body: JSON.stringify({ accountId, enforced, targetUserIds }),
      });
      setEnforced(view.enforced);
      setIds(view.targetUserIds.join("\n"));
      setNote(zh ? `已保存账号${view.accountId}的执行白名单，没有开始运行。` : `Saved Account ${view.accountId}'s execution allowlist. No run started.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{zh ? `账号${accountId}执行白名单` : `Account ${accountId} execution allowlist`}</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enforced} disabled={!loaded || busy} onChange={(event) => setEnforced(event.target.checked)} />
        {zh ? "仅允许关注此名单中的账号" : "Only follow users on this list"}
      </label>
      <label htmlFor={prefix}>{zh ? "目标用户 ID（每行一个，或逗号分隔）" : "Target user IDs (one per line or comma separated)"}</label>
      <textarea
        id={prefix}
        className="min-h-28 w-full rounded-md border p-2 font-mono text-sm"
        value={ids}
        disabled={!loaded || busy}
        onChange={(event) => setIds(event.target.value)}
      />
      <p className="text-xs leading-5 text-muted-foreground">
        {zh
          ? "仅适用于当前账号。启用限制且名单为空时不会关注任何人。已筛名单直接关注只对本账号名单成员生效，即使未启用名单限制。保存不会开始运行，也不改储备、准入、成功记录、永久取关黑名单或另一个账号的名单。"
          : "Applies only to this account. Enforced with an empty list follows nobody. Approved-list follow applies only to members of this account's list, even when enforcement is off. Saving does not start a run or change reserve, admission, success history, the permanent unfollow blocklist, or the other account's list."}
      </p>
      <Button type="button" variant="outline" disabled={!loaded || busy} onClick={save}>
        {zh ? "保存执行白名单" : "Save execution allowlist"}
      </Button>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {note && <p role="status">{note}</p>}
    </div>
  );
}
