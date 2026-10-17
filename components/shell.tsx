"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileUp, ListOrdered, Settings } from "lucide-react";
import { useAppState } from "@/components/app-state";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", key: "navQueue" as const, icon: ListOrdered },
  { href: "/import", key: "navImport" as const, icon: FileUp },
  { href: "/settings", key: "navSettings" as const, icon: Settings },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t, locale, setLocale } = useI18n();
  const { state } = useAppState();

  const connection = state?.account
    ? t("connectedAs", { handle: state.account.username })
    : t("notConnected");

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
            <LocaleSwitch locale={locale} setLocale={setLocale} />
          </header>
          <main className="px-4 py-6 pb-24 md:px-8 md:py-8 md:pb-10">{children}</main>
        </div>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-border bg-card md:hidden">
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
