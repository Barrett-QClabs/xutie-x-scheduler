"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { en, zh, type Locale, type MessageKey } from "@/lib/messages";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const I18nContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
} | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("zh");

  useEffect(() => {
    const saved = window.localStorage.getItem("xuti-locale");
    if (saved === "en" || saved === "zh") {
      setLocaleState(saved);
      document.documentElement.lang = saved === "en" ? "en" : "zh-Hans";
    }
  }, []);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem("xuti-locale", next);
    document.documentElement.lang = next === "en" ? "en" : "zh-Hans";
  };

  const t = useMemo<Translate>(() => {
    const dictionary = locale === "en" ? en : zh;
    return (key, vars) => {
      const raw = dictionary[key] ?? zh[key];
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
    };
  }, [locale]);

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used within I18nProvider");
  return context;
}
