"use client";

import { AppStateProvider } from "@/components/app-state";
import { I18nProvider } from "@/components/i18n-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <AppStateProvider>{children}</AppStateProvider>
    </I18nProvider>
  );
}
