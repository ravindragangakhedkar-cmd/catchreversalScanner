# GazabPaisa Awesome Scanner

React/Vite frontend with an Express/TypeScript API and scanner services.

## Local setup

1. Use Node.js 22.12 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and enter the required credentials and Firebase Authentication web configuration.
4. Run `npm run dev`.
5. Run `npm run build` to create the Vite production bundle.

## Secrets and deployment configuration

No live API tokens, SMTP credentials, Twilio credentials, Gemini keys, or Firebase project configuration are included in this source bundle. Configure values from `.env.example` in the hosting provider's encrypted environment-variable settings. Never commit `.env.local`.

Firebase Authentication configuration is read from `VITE_FIREBASE_*` variables at build time. Only the Firebase Auth web-app values are needed. Vite-prefixed values are exposed to browsers; never put service-account JSON or private server credentials in `VITE_*` variables. This application does not use Firebase Firestore or any Firebase database.

## Vercel deployment

The project includes `vercel.json` and `api/index.ts`. Vercel builds the Vite frontend into `dist/`, serves those static assets, and routes `/api/*` to the Express function. `server.ts` exports the Express app and starts a local listener only outside Vercel. Import `ravindragangakhedkar-cmd/catchreversalScanner` from GitHub, then configure the environment variables listed in `.env.example` in Vercel. The first Vercel build and API deployment must still be verified in the Vercel build/runtime logs.


## Catch Reversals scanner additions

- Home page includes high-speed trading / precision-scanning visual panels and a Catch Reversals entry point.
- Existing stock/index scanners now request historical candles and intraday prices through Nubra Finance. Catch Reversals targets NSE F&O equities plus NIFTY, BANKNIFTY, FINNIFTY and SENSEX.
- Trading date is resolved dynamically from the current India (Asia/Kolkata) date. Monthly expiry is resolved from Nubra's returned contract calendar (with a last-Tuesday fallback only if Nubra omits expiry metadata). Per-group instrument concurrency is capped at five.
- Daily pivot levels use the prior session OHLC. Option price and cumulative OI changes use the session opening values.
- Market-open underlying price uses Nubra LTP; market-closed price uses Nubra previous close.
- Gemini analysis is requested per qualifying row and requires `GEMINI_API_KEY`.

## Broker session persistence and production validation

Nubra OTP challenges and authenticated sessions are encrypted into self-contained tokens using the server-only `BROKER_SESSION_SECRET`. This works across Vercel serverless instances without Redis, Upstash, Firestore, or any other database. The browser retains only an opaque encrypted token; the Nubra authentication token and MPIN are not stored in readable browser storage. Users must manually enter the OTP received on their mobile, and Nubra must accept the OTP and MPIN before a broker session is issued. Tokens expire after seven days. Because sessions are stateless, disconnect removes the browser's copy but cannot revoke a separately copied token before expiry. Nubra may expire its own token sooner. Validate live market data and scanner outputs before relying on them for trading decisions.


## Stateless encrypted Nubra broker sessions on Vercel

Set this single server-only Environment Variable in Vercel:

- `BROKER_SESSION_SECRET` — a randomly generated secret with at least 32 characters. Keep it private and stable. Do not prefix it with `VITE_`.

The application encrypts OTP challenges and authenticated Nubra session data into opaque AES-256-GCM tokens. The browser retains the opaque token and sends it on API requests; any Vercel function instance can decrypt it using `BROKER_SESSION_SECRET`. No Upstash, Redis, Firestore, or other database is used for broker session retention.

The OTP flow remains mandatory: Nubra sends the OTP to the user's registered mobile, the user manually enters it, and the backend submits it to Nubra. Only after Nubra accepts the OTP and MPIN does the app issue the encrypted broker session token.

Tokens expire after seven days. Since sessions are stateless, disconnect removes the token from the current browser but cannot revoke a separately copied token before expiry. Changing `BROKER_SESSION_SECRET` invalidates all existing broker sessions and pending OTP challenges.

Firebase is retained only for user Authentication (Google/email sign-in and email verification). Firestore/Cloud Firestore is not initialized or used. User profile and trial/subscription display preferences are stored locally in the browser and are not synchronized across devices or protected as server-side entitlements.
