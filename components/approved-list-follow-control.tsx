"use client";

import { approvedListFollowPutBody } from "@/lib/approved-list-follow-body";
import { Button } from "@/components/ui/button";

export function ApprovedListFollowControl(props: {
  accountId: 1 | 2;
  checked: boolean;
  locked: boolean;
  status: string;
  busy: boolean;
  onChecked: (value: boolean) => void;
  onSave: (body: { accountId: 1 | 2; approvedListFollow: boolean }) => void;
}) {
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.busy || props.locked}
          aria-label="已筛名单直接关注"
          onChange={(event) => props.onChecked(event.target.checked)}
        />
        已筛名单直接关注
      </label>
      <p data-approved-list-status="">{props.status}</p>
      <p className="text-xs leading-5 text-muted-foreground">
        只作用于当前账号{props.accountId}自己的执行白名单里、已经在关注储备中的人。永久取关黑名单、已经关注过的人，以及适用的固定永不取关名单仍然跳过。不在本账号白名单上的人仍按原筛选。两个账号的开关与名单互不影响。保存不会开始运行，也不改「自动化设置」里保存的时区、时间窗、工作/休息分钟、日上限或每轮人数。
      </p>
      <Button
        type="button"
        disabled={props.busy || props.locked}
        variant="outline"
        onClick={() => props.onSave(approvedListFollowPutBody(props.accountId, props.checked))}
      >
        保存已筛名单开关
      </Button>
    </div>
  );
}
