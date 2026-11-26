import crypto from 'node:crypto';
import type { BrokerSessionInfo } from '../shared/types.ts';

interface PendingChallenge {
  challengeId: string;
  userId: string;
  mobile: string;
  mpin: string;
  maskedMobile: string;
  mode: 'live-api' | 'sandbox-verified';
  provider: 'nubra' | 'broker';
  nubraTempToken?: string;
  nubraDeviceId?: string;
  expiresAt: number;
}

interface ActiveBrokerSession extends BrokerSessionInfo {
  token: string;
  userId: string;
  nubraAuthToken?: string;
  nubraDeviceId?: string;
}

const pendingChallenges = new Map<string, PendingChallenge>();
const activeSessionsByToken = new Map<string, ActiveBrokerSession>();
const activeTokenByUserId = new Map<string, string>();
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const CHALLENGE_TTL_SECONDS = 5 * 60;

function getSafeNubraBaseUrl(): string {
  const configured = process.env.NUBRA_API_BASE_URL?.trim() || 'https://api.nubra.io';
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') return 'https://api.nubra.io';
    return new Set(['api.nubra.io', 'uatapi.nubra.io']).has(parsed.hostname) ? parsed.origin : 'https://api.nubra.io';
  } catch { return 'https://api.nubra.io'; }
}

function getSessionStoreConfig(): { url: string; apiKey: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.NUBRA_SESSION_STORE_URL || '').trim().replace(/\/$/, '');
  const apiKey = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.NUBRA_SESSION_STORE_API_KEY || '').trim();
  return url && apiKey ? { url, apiKey } : null;
}

function assertProductionSessionStore(): void {
  if (process.env.VERCEL === '1' && !getSessionStoreConfig()) {
    throw new Error('Persistent broker sessions are not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (API key) to Vercel Environment Variables, then redeploy.');
  }
}

function encryptionKey(apiKey: string): Buffer {
  return crypto.scryptSync(apiKey, 'gazabpaisa-nubra-session-v1', 32);
}

