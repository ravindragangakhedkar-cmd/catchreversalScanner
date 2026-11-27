import React, { useState } from 'react';
import { CheckCircle2, Link2, Smartphone, Unplug } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { AppPage } from '../components/TopNav';

export function BrokerConnectPage({ onNavigate }: { onNavigate?: (page: AppPage) => void }) {
  const { clientId, brokerSession, setBrokerSessionState, brokerToken } = useAuth();
  const [mobile, setMobile] = useState('');
  const [mpin, setMpin] = useState('');
  const [otp, setOtp] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setErrorMsg(null); setStatusMessage(null); setLoading(true);
    try {
      const cleanedMobile = mobile.replace(/\D/g, '').slice(-10);
      const res = await fetch('/api/broker/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: clientId, mobile: cleanedMobile, mpin: mpin.trim(), provider: 'nubra' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Broker login initiation failed.');
      setChallengeId(json.challengeId);
      setStatusMessage(json.message || 'OTP sent. Enter the OTP received on your registered mobile.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to initiate Nubra connection.');
    } finally { setLoading(false); }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault(); if (!challengeId) return;
    setErrorMsg(null); setLoading(true);
    try {
      const res = await fetch('/api/broker/verify-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: clientId, challengeId, otp: otp.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'OTP verification failed.');
      setBrokerSessionState(json.sessionToken, json.session);
      setChallengeId(null); setOtp(''); setMpin('');
      setStatusMessage('Nubra Finance account authenticated and connected.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'OTP verification failed.');
    } finally { setLoading(false); }
  };

  const handleDisconnect = async () => {
    setLoading(true); setErrorMsg(null);
    try {
      await fetch('/api/broker/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(brokerToken ? { 'x-broker-session': brokerToken } : {}) },
        body: JSON.stringify({ userId: clientId }),
      });
      setBrokerSessionState(null, null);
      setStatusMessage('Nubra broker session disconnected from this browser.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to disconnect broker.');
    } finally { setLoading(false); }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <div className="mb-7 border-b border-slate-200 pb-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Nubra Finance · Secure broker connection</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-950">Broker Connect</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">Connect using your registered mobile number and 4-digit MPIN. Nubra will send an OTP to your mobile; enter it here to finish authentication. No Firebase or website account sign-in is required.</p>
      </div>

      {errorMsg && <div role="alert" className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{errorMsg}</div>}
      {statusMessage && <div role="status" className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{statusMessage}</div>}

      <section className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="mb-6 flex items-center justify-between border-b border-slate-100 pb-5">
          <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-950 text-white"><Link2 className="h-5 w-5"/></div><div><h2 className="font-bold text-slate-950">Nubra Finance</h2><p className="text-xs text-slate-500">NSE Equity & F&O market data</p></div></div>
          <span className={`text-xs font-semibold ${brokerSession?.connected ? 'text-emerald-700' : 'text-slate-500'}`}>{brokerSession?.connected ? 'Connected' : 'Not connected'}</span>
        </div>

        {brokerSession?.connected ? (
          <div className="space-y-5">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex items-center gap-2 font-semibold text-emerald-900"><CheckCircle2 className="h-5 w-5"/> Broker session verified</div>
              <p className="mt-2 text-sm text-slate-700">Mobile: {brokerSession.maskedMobile}</p>
              <p className="text-sm text-slate-700">Connected: {new Date(brokerSession.connectedAtIso).toLocaleString('en-IN')}</p>
            </div>
            <button type="button" disabled={loading} onClick={() => void handleDisconnect()} className="inline-flex items-center gap-2 rounded-lg border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-700 disabled:opacity-50"><Unplug className="h-4 w-4"/> Disconnect Nubra</button>
            <button type="button" onClick={() => onNavigate?.('catch-reversals')} className="ml-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white">Return to Scanner</button>
          </div>
        ) : challengeId ? (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <label className="block text-sm font-medium text-slate-700">6-digit OTP received on your registered mobile<input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 font-mono text-lg tracking-[.3em]" placeholder="Enter OTP"/></label>
            <div className="flex flex-wrap gap-3"><button disabled={loading || otp.length !== 6} className="rounded-lg bg-emerald-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{loading ? 'Verifying…' : 'Verify OTP and Connect'}</button><button type="button" onClick={() => {setChallengeId(null);setOtp('');}} className="rounded-lg border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700">Start again</button></div>
          </form>
        ) : (
          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <label className="block text-sm font-medium text-slate-700"><span className="flex items-center gap-2"><Smartphone className="h-4 w-4"/> Registered mobile number</span><input required inputMode="numeric" autoComplete="tel" maxLength={10} value={mobile} onChange={e => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3" placeholder="10-digit mobile number"/></label>
            <label className="block text-sm font-medium text-slate-700">4-digit MPIN<input required inputMode="numeric" autoComplete="off" type="password" maxLength={4} value={mpin} onChange={e => setMpin(e.target.value.replace(/\D/g, '').slice(0, 4))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3" placeholder="Enter MPIN"/></label>
            <button disabled={loading || mobile.length !== 10 || mpin.length !== 4} className="rounded-lg bg-emerald-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{loading ? 'Requesting OTP…' : 'Send OTP to my mobile'}</button>
          </form>
        )}
      </section>
      <p className="mt-5 text-xs leading-relaxed text-slate-500">Your MPIN is sent only to the server over HTTPS for Nubra authentication and is not saved in browser storage. The authenticated broker session is stored as an encrypted, self-contained token using the server-only BROKER_SESSION_SECRET. Stateless tokens expire after seven days and cannot be individually revoked server-side; disconnect clears this browser's copy.</p>
    </div>
  );
}
