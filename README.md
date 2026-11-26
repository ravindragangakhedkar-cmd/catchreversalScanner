# GazabPaisa Awesome Scanner

React/Vite frontend with an Express/TypeScript API and scanner services.

## Local setup

1. Use Node.js 22.12 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and enter the required credentials and Firebase web configuration.
4. Run `npm run dev`.
5. Run `npm run build` to create the Vite production bundle.

## Secrets and deployment configuration

No live API tokens, SMTP credentials, Twilio credentials, Gemini keys, or Firebase project configuration are included in this source bundle. Configure values from `.env.example` in the hosting provider's encrypted environment-variable settings. Never commit `.env.local`.

Firebase web configuration is read from `VITE_FIREBASE_*` variables at build time. Because Vite-prefixed values are exposed to browsers, only use Firebase web configuration values here; never put service-account JSON or private server credentials in `VITE_*` variables. Protect Firebase resources with restrictive Authentication and Firestore Security Rules.

## Vercel deployment

The project includes `vercel.json` and `api/index.ts`. Vercel builds the Vite frontend into `dist/`, serves those static assets, and routes `/api/*` to the Express function. `server.ts` exports the Express app and starts a local listener only outside Vercel. Import `ravindragangakhedkar-cmd/gazabscanner` or upload this source archive as a GitHub repository, then configure the environment variables listed in `.env.example` in Vercel. The first Vercel build and API deployment must still be verified in the Vercel build/runtime logs.


## Catch Reversals scanner additions

- Home page includes high-speed trading / precision-scanning visual panels and a Catch Reversals entry point.
- Existing stock/index scanners now request historical candles and intraday prices through Nubra Finance. Catch Reversals targets NSE F&O equities plus NIFTY, BANKNIFTY, FINNIFTY and SENSEX.
- Trading date is resolved dynamically from the current India (Asia/Kolkata) date. Monthly expiry is resolved from Nubra's returned contract calendar (with a last-Tuesday fallback only if Nubra omits expiry metadata). Per-group instrument concurrency is capped at five.
- Daily pivot levels use the prior session OHLC. Option price and cumulative OI changes use the session opening values.
- Market-open underlying price uses Nubra LTP; market-closed price uses Nubra previous close.
- Gemini analysis is requested per qualifying row and requires `GEMINI_API_KEY`.

## Broker session persistence and production validation

Nubra OTP challenges and authenticated sessions are stored encrypted in Upstash Redis when the server-side REST URL and API token are configured. This supports Vercel serverless instance changes; without the store configuration, Vercel Broker Connect fails closed instead of presenting an in-memory session as persistent. The browser retains only an opaque GazabPaisa session token, never the Nubra authentication token or MPIN. Nubra can expire its own token independently, so verify the live connection after deployment and reconnect when Nubra rejects an expired token. The application does not generate or display demo OTPs. Validate live market data and all scanner outputs before relying on them for trading decisions.


## Persistent Nubra broker sessions on Vercel

Broker sessions are encrypted server-side and stored in Upstash Redis so they survive Vercel function restarts and scale-out. The opaque app session token is retained in the signed-in browser's local storage; the Nubra authentication token and temporary OTP challenge are never written to browser storage. Configure these server-only Vercel Environment Variables before using Broker Connect:

- `UPSTASH_REDIS_REST_URL` — the Upstash Redis REST endpoint URL.
- `UPSTASH_REDIS_REST_TOKEN` — the Upstash Redis REST API token/key. This key also derives the AES-256-GCM encryption key for stored broker credentials. Keep it secret and never prefix it with `VITE_`.

If these values are missing in Vercel, Broker Connect intentionally refuses to start rather than claiming a session will persist when it cannot. Sessions have a seven-day storage TTL; Nubra may expire its own authentication token sooner, in which case reconnect through OTP/MPIN. OTP challenges are encrypted and retained for five minutes so OTP verification can reach a different serverless function instance.
