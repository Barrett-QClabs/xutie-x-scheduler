"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { browserTimeZone, timeZoneOptions, zoneSnapshot } from "@/lib/automation-settings-form";
import type { Locale } from "@/lib/messages";
import { canonicalTimeZone } from "@/lib/zoned-clock";

const TEXT = {
  zh: {
    invalid: "不是有效的 IANA 时区名。请填 Asia/Taipei、Europe/London、America/New_York 这类名称；不接受 +08:00 这类偏移。",
    now: "现在",
    savedAs: "将保存为",
    browser: "用浏览器时区",
  },
  en: {
    invalid: "Not a valid IANA time zone name. Use a name such as Asia/Taipei, Europe/London, or America/New_York. Offsets such as +08:00 are not accepted.",
    now: "Now",
    savedAs: "saved as",
    browser: "Use browser zone",
  },
} as const;

/**
 * IANA time zone selector: a text field backed by the runtime's full zone list. Any valid IANA name
 * can be picked or typed. The UTC offset is shown for reference only; offsets are never accepted.
 */
export function TimezoneField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  locale: Locale;
  help?: string;
  issues?: string[];
  now?: Date;
  disabled?: boolean;
  testId?: string;
}) {
  const text = TEXT[props.locale];
  const options = useMemo(() => timeZoneOptions(), []);
  const canonical = canonicalTimeZone(props.value);
  const snapshot = canonical ? zoneSnapshot(canonical, props.now ?? new Date()) : null;
  const issues = props.issues ?? [];
  const listId = `${props.id}-options`;
  const statusId = `${props.id}-status`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <div className="flex gap-2">
        <Input
          id={props.id}
          name={props.id}
          list={listId}
          value={props.value}
          disabled={props.disabled}
          placeholder="Asia/Taipei"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={!canonical || issues.length > 0}
          aria-describedby={statusId}
          data-testid={props.testId}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.disabled}
          onClick={() => {
            const zone = browserTimeZone();
            if (zone) props.onChange(zone);
          }}
        >
          {text.browser}
        </Button>
      </div>
      <datalist id={listId}>
        {options.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <p id={statusId} className={canonical ? "text-xs leading-5 text-muted-foreground" : "text-xs leading-5 text-destructive"}>
        {canonical && snapshot
          ? `${text.now} ${snapshot.day} ${snapshot.time}${snapshot.offset ? ` · ${snapshot.offset}` : ""}${canonical !== props.value.trim() ? ` · ${text.savedAs} ${canonical}` : ""}`
          : text.invalid}
      </p>
      {props.help ? <p className="text-xs leading-5 text-muted-foreground">{props.help}</p> : null}
      {issues.map((issue) => (
        <p key={issue} className="text-xs leading-5 text-destructive">
          {issue}
        </p>
      ))}
    </div>
  );
}
