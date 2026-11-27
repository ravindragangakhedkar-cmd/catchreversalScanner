import React, { useState } from 'react';
import { CheckCircle2, Link2, Smartphone, Unplug } from 'lucide-react';
import type { AppPage } from '../components/TopNav';
import { useAuth } from '../context/AuthContext';

export function BrokerConnectPage({ onNavigate }: { onNavigate?: (page: AppPage) => void }) {
  const { nubraConnected, setNubraConnected } = useAuth();
  const [mobile, setMobile] = useState('');
  const [mpin, setMpin] = useState('');
  const [otp, setOtp] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleStart = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    setStatusMessage(null);
    try {
      const response = await fetch('/api/nubra/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: mobile.trim(), mpin: mpin.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || payload.error || 'Unable to request Nubra SMS OTP.');
      if (payload.authenticated) {
        setNubraConnected(true);
        setStatusMessage('Nubra is already connected using SMS OTP authentication.');
      } else {
        setChallengeId(payload.challenge_id);
        setStatusMessage(payload.message || 'SMS OTP requested. Enter the code received on your registered mobile.');
      }
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Unable to start Nubra SMS OTP login.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!challengeId) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const response = await fetch('/api/nubra/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge_id: challengeId, otp: otp.trim() }),
      });
      const payload = await response.json();
      if (!response.ok || payload.authenticated !== true) {
        throw new Error(payload.detail || payload.error || 'Nubra SMS OTP verification failed.');
      }
      setNubraConnected(true);
      setChallengeId(null);
      setOtp('');
      setMpin('');
      const totpReset = payload.totp_disabled === true
        ? 'TOTP has also been disabled on the Nubra account.'
        : payload.totp_disable_error
          ? `SMS OTP login succeeded, but Nubra did not confirm TOTP deactivation: ${payload.totp_disable_error}`
          : 'SMS OTP login succeeded; TOTP deactivation was not confirmed.';
      setStatusMessage(`Nubra connected successfully using SMS OTP and MPIN. ${totpReset}`);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Nubra SMS OTP verification failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = () => {
    setNubraConnected(false);
    setChallengeId(null);
    setOtp('');
    setMpin('');
    setStatusMessage('Nubra connection cleared. Connect again with SMS OTP when required.');
    setErrorMsg(null);
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <div className="mb-7 border-b border-slate-200 pb-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Nubra Finance · SMS OTP connection</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-950">Broker Connect</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Connect using your registered mobile number, the SMS OTP sent by Nubra, and your 4-digit MPIN.
          No Google Authenticator or TOTP code is used.
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
          <span className={`text-xs font-semibold ${nubraConnected ? 'text-emerald-700' : 'text-slate-500'}`}>{nubraConnected ? 'Connected' : 'Not connected'}</span>
        </div>

        {nubraConnected ? (
          <div className="space-y-5">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex items-center gap-2 font-semibold text-emerald-900"><CheckCircle2 className="h-5 w-5"/> SMS OTP session verified</div>
              <p className="mt-2 text-sm text-slate-700">Nubra SDK is authenticated for scanner market-data requests.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => onNavigate?.('catch-reversals')} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white">Return to Scanner</button>
              <button type="button" onClick={handleDisconnect} className="inline-flex items-center gap-2 rounded-lg border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-700"><Unplug className="h-4 w-4"/> Disconnect</button>
            </div>
          </div>
        ) : challengeId ? (
          <form onSubmit={(event) => void handleVerify(event)} className="space-y-4">
            <label className="block text-sm font-medium text-slate-700">
              6-digit SMS OTP received on your registered mobile
              <input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 font-mono text-lg tracking-[.3em]" placeholder="Enter SMS OTP"/>
            </label>
            <div className="flex flex-wrap gap-3">
              <button disabled={loading || otp.length !== 6} className="rounded-lg bg-emerald-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{loading ? 'Verifying…' : 'Verify SMS OTP and Connect'}</button>
              <button type="button" onClick={() => {setChallengeId(null);setOtp('');}} className="rounded-lg border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700">Start again</button>
            </div>
          </form>
        ) : (
          <form onSubmit={(event) => void handleStart(event)} className="space-y-4">
            <label className="block text-sm font-medium text-slate-700">
              <span className="flex items-center gap-2"><Smartphone className="h-4 w-4"/> Registered mobile number</span>
              <input required inputMode="numeric" autoComplete="tel" maxLength={10} pattern="[6-9][0-9]{9}" value={mobile} onChange={event => setMobile(event.target.value.replace(/\D/g, '').slice(0, 10))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3" placeholder="10-digit mobile number"/>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              4-digit MPIN
              <input required inputMode="numeric" autoComplete="off" type="password" maxLength={4} pattern="[0-9]{4}" value={mpin} onChange={event => setMpin(event.target.value.replace(/\D/g, '').slice(0, 4))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3" placeholder="Enter MPIN"/>
            </label>
            <button disabled={loading || mobile.length !== 10 || mpin.length !== 4} className="rounded-lg bg-emerald-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{loading ? 'Requesting SMS OTP…' : 'Send SMS OTP to my mobile'}</button>
          </form>
        )}
      </section>
    </div>
  );
}
