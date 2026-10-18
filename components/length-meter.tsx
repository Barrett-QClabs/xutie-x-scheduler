"use client";

import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";
import { inspectTweet } from "@/lib/weighted-length";

export function LengthMeter({ text, className }: { text: string; className?: string }) {
  const { t } = useI18n();
  const result = inspectTweet(text);
  const over = result.reason === "too_long";
  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        over ? "text-destructive" : result.isLong ? "text-amber-700" : "text-muted-foreground",
        className,
      )}
    >
      {t("chars", { count: result.weightedLength })}
    </span>
  );
}