function seal(value: unknown, apiKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(apiKey), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function unseal<T>(value: string, apiKey: string): T {
  const [ivText, tagText, dataText] = value.split('.');
  if (!ivText || !tagText || !dataText) throw new Error('Stored broker session is invalid. Please reconnect Nubra.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(apiKey), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted) as T;
}

async function redisCommand<T>(command: unknown[]): Promise<T | null> {
  const config = getSessionStoreConfig();
  if (!config) return null;
  const response = await fetch(`${config.url}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    cache: 'no-store',
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`Persistent session store request failed (HTTP ${response.status}).`);
  const payload = await response.json() as { result?: T; error?: string };
  if (payload.error) throw new Error(`Persistent session store error: ${payload.error}`);
  return payload.result ?? null;
}

async function storeEncrypted(key: string, value: unknown, ttl: number): Promise<void> {
  const config = getSessionStoreConfig();
  if (!config) return;
  await redisCommand(['SET', key, seal(value, config.apiKey), 'EX', ttl]);
}

async function readEncrypted<T>(key: string): Promise<T | null> {
  const config = getSessionStoreConfig();
  if (!config) return null;
  const value = await redisCommand<string>(['GET', key]);
  return value ? unseal<T>(value, config.apiKey) : null;
}

async function deleteStored(key: string): Promise<void> {
  if (getSessionStoreConfig()) await redisCommand(['DEL', key]);
}

function tokenKey(token: string): string { return `gp:nubra:session:${crypto.createHash('sha256').update(token).digest('hex')}`; }
function userKey(userId: string): string { return `gp:nubra:user:${crypto.createHash('sha256').update(userId).digest('hex')}`; }
function challengeKey(challengeId: string): string { return `gp:nubra:challenge:${challengeId}`; }
function maskIndianMobile(mobile: string): string { return `+91 ••••••${mobile.slice(-4)}`; }

export async function initiateBrokerLogin(userId: string, mobile: string, mpin: string, provider: 'nubra' | 'broker' = 'nubra'): Promise<{
  challengeId: string; maskedMobile: string; mode: 'live-api' | 'sandbox-verified'; provider: 'nubra' | 'broker'; otpHint?: string; message: string;
}> {
  assertProductionSessionStore();
  if (provider !== 'nubra') throw new Error('Only Nubra Finance authentication is supported.');
  if (!/^[6-9]\d{9}$/.test(mobile)) throw new Error('Enter a valid 10-digit Indian registered mobile number.');
  if (!/^\d{4}$/.test(mpin)) throw new Error('MPIN must be exactly 4 digits.');

  const challengeId = crypto.randomUUID();
  const maskedMobile = maskIndianMobile(mobile);
  const nubraBase = getSafeNubraBaseUrl();
  const deviceId = process.env.NUBRA_DEVICE_ID?.trim() || `GP-${crypto.randomBytes(6).toString('hex')}`;
  const step1 = await fetch(`${nubraBase}/sendphoneotp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-id': deviceId },
    body: JSON.stringify({ phone: mobile, skip_totp: false }), signal: AbortSignal.timeout(10000),
  });
  if (!step1.ok) throw new Error(`Nubra OTP request failed (HTTP ${step1.status}). Check the registered mobile number and try again.`);
  const j1 = await step1.json() as { temp_token?: string; token?: string };
  const tempToken = j1.temp_token || j1.token;
  if (!tempToken) throw new Error('Nubra did not return an OTP challenge token. Please try again.');
  const challenge: PendingChallenge = {
    challengeId, userId, mobile, mpin, maskedMobile, mode: 'live-api', provider: 'nubra',
    nubraTempToken: tempToken, nubraDeviceId: deviceId, expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
  };
  pendingChallenges.set(challengeId, challenge);
  await storeEncrypted(challengeKey(challengeId), challenge, CHALLENGE_TTL_SECONDS);
  return { challengeId, maskedMobile, mode: 'live-api', provider: 'nubra', message: `Nubra sent an OTP to ${maskedMobile}. Enter it below to complete authentication.` };
}

export async function verifyBrokerOtp(userId: string, challengeId: string, otp: string): Promise<{ sessionToken: string; session: BrokerSessionInfo }> {
  if (!/^\d{6}$/.test(otp)) throw new Error('OTP must be a 6-digit numeric code.');
  const challenge = pendingChallenges.get(challengeId) ?? await readEncrypted<PendingChallenge>(challengeKey(challengeId));
  if (!challenge || challenge.userId !== userId) throw new Error('OTP session expired or not found. Please initiate Broker login again.');
  if (Date.now() > challenge.expiresAt) {
    pendingChallenges.delete(challengeId); await deleteStored(challengeKey(challengeId));
    throw new Error('OTP expired. Please request a new OTP.');
  }

  let nubraAuthToken: string | undefined;
  const deviceId = challenge.nubraDeviceId || 'GP-WEB';
  if (challenge.mode === 'live-api' && challenge.provider === 'nubra' && challenge.nubraTempToken) {
    const nubraBase = getSafeNubraBaseUrl();
    const verifyOtpRes = await fetch(`${nubraBase}/verifyphoneotp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-temp-token': challenge.nubraTempToken, 'x-device-id': deviceId },
      body: JSON.stringify({ phone: challenge.mobile, otp }), signal: AbortSignal.timeout(7000),
    });
    if (!verifyOtpRes.ok) throw new Error('Nubra rejected the OTP. Please verify and try again.');
    const otpJson = await verifyOtpRes.json() as { temp_token?: string; auth_token?: string; session_token?: string; token?: string };
    const nextToken = otpJson.temp_token || otpJson.auth_token || challenge.nubraTempToken;
    let finalToken = otpJson.session_token || otpJson.auth_token;
    if (!finalToken && nextToken) {
      const verifyPinRes = await fetch(`${nubraBase}/verifypin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-temp-token': nextToken, 'x-device-id': deviceId },
        body: JSON.stringify({ pin: challenge.mpin }), signal: AbortSignal.timeout(7000),
      });
      if (!verifyPinRes.ok) throw new Error('Nubra rejected the 4-digit MPIN. Please check and reconnect.');
      const pinJson = await verifyPinRes.json() as { session_token?: string; auth_token?: string; token?: string };
      finalToken = pinJson.session_token || pinJson.auth_token || pinJson.token;
    }
    if (!finalToken) throw new Error('Unable to obtain Nubra session token after verification.');
    nubraAuthToken = finalToken;
  } else throw new Error('Nubra live OTP challenge is unavailable. Please start Broker Connect again.');

  pendingChallenges.delete(challengeId);
  await deleteStored(challengeKey(challengeId));
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const session: ActiveBrokerSession = {
    token: sessionToken, userId, connected: true, maskedMobile: challenge.maskedMobile,
    clientCode: 'Nubra Finance', mode: challenge.mode, provider: challenge.provider,
    nubraLiveAuth: Boolean(nubraAuthToken), connectedAtIso: new Date().toISOString(),
    nubraAuthToken, nubraDeviceId: deviceId,
  };
  activeSessionsByToken.set(sessionToken, session);
  activeTokenByUserId.set(userId, sessionToken);
  await storeEncrypted(tokenKey(sessionToken), session, SESSION_TTL_SECONDS);
  const config = getSessionStoreConfig();
  if (config) await redisCommand(['SET', userKey(userId), sessionToken, 'EX', SESSION_TTL_SECONDS]);
  return {
    sessionToken,
    session: { connected: true, maskedMobile: session.maskedMobile, clientCode: session.clientCode, mode: session.mode, provider: session.provider, nubraLiveAuth: session.nubraLiveAuth, connectedAtIso: session.connectedAtIso },
  };
}

