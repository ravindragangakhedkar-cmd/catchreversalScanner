# Catch Reversals Scanner

Standalone React/Vite frontend with an Express/TypeScript API for the Catch Reversals scanner and Nubra Finance broker connection.

## Local setup

1. Use Node.js 22.12 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and enter the required server-side credentials.
4. Run `npm run dev`.
5. Run `npm run build` to create the Vite production bundle.

## Nubra connection — REST API only

Nubra authentication and market-data requests use Nubra's HTTPS REST API directly from the Vercel Node.js server. **The Nubra Python SDK and the separate Python/Render backend are not used.**

Broker Connect uses the registered mobile number and MPIN to request Nubra's SMS OTP. The user enters the OTP in the application; the server verifies the OTP and then verifies the MPIN with Nubra. The resulting Nubra session is stored in the browser as an opaque encrypted token. The server uses `BROKER_SESSION_SECRET` to encrypt and decrypt the token.

No Firebase, Google, email, or website-account sign-in is required. The scanner opens directly. No Redis, Upstash, Firestore, or other database is used.

## Vercel deployment

The project includes `vercel.json` and `api/index.ts`. Configure the server-side variables from `.env.example` in Vercel Project Settings.

Required for broker sessions:
- `BROKER_SESSION_SECRET`: a private random secret of at least 32 characters. Keep it stable; changing it invalidates existing sessions.

Nubra REST API defaults to `https://api.nubra.io`. `NUBRA_API_BASE_URL` is optional and should only be changed if Nubra provides a different approved API environment. `NUBRA_DEVICE_ID` is optional.

Do not configure `NUBRA_PYTHON_API_URL`, `NUBRA_PYTHON_API_KEY`, or Render service credentials; they are not used.

## Security and trading notice

The MPIN is sent only from the Vercel server to Nubra over HTTPS and is not saved in browser storage. The SMS OTP is entered manually and verified with Nubra. Keep `BROKER_SESSION_SECRET` private and server-side. Broker session tokens expire after seven days. Disconnect clears the current browser's copy; a separately copied token cannot be revoked before expiry.

Scanner output is technical screening information, not investment advice. Verify live market data and all signals before making trading decisions.
