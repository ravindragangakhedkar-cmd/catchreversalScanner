import React, { useState } from 'react';
import { CheckCircle2, Link2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { AppPage } from '../components/TopNav';
import { useAuth } from '../context/AuthContext';

type AuthResult = {
  authenticated?: boolean;
  method?: string;
  service?: string;
};

export function BrokerConnectPage({ onNavigate }: { onNavigate?: (page: AppPage) => void }) {
  const { nubraConnected: connected, setNubraConnected } = useAuth();
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleConnect = async () => {
    setLoading(true);
    setNubraConnected(false);
    setStatusMessage(null);
    setErrorMsg(null);
    try {
      // The Python service performs Nubra login server-side using the
      // NUBRA_PHONE_NO, NUBRA_MPIN and NUBRA_TOTP_SECRET Render variables.
      // No browser SMS OTP challenge is required for this TOTP flow.
      const response = await fetch('/api/nubra/auth-status', {
        method: 'GET',
        cache: 'no-store',
      });
      const payload = await response.json() as AuthResult & { error?: string; detail?: string };
      if (!response.ok || payload.authenticated !== true) {
        throw new Error(payload.error || payload.detail || 'Nubra TOTP authentication could not be verified.');
      }
      setNubraConnected(true);
      setStatusMessage('Nubra authenticated successfully through the Render Python service using your saved TOTP secret.');
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Unable to verify Nubra authentication.');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = () => {
    setNubraConnected(false);
    setStatusMessage('Nubra connection paused. Scanners will remain stopped until you connect again.');
    setErrorMsg(null);
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <div className="mb-7 border-b border-slate-200 pb-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Nubra Finance · Secure connection</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-950">Broker Connect</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Connect through the secure Python service. Nubra authentication uses the phone number, MPIN and TOTP secret stored privately in Render.
          You do not need to request or enter an SMS OTP on this page.
        </p>
      </div>

      {errorMsg && <div role="alert" className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{errorMsg}</div>}
      {statusMessage && <div role="status" className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{statusMessage}</div>}

      <section className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="mb-6 flex items-center justify-between border-b border-slate-100 pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-950 text-white"><Link2 className="h-5 w-5"/></div>
            <div><h2 className="font-bold text-slate-950">Nubra Finance</h2><p className="text-xs text-slate-500">NSE Equity &amp; F&amp;O market data</p></div>
          </div>
          <span className={`text-xs font-semibold ${connected ? 'text-emerald-700' : 'text-slate-500'}`}>{connected ? 'Connected' : 'Not verified'}</span>
        </div>

        <div className="space-y-5">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2 font-semibold text-slate-900"><ShieldCheck className="h-5 w-5"/> Server-side TOTP authentication</div>
            <p className="mt-2 text-sm text-slate-600">
              Your Nubra credentials stay in Render. The browser does not receive your MPIN or TOTP secret, and this connection check does not request an SMS OTP.
            </p>
          </div>

          {connected && (
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 className="h-5 w-5"/> Nubra Python service authenticated successfully.
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={loading} onClick={() => void handleConnect()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}/>
              {loading ? 'Verifying Nubra…' : connected ? 'Verify connection again' : 'Connect Nubra using TOTP'}
            </button>
            {connected && <button type="button" onClick={() => onNavigate?.('catch-reversals')} className="rounded-lg border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700">Open Catch Reversals Scanner</button>}
            {connected && <button type="button" onClick={handleDisconnect} className="rounded-lg border border-rose-200 px-5 py-3 text-sm font-semibold text-rose-700">Disconnect scanners</button>}
          </div>
        </div>
      </section>

      <p className="mt-5 text-xs leading-relaxed text-slate-500">
        This verifies the Python service's Nubra SDK authentication. Catch Reversals and Bias Multi-Timeframe use this backend. Other scanner pages may still require migration from the legacy browser-session flow.
      </p>
    </div>
  );
}
