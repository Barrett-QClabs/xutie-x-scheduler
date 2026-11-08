"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { PublicState } from "@/lib/types";

type AccountId = 1 | 2;

type AppStateValue = {
  state: PublicState | null;
  loading: boolean;
  loadError: boolean;
  accountId: AccountId;
  setAccountId: (accountId: AccountId) => void;
  refresh: () => Promise<void>;
};

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [accountId, setAccountId] = useState<AccountId>(1);
  const [state, setState] = useState<PublicState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/state?accountId=${accountId}`, { cache: "no-store" });
      if (!response.ok) throw new Error("load");
      setState((await response.json()) as PublicState);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <AppStateContext.Provider value={{ state, loading, loadError, accountId, setAccountId, refresh }}>{children}</AppStateContext.Provider>
  );
}

export function useAppState() {
  const context = useContext(AppStateContext);
  if (!context) throw new Error("useAppState must be used within AppStateProvider");
  return context;
}
