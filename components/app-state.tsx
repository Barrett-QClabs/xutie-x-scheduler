import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { shouldApplyAccountState } from "@/lib/account-state";
import type { AccountId } from "@/lib/account";
import type { PublicState } from "@/lib/types";

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
  const selected = useRef(accountId);
  const generation = useRef(0);
  selected.current = accountId;

  const refresh = useCallback(async () => {
    const requested = accountId;
    if (selected.current !== requested) return;
    const token = ++generation.current;
    try {
      const response = await fetch(`/api/state?accountId=${requested}`, { cache: "no-store" });
      if (!response.ok) throw new Error("load");
      const body = (await response.json()) as PublicState;
      if (token !== generation.current || selected.current !== requested) return;
      if (!shouldApplyAccountState({ requestedId: requested, selectedId: selected.current, responseId: body.accountId })) {
        return;
      }
      setState(body);
      setLoadError(false);
    } catch {
      if (token !== generation.current || selected.current !== requested) return;
      setLoadError(true);
    } finally {
      if (token === generation.current && selected.current === requested) setLoading(false);
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
