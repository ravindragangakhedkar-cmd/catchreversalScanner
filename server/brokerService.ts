import crypto from 'node:crypto';
import type { BrokerSessionInfo } from '../shared/types.ts';

interface PendingChallenge {
  challengeId: string; userId: string; mobile: string; mpin: string;
  maskedMobile: string; mode: 'live-api'; provider: 'nubra';
  nubraTempToken: string; nubraDeviceId: string; expiresAt: number;
}
interface ActiveBrokerSession extends BrokerSessionInfo {
  userId: string; nubraAuthToken: string; nubraDeviceId: string; expiresAt: number;
}
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const CHALLENGE_TTL_SECONDS = 5 * 60;

function getSecret(): string {
  const secret = process.env.BROKER_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('Broker session security is not configured. Add BROKER_SESSION_SECRET (at least 32 characters) to Vercel Environment Variables and redeploy.');
  }
  return secret;
}
function key(): Buffer {
  return crypto.createHash('sha256').update('gazabpaisa-broker-session-v1:').update(getSecret()).digest();
}
function seal<T>(value: T): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function unseal<T>(token: string): T {
  const [version, iv, tag, data] = token.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Invalid secure broker token. Please reconnect.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  } catch {
    throw new Error('Secure broker token could not be verified. Please reconnect.');
  }
}
function getSafeNubraBaseUrl(): string {
  const configured = process.env.NUBRA_API_BASE_URL?.trim() || 'https://api.nubra.io';
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') return 'https://api.nubra.io';
    return new Set(['api.nubra.io', 'uatapi.nubra.io']).has(parsed.hostname) ? parsed.origin : 'https://api.nubra.io';
  } catch { return 'https://api.nubra.io'; }
}
function maskIndianMobile(mobile: string): string { return `+91 ••••••${mobile.slice(-4)}`; }

