"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileUp, ListOrdered, Settings, UserPlus } from "lucide-react";
import { useAppState } from "@/components/app-state";
import { useI18n } from "@/components/i18n-provider";
import type { MessageKey } from "@/lib/messages";
import type { PublicState, ServicePhase } from "@/lib/types";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", key: "navQueue" as const, icon: ListOrdered },
  { href: "/import", key: "navImport" as const, icon: FileUp },
  { href: "/automation", key: "navAutomation" as const, icon: UserPlus },
  { href: "/settings", key: "navSettings" as const, icon: Settings },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t, locale, setLocale } = useI18n();
  const { state, setAccountId, accountId } = useAppState();

  const connection = state?.account
    ? t("connectedAs", { handle: state.account.username })
    : t("notConnected");
  const service = state?.activity ? t("serviceLabel", { phase: t(servicePhaseKey(state.activity.phase)) }) : null;
  const posture = state ? t(postureKey(state)) : null;
  const automation = state
    ? t(state.deployment.automationSupervisor === "on" ? "postureAutomationOn" : "postureAutomationOff")
    : null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="h-1 bg-primary" />
      <div className="mx-auto flex max-w-6xl">
        <aside className="sticky top-0 hidden h-[calc(100vh-4px)] w-56 shrink-0 flex-col border-r border-border px-4 py-6 md:flex">
          <Link href="/" className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-primary font-heading text-lg text-primary-foreground">
              序
            </span>
            <span>
              <span className="block font-heading text-xl leading-none tracking-wide">{t("appName")}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{t("appTagline")}</span>
            </span>
          </Link>
          <nav className="mt-8 flex flex-col gap-1">
            <div className="mb-3 grid grid-cols-2 gap-1">
              {(state?.slots ?? [
                { id: 1 as const, label: "账号1" as const, paused: false },
                { id: 2 as const, label: "账号2" as const, paused: false },
              ]).map((slot) => (
                <button
                  key={slot.id}
                  type="button"
                  onClick={() => setAccountId(slot.id)}
                  className={cn(
                    "rounded-lg px-2 py-2 text-xs",
                    accountId === slot.id ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                  )}
                >
                  {slot.label}
                  {slot.paused ? " · 暂停" : ""}
                </button>
              ))}
            </div>
            {links.map((link) => {
              const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
                    active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted",
                  )}
                >
                  <Icon />
                  {t(link.key)}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto space-y-3">
            {service ? <p className="text-xs leading-5 text-muted-foreground">{service}</p> : null}
            {posture ? <p className="text-xs leading-5 text-muted-foreground">{posture}</p> : null}
            {automation ? <p className="text-xs leading-5 text-muted-foreground">{automation}</p> : null}
            <p className="text-xs leading-5 text-muted-foreground">{connection}</p>
            <p className="text-xs leading-5 text-muted-foreground">{t("footerNote")}</p>
            <LocaleSwitch locale={locale} setLocale={setLocale} />
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
            <Link href="/" className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-md bg-primary text-sm text-primary-foreground">序</span>
              <span className="font-heading text-lg">{t("appName")}</span>
            </Link>
            <div className="flex items-center gap-3">
              {service ? <p className="text-xs text-muted-foreground">{service}</p> : null}
              <LocaleSwitch locale={locale} setLocale={setLocale} />
            </div>
          </header>
          <main className="px-4 py-6 pb-24 md:px-8 md:py-8 md:pb-10">
            {posture ? (
              <p className="mb-4 rounded-lg bg-secondary px-3 py-2 text-sm leading-6 md:hidden">{posture}</p>
            ) : null}
            {children}
          </main>
        </div>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-border bg-card md:hidden">
        {links.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "flex flex-col items-center gap-1 py-2 text-xs",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon />
              {t(link.key)}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function postureKey(state: PublicState): MessageKey {
  if (state.deployment.apiMode === "mock") return "postureMock";
  if (state.deployment.queuePaused) return "postureLivePaused";
  return "postureLiveArmed";
}

function servicePhaseKey(phase: ServicePhase): MessageKey {
  if (phase === "empty") return "servicePhaseEmpty";
  if (phase === "idle") return "servicePhaseIdle";
  if (phase === "paused") return "servicePhasePaused";
  if (phase === "no_credentials") return "servicePhaseNoCredentials";
  if (phase === "auth_blocked") return "servicePhaseAuth";
  if (phase === "credits_waiting") return "servicePhaseCredits";
  if (phase === "rate_limited") return "servicePhaseRate";
  if (phase === "scheduled") return "servicePhaseScheduled";
  return "servicePhaseDue";
}

function LocaleSwitch({
  locale,
  setLocale,
}: {
  locale: "zh" | "en";
  setLocale: (locale: "zh" | "en") => void;
}) {
  const { t } = useI18n();
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
      <button
        type="button"
        className={cn("rounded-md px-2 py-1", locale === "zh" && "bg-primary text-primary-foreground")}
        onClick={() => setLocale("zh")}
      >
        {t("langZh")}
      </button>
      <button
        type="button"
        className={cn("rounded-md px-2 py-1", locale === "en" && "bg-primary text-primary-foreground")}
        onClick={() => setLocale("en")}
      >
        {t("langEn")}
      </button>
    </div>
  );
}
