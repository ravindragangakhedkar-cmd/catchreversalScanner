import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { BrokerSessionInfo } from '../../shared/types';

interface BrokerContextValue {
  brokerSession: BrokerSessionInfo | null;
  brokerToken: string | null;
  clientId: string;
  setBrokerSessionState: (token: string | null, session: BrokerSessionInfo | null) => void;
}
const BrokerContext = createContext<BrokerContextValue | null>(null);
const CLIENT_ID_KEY = 'catch_reversals_client_id';
const SESSION_KEY = 'catch_reversals_nubra_session';

function getClientId(): string {
  if (typeof window === 'undefined') return 'catch-reversals-browser';
  let id = window.localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `cr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const clientId = useMemo(() => getClientId(), []);
  const [brokerToken, setBrokerToken] = useState<string | null>(null);
  const [brokerSession, setBrokerSession] = useState<BrokerSessionInfo | null>(null);

  const setBrokerSessionState = useCallback((token: string | null, session: BrokerSessionInfo | null) => {
    setBrokerToken(token);
    setBrokerSession(session);
    if (typeof window !== 'undefined') {
      if (token && session?.connected) window.localStorage.setItem(SESSION_KEY, token);
      else window.localStorage.removeItem(SESSION_KEY);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(SESSION_KEY);
    if (!saved) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/broker/session', {
          headers: { 'x-broker-session': saved },
          cache: 'no-store',
        });
        const payload = await response.json() as { session?: BrokerSessionInfo | null };
        if (cancelled) return;
        if (response.ok && payload.session?.connected) {
          setBrokerSessionState(saved, payload.session);
        } else {
          setBrokerSessionState(null, null);
        }
      } catch {
        // Keep the encrypted token so the browser can retry when the API is reachable.
      }
    })();
    return () => { cancelled = true; };
  }, [setBrokerSessionState]);

  return (
    <BrokerContext.Provider value={{ brokerSession, brokerToken, clientId, setBrokerSessionState }}>
      {children}
    </BrokerContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(BrokerContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