export async function initiateBrokerLogin(
  userId: string, mobile: string, mpin: string, provider: 'nubra' | 'broker' = 'nubra',
): Promise<{ challengeId: string; maskedMobile: string; mode: 'live-api'; provider: 'nubra'; message: string }> {
  getSecret();
  if (provider !== 'nubra') throw new Error('Only Nubra Finance authentication is supported.');
  if (!/^[6-9]\d{9}$/.test(mobile)) throw new Error('Enter a valid 10-digit Indian registered mobile number.');
  if (!/^\d{4}$/.test(mpin)) throw new Error('MPIN must be exactly 4 digits.');

  const challengeId = crypto.randomUUID();
  const maskedMobile = maskIndianMobile(mobile);
  const deviceId = process.env.NUBRA_DEVICE_ID?.trim() || `GP-${crypto.randomBytes(6).toString('hex')}`;
  const response = await fetch(`${getSafeNubraBaseUrl()}/sendphoneotp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-id': deviceId },
    body: JSON.stringify({ phone: mobile, skip_totp: false }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Nubra OTP request failed (HTTP ${response.status}). Check the registered mobile number and try again.`);
  const result = await response.json() as { temp_token?: string; token?: string };
  const firstTempToken = result.temp_token || result.token;
  if (!firstTempToken) throw new Error('Nubra did not return the initial OTP token. Please try again.');

  // REST API V3 requires a second sendphoneotp call with the first temp token.
  // The latest temp_token from this call is the one used to verify the SMS OTP.
  const otpSendResponse = await fetch(`${getSafeNubraBaseUrl()}/sendphoneotp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-temp-token': firstTempToken, 'x-device-id': deviceId },
    body: JSON.stringify({ phone: mobile }),
    signal: AbortSignal.timeout(10000),
  });
  if (!otpSendResponse.ok) throw new Error(`Nubra OTP dispatch failed (HTTP ${otpSendResponse.status}). Please retry the connection.`);
  const otpSendResult = await otpSendResponse.json() as { temp_token?: string; token?: string };
  const tempToken = otpSendResult.temp_token || otpSendResult.token || firstTempToken;

  const challenge: PendingChallenge = {
    challengeId, userId, mobile, mpin, maskedMobile, mode: 'live-api', provider: 'nubra',
    nubraTempToken: tempToken, nubraDeviceId: deviceId,
    expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
  };
  // Encrypted, self-contained challenge token: no server memory or database required.
  return {
    challengeId: seal(challenge), maskedMobile, mode: 'live-api', provider: 'nubra',
    message: `Nubra sent an OTP to ${maskedMobile}. Enter the OTP received on your mobile to complete authentication.`,
  };
}

export async function verifyBrokerOtp(
  userId: string, challengeToken: string, otp: string,
): Promise<{ sessionToken: string; session: BrokerSessionInfo }> {
  if (!/^\d{6}$/.test(otp)) throw new Error('OTP must be a 6-digit numeric code.');
  const challenge = unseal<PendingChallenge>(challengeToken);
  if (challenge.userId !== userId) throw new Error('OTP challenge does not belong to the signed-in user.');
  if (Date.now() > challenge.expiresAt) throw new Error('OTP expired. Please request a new OTP.');

  // Keep manual OTP entry and verify it with Nubra before MPIN verification.
  const otpResponse = await fetch(`${getSafeNubraBaseUrl()}/verifyphoneotp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-temp-token': challenge.nubraTempToken, 'x-device-id': challenge.nubraDeviceId },
    body: JSON.stringify({ phone: challenge.mobile, otp }), signal: AbortSignal.timeout(7000),
  });
  if (!otpResponse.ok) throw new Error('Nubra rejected the OTP. Please verify the code received on your mobile and try again.');
  const otpResult = await otpResponse.json() as { auth_token?: string; session_token?: string; token?: string };
  const otpAuthToken = otpResult.auth_token || otpResult.token;
  if (!otpAuthToken) throw new Error('Nubra OTP verification did not return the temporary auth_token required for MPIN verification.');

  // REST API V3: verify MPIN with the OTP auth_token as Bearer credentials.
  // Only the session_token returned by /verifypin is valid for market-data calls.
  const pinResponse = await fetch(`${getSafeNubraBaseUrl()}/verifypin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${otpAuthToken}`, 'x-device-id': challenge.nubraDeviceId },
    body: JSON.stringify({ pin: challenge.mpin }), signal: AbortSignal.timeout(10000),
  });
  if (!pinResponse.ok) throw new Error(`Nubra MPIN verification failed (HTTP ${pinResponse.status}). Please reconnect and verify your MPIN.`);
  const pinResult = await pinResponse.json() as { session_token?: string };
  const authToken = pinResult.session_token;
  if (!authToken) throw new Error('Nubra MPIN verification did not return the final session_token. Please reconnect.');

  const connectedAtIso = new Date().toISOString();
  const active: ActiveBrokerSession = {
    userId, connected: true, maskedMobile: challenge.maskedMobile, clientCode: 'Nubra Finance',
    mode: 'live-api', provider: 'nubra', nubraLiveAuth: true, connectedAtIso,
    nubraAuthToken: authToken, nubraDeviceId: challenge.nubraDeviceId,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  return {
    sessionToken: seal(active),
    session: {
      connected: true, maskedMobile: active.maskedMobile, clientCode: active.clientCode,
      mode: active.mode, provider: active.provider, nubraLiveAuth: true, connectedAtIso,
    },
  };
}

function decodeSession(token: string | undefined): ActiveBrokerSession | null {
  if (!token) return null;
  const session = unseal<ActiveBrokerSession>(token);
  if (!session.connected || !session.nubraAuthToken || Date.now() > session.expiresAt) return null;
  return session;
}
export async function getBrokerSessionByToken(token: string | undefined): Promise<BrokerSessionInfo | null> {
  if (!token) return null;
  try {
    const session = decodeSession(token);
    if (!session) return null;
    return {
      connected: true, maskedMobile: session.maskedMobile, clientCode: session.clientCode,
      mode: session.mode, provider: session.provider, nubraLiveAuth: session.nubraLiveAuth,
      connectedAtIso: session.connectedAtIso,
    };
  } catch { return null; }
}
export async function getNubraCredentialsForSession(token: string | undefined): Promise<{ authToken?: string; deviceId?: string }> {
  if (token) {
    try {
      const session = decodeSession(token);
      return session ? { authToken: session.nubraAuthToken, deviceId: session.nubraDeviceId } : {};
    } catch { return {}; }
  }
  return { authToken: process.env.NUBRA_AUTH_TOKEN?.trim() || undefined, deviceId: process.env.NUBRA_DEVICE_ID?.trim() || 'GP-WEB' };
}
export async function disconnectBrokerSession(_token: string | undefined, _userId?: string): Promise<void> {
  // Stateless tokens cannot be revoked server-side. The client clears its token; it expires in 7 days.
}
