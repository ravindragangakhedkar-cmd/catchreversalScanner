# Catch Reversals Scanner

Standalone React/Vite frontend with an Express/TypeScript API for the Catch Reversals scanner and Nubra Finance broker connection.

## Local setup

1. Use Node.js 22.12 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and enter the required server-side credentials.
4. Run `npm run dev`.
5. Run `npm run build` to create the Vite production bundle.

## Standalone application

This application contains only:
- Catch Reversals Scanner
- Nubra Finance Broker Connect

There is no Firebase, Google, email, or website-account sign-in. The scanner opens directly. Connect Nubra using the registered mobile number, MPIN, and the OTP sent by Nubra.

The Nubra session is stored in the browser as an opaque encrypted token. The server uses `BROKER_SESSION_SECRET` to encrypt and decrypt the self-contained session token; no Redis, Upstash, Firestore, or other database is used. Tokens expire after seven days. Disconnect clears the current browser's copy; a separately copied token cannot be revoked before expiry.

## Vercel deployment

The project includes `vercel.json` and `api/index.ts`. Configure the server-side variables from `.env.example` in Vercel Project Settings. Do not configure Firebase variables; they are not used.

## Security and trading notice

The MPIN is sent to the server over HTTPS for Nubra authentication and is not saved in browser storage. The OTP is entered manually and verified with Nubra. Keep `BROKER_SESSION_SECRET` private, server-side, and stable. Changing it invalidates existing broker sessions.

Scanner output is technical screening information, not investment advice. Verify live market data and all signals before making trading decisions.
