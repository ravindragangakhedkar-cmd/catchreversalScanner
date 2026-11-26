import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  GoogleAuthProvider, createUserWithEmailAndPassword, onAuthStateChanged,
  sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword,
  signInWithPopup, signOut as firebaseSignOut, updateProfile, type User,
} from 'firebase/auth';
import { auth } from '../lib/firebase';
import { OFFICIAL_MERCHANT_EMAIL, type BrokerSessionInfo, type UserProfileDoc } from '../../shared/types';

interface AuthContextValue {
  user: User | null; profile: UserProfileDoc | null; authReady: boolean; isVerified: boolean;
  trialHoursLeft: number; isTrialExpired: boolean; hasScannerAccess: boolean;
  brokerSession: BrokerSessionInfo | null; brokerToken: string | null;
  setBrokerSessionState: (token: string | null, session: BrokerSessionInfo | null) => void;
  signInWithGoogle: () => Promise<void>; signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (displayName: string, email: string, password: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>; refreshVerificationState: () => Promise<boolean>;
  sendPasswordReset: (email: string) => Promise<void>;
  activateSubscription: (plan: 'monthly' | 'yearly', googlePlayOrderId: string) => Promise<void>;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);
const profileKey = (uid: string) => `gp_user_profile_${uid}`;
function defaultProfile(user: User): UserProfileDoc {
  const now = new Date().toISOString();
  const email = (user.email || 'trader@gazabpaisa.in').trim().slice(0, 254);
  return {
    uid: user.uid, email,
    displayName: (user.displayName?.trim() || email.split('@')[0] || 'Trader').slice(0, 120),
    subscriptionTier: 'trial', subscriptionStatus: 'active',
    trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: now, updatedAt: now,
  };
}
function toMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') { const n = new Date(value).getTime(); return Number.isFinite(n) ? n : 0; }
  return 0;
}
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfileDoc | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [brokerToken, setBrokerToken] = useState<string | null>(null);
  const [brokerSession, setBrokerSession] = useState<BrokerSessionInfo | null>(null);

  const setBrokerSessionState = useCallback((token: string | null, session: BrokerSessionInfo | null) => {
    setBrokerToken(token); setBrokerSession(session);
    if (user?.uid && typeof window !== 'undefined') {
      const key = `gp_nubra_session_${user.uid}`;
      if (token && session?.connected) window.localStorage.setItem(key, token);
      else window.localStorage.removeItem(key);
    }
  }, [user?.uid]);

  const loadProfile = useCallback((firebaseUser: User) => {
    if (!firebaseUser.emailVerified || typeof window === 'undefined') return;
    const key = profileKey(firebaseUser.uid);
    let next: UserProfileDoc;
    try {
      const saved = window.localStorage.getItem(key);
      next = saved ? JSON.parse(saved) as UserProfileDoc : defaultProfile(firebaseUser);
      if (!saved) window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      next = defaultProfile(firebaseUser);
      window.localStorage.setItem(key, JSON.stringify(next));
    }
    setProfile(next);
  }, []);

  useEffect(() => onAuthStateChanged(auth, (nextUser) => {
    setUser(nextUser); setAuthReady(true);
    if (nextUser?.emailVerified) loadProfile(nextUser);
    else setProfile(null);
    if (!nextUser) { setBrokerToken(null); setBrokerSession(null); }
  }), [loadProfile]);

  useEffect(() => {
    if (user?.uid && profile && typeof window !== 'undefined') {
      window.localStorage.setItem(profileKey(user.uid), JSON.stringify(profile));
    }
  }, [user?.uid, profile]);

  useEffect(() => {
    if (!authReady || !user?.emailVerified || typeof window === 'undefined') return;
    const key = `gp_nubra_session_${user.uid}`;
    const saved = window.localStorage.getItem(key);
    if (!saved) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/broker/session', { headers: { 'x-broker-session': saved }, cache: 'no-store' });
        const payload = await response.json() as { session?: BrokerSessionInfo | null };
        if (cancelled) return;
        if (response.ok && payload.session?.connected) setBrokerSessionState(saved, payload.session);
        else { window.localStorage.removeItem(key); setBrokerSessionState(null, null); }
      } catch { /* retain token for retry when the API is reachable */ }
    })();
    return () => { cancelled = true; };
  }, [authReady, user?.uid, user?.emailVerified, setBrokerSessionState]);

  const signInWithGoogle = useCallback(async () => {
    const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' });
    const credential = await signInWithPopup(auth, provider);
    if (credential.user.emailVerified) loadProfile(credential.user);
  }, [loadProfile]);
  const signInWithEmail = useCallback(async (email: string, password: string) => {
    const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
    if (credential.user.emailVerified) loadProfile(credential.user);
  }, [loadProfile]);
  const signUpWithEmail = useCallback(async (displayName: string, email: string, password: string) => {
    const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
    if (displayName.trim()) await updateProfile(credential.user, { displayName: displayName.trim().slice(0, 120) });
    await sendEmailVerification(credential.user);
  }, []);
  const resendVerificationEmail = useCallback(async () => {
    if (!auth.currentUser) throw new Error('No signed-in user.');
    await sendEmailVerification(auth.currentUser);
  }, []);
  const refreshVerificationState = useCallback(async () => {
    if (!auth.currentUser) return false;
    await auth.currentUser.reload(); await auth.currentUser.getIdToken(true);
    const refreshed = auth.currentUser; setUser({ ...refreshed } as User);
    if (refreshed.emailVerified) loadProfile(refreshed);
    return refreshed.emailVerified;
  }, [loadProfile]);
  const sendPasswordReset = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim());
  }, []);
  const activateSubscription = useCallback(async (plan: 'monthly' | 'yearly', googlePlayOrderId: string) => {
    if (!auth.currentUser?.emailVerified) throw new Error('Please sign in with a verified email or Gmail account first.');
    setProfile((current) => ({
      ...(current || defaultProfile(auth.currentUser!)),
      subscriptionTier: plan, subscriptionStatus: 'active',
      planPurchasedAt: new Date().toISOString(), googlePlayOrderId,
      paymentLinkedAccount: OFFICIAL_MERCHANT_EMAIL, updatedAt: new Date().toISOString(),
    }));
  }, []);
  const signOut = useCallback(async () => {
    if (brokerToken) void fetch('/api/broker/disconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-broker-session': brokerToken },
      body: JSON.stringify({ userId: user?.uid }),
    });
    if (user?.uid && typeof window !== 'undefined') window.localStorage.removeItem(`gp_nubra_session_${user.uid}`);
    setBrokerToken(null); setBrokerSession(null); setProfile(null);
    await firebaseSignOut(auth);
  }, [brokerToken, user?.uid]);

  const isVerified = Boolean(user?.emailVerified);
  const trialEnd = toMillis(profile?.trialEndsAt);
  const trialHoursLeft = trialEnd > 0 ? Math.max(0, Math.ceil((trialEnd - Date.now()) / 3600000)) : 72;
  const isTrialExpired = profile?.subscriptionTier === 'trial' && trialEnd > 0 && Date.now() > trialEnd;
  const hasScannerAccess = isVerified && (profile?.subscriptionTier === 'monthly' || profile?.subscriptionTier === 'yearly' || !isTrialExpired);

  return <AuthContext.Provider value={{
    user, profile, authReady, isVerified, trialHoursLeft, isTrialExpired, hasScannerAccess,
    brokerSession, brokerToken, setBrokerSessionState, signInWithGoogle, signInWithEmail,
    signUpWithEmail, resendVerificationEmail, refreshVerificationState, sendPasswordReset,
    activateSubscription, signOut,
  }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
