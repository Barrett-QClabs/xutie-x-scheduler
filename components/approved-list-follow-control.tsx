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
  onSave: (body: { accountId: 1; approvedListFollow: boolean }) => void;
}) {
  if (props.accountId !== 1 || props.locked) {
    return <p className="text-sm leading-6">{props.status || "账号2没有已筛名单开关，仍按原资格筛选。发现来的人不能把自己标成已筛名单。"}</p>;
  }
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={props.checked}
          aria-label="已筛名单直接关注"
          onChange={(event) => props.onChecked(event.target.checked)}
        />
        已筛名单直接关注
      </label>
      <p data-approved-list-status="">{props.status}</p>
      <p className="text-xs leading-5 text-muted-foreground">
        只作用于账号1执行白名单里、已经在关注储备中的人。永久取关黑名单、已经关注过的人，以及固定永不取关名单仍然跳过。不在白名单上的人和账号2仍按原筛选。保存不会开始运行，也不改 15 分钟工作、18 分钟休息、05:00–09:00 停工、每日 350 或每轮 13 人。
      </p>
      <Button
        type="button"
        disabled={props.busy}
        variant="outline"
        onClick={() => props.onSave(approvedListFollowPutBody(props.checked))}
      >
        保存已筛名单开关
      </Button>
    </div>
  );
}
