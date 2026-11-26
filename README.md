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


## Nubra Python SDK service (Bias MTF + historical candles)

Historical OHLCV requests now go through the official Nubra Python SDK service in `python-backend/`. This is separate from the Vercel Node.js runtime.

### One-time Nubra TOTP setup

The hosted Python service uses Nubra's documented TOTP + `pyotp` authentication so it can authenticate without a terminal prompt. First enable TOTP once on your Nubra account:

1. On your Windows computer, open PowerShell in the downloaded repository's `python-backend` folder.
2. Run `py -m pip install nubra-sdk`.
3. Run `py setup_totp.py` and follow Nubra's prompts.
4. Keep the printed TOTP secret private. Do not send it to anyone or commit it to GitHub.

### Deploy the Python service on Render

1. In Render, choose **New → Blueprint** and connect this GitHub repository.
2. Render reads the root `render.yaml` and creates the Python service.
3. In the Python service's Environment settings, set `NUBRA_PHONE_NO`, `NUBRA_MPIN`, and `NUBRA_TOTP_SECRET`.
4. Wait until the service is Live. Open its `/health` URL; it should return JSON with `ok: true`.

The Render blueprint creates `SERVICE_API_KEY` automatically. Copy its value from Render's Environment page.

### Connect Vercel to the Python service

In Vercel → Project → Settings → Environment Variables, add:

- `NUBRA_PYTHON_API_URL`: the Render service base URL, without a trailing slash
- `NUBRA_PYTHON_API_KEY`: the Render `SERVICE_API_KEY` value

Redeploy the Vercel project after adding these variables.

The Python service uses a free Render instance in the initial blueprint. Free instances can sleep when idle, so the first request after inactivity may take longer. Upgrade the Render service to an always-on instance if you need predictable response time during market hours.

### Scope

The Bias Multi Time Frame scanner and the shared historical-candle loader use the Python SDK service. Catch Reversals still uses the existing browser Nubra connection for its option-chain snapshot; its historical candles now use the Python SDK service. No order-placement endpoint is exposed by the Python service.