export async function getBrokerSessionByToken(token: string | undefined): Promise<BrokerSessionInfo | null> {
  if (!token) return null;
  const session = getSessionStoreConfig()
    ? await readEncrypted<ActiveBrokerSession>(tokenKey(token))
    : activeSessionsByToken.get(token) ?? null;
  if (!session || !session.connected) { activeSessionsByToken.delete(token); return null; }
  activeSessionsByToken.set(token, session);
  activeTokenByUserId.set(session.userId, token);
  return { connected: session.connected, maskedMobile: session.maskedMobile, clientCode: session.clientCode, mode: session.mode, provider: session.provider, nubraLiveAuth: session.nubraLiveAuth, connectedAtIso: session.connectedAtIso };
}

export async function getNubraCredentialsForSession(token: string | undefined): Promise<{ authToken?: string; deviceId?: string }> {
  const envToken = process.env.NUBRA_AUTH_TOKEN?.trim() || undefined;
  const envDevice = process.env.NUBRA_DEVICE_ID?.trim() || 'GP-WEB';
  if (!token) return { authToken: envToken, deviceId: envDevice };
  const session = getSessionStoreConfig()
    ? await readEncrypted<ActiveBrokerSession>(tokenKey(token))
    : activeSessionsByToken.get(token) ?? null;
  if (session) activeSessionsByToken.set(token, session);
  else activeSessionsByToken.delete(token);
  return { authToken: session?.nubraAuthToken || envToken, deviceId: session?.nubraDeviceId || envDevice };
}

export async function disconnectBrokerSession(token: string | undefined, userId?: string): Promise<void> {
  let session = token
    ? (getSessionStoreConfig() ? await readEncrypted<ActiveBrokerSession>(tokenKey(token)) : activeSessionsByToken.get(token) ?? null)
    : null;
  if (!session && userId) {
    const mappedToken = (getSessionStoreConfig() ? await redisCommand<string>(['GET', userKey(userId)]) : activeTokenByUserId.get(userId)) ?? undefined;
    if (mappedToken) session = getSessionStoreConfig() ? await readEncrypted<ActiveBrokerSession>(tokenKey(mappedToken)) : activeSessionsByToken.get(mappedToken) ?? null;
    if (mappedToken) { await deleteStored(tokenKey(mappedToken)); activeSessionsByToken.delete(mappedToken); }
  }
  if (session) {
    await deleteStored(tokenKey(session.token));
    await deleteStored(userKey(session.userId));
    activeSessionsByToken.delete(session.token);
    activeTokenByUserId.delete(session.userId);
  }
  if (userId) { await deleteStored(userKey(userId)); activeTokenByUserId.delete(userId); }
}
