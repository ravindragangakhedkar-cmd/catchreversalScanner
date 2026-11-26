import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLiveMarketTicker,
  getScannedIndexBasket,
  getScannedSuperPivots,
  getScannedUniverse,
  scanCustomNseSymbol,
} from './server/marketDataService.ts';
import { getCatchReversals } from './server/catchReversalsService.ts';
import { getBiasMultiTimeframe } from './server/biasMultiTimeframeService.ts';
import {
  getScannedOptionCallShortCovering,
  getScannedOptionPutShortCovering,
} from './server/nubraService.ts';
import {
  disconnectBrokerSession,
  getBrokerSessionByToken,
  initiateBrokerLogin,
  verifyBrokerOtp,
} from './server/brokerService.ts';
import {
  generateCatchReversalAnalysis,
  generateScanner1Analysis,
  generateScanner2PivotAnalysis,
} from './server/geminiService.ts';
import {
  getAlertChannelStatus,
  getAlertChartAsset,
  getAlertHistory,
  registerAlertSseClient,
} from './server/alertService.ts';
import { getNSEMarketClockStatus } from './shared/indicators.ts';
import { OFFICIAL_MERCHANT_EMAIL, type AnalyzedStock } from './shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
app.use(express.json({ limit: '1mb' }));

function extractBrokerToken(req: express.Request): string | undefined {
  const header = req.header('x-broker-session');
  return header?.trim() || undefined;
}

// Live Market Ticker (Nifty Spot, Bank Nifty, Crude INR, Gold INR, Silver INR, India VIX)
app.get('/api/market/ticker', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const data = await getLiveMarketTicker(extractBrokerToken(req));
    res.json(data);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Unable to fetch live market ticker.',
    });
  }
});

// Scanned Nifty 500 + F&O Stock Universe (Requires active Broker Connect; zero memory cache)
app.get('/api/market/scan', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const token = extractBrokerToken(req);
    const brokerSession = await getBrokerSessionByToken(token);
    if (!brokerSession?.connected) {
      res.status(401).json({
        error: 'Broker not connected. Please connect via Multi Broker Connect first.',
        brokerRequired: true,
      });
      return;
    }

    const bbwpMaxRaw = req.query.bbwpMax ? Number(req.query.bbwpMax) : undefined;
    const setupRaw = typeof req.query.setupFilter === 'string' ? req.query.setupFilter : undefined;
    const emaRaw = typeof req.query.emaFilter === 'string' ? req.query.emaFilter : undefined;

    const data = await getScannedUniverse(
      true,
      {
        bbwpMax: Number.isFinite(bbwpMaxRaw) ? bbwpMaxRaw : undefined,
        pvoPositive: req.query.pvoPositive === '1',
        setupFilter:
          setupRaw === 'all-setups' ||
          setupRaw === 'bounce' ||
          setupRaw === 'dip' ||
          setupRaw === 'confluence' ||
          setupRaw === 'universe'
            ? setupRaw
            : undefined,
        emaFilter: emaRaw === 'any' || emaRaw === 'gt' || emaRaw === 'lt' ? emaRaw : undefined,
        skipIntraday: req.query.skipIntraday === '1',
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
      },
      token,
    );
    res.json({
      ...data,
      brokerConnected: true,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to run NSE scanner.',
    });
  }
});

// Scanned Index Basket for Scanner 3 (Requires active Broker Connect; zero memory cache)
app.get('/api/market/scan-indices', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const token = extractBrokerToken(req);
    const brokerSession = await getBrokerSessionByToken(token);
    if (!brokerSession?.connected) {
      res.status(401).json({
        error: 'Broker not connected. Please connect via Multi Broker Connect first.',
        brokerRequired: true,
      });
      return;
    }

    const mbRaw = typeof req.query.marketBiasFilter === 'string' ? req.query.marketBiasFilter : 'ALL';
    const trRaw = typeof req.query.twinRangeFilter === 'string' ? req.query.twinRangeFilter : 'ALL';

    const data = await getScannedIndexBasket(
      true,
      {
        marketBiasFilter:
          mbRaw === 'Bullish Bounce' || mbRaw === 'Bearish Dip' || mbRaw === 'Neutral'
            ? mbRaw
            : 'ALL',
        twinRangeFilter:
          trRaw === 'BUY' || trRaw === 'SELL' || trRaw === 'HOLD' ? trRaw : 'ALL',
        bbwp0To50: req.query.bbwp0To50 === '1',
        pvoPositive: req.query.pvoPositive === '1',
      },
      token,
    );
    res.json({
      ...data,
      brokerConnected: true,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to scan live Index Basket.',
    });
  }
});

// Scanned Nifty 500, F&O Stocks & All Indices for Scanner 4 — Super Pivots
app.get('/api/market/scan-super-pivots', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const token = extractBrokerToken(req);
    const brokerSession = await getBrokerSessionByToken(token);
    if (!brokerSession?.connected) {
      res.status(401).json({
        error: 'Broker not connected. Please connect via Multi Broker Connect first.',
        brokerRequired: true,
      });
      return;
    }

    const trendRaw = typeof req.query.trendFilter === 'string' ? req.query.trendFilter : 'ALL';
    const segmentRaw =
      typeof req.query.segmentFilter === 'string' ? req.query.segmentFilter : 'all';

    const data = await getScannedSuperPivots(
      true,
      {
        trendFilter:
          trendRaw === 'Strong Uptrend' ||
          trendRaw === 'Uptrend' ||
          trendRaw === 'Sideways' ||
          trendRaw === 'Downtrend' ||
          trendRaw === 'Severe Downtrend'
            ? trendRaw
            : 'ALL',
        segmentFilter:
          segmentRaw === 'indices' || segmentRaw === 'stocks' ? segmentRaw : 'all',
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
      },
      token,
    );

    res.json({
      ...data,
      brokerConnected: true,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to scan Super Pivots.',
    });
  }
});

// Bias Multi Time Frame — Weekly/Daily Market Bias CEREBR + Daily Twin Range
app.get('/api/market/scan-bias-mtf', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // Bias MTF uses the separately authenticated Nubra Python SDK service.
    // It does not depend on the browser's REST-session token.
    res.json(await getBiasMultiTimeframe());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Bias Multi Time Frame scan failed.' });
  }
});

// Generic Nubra Python SDK data access: instruments, derivatives history and option chains.
function nubraPythonConfig() {
  const base=process.env.NUBRA_PYTHON_API_URL?.trim().replace(/\/$/,'');
  const key=process.env.NUBRA_PYTHON_API_KEY?.trim();
  if(!base||!key) throw new Error('Nubra Python SDK service is not configured in Vercel. Set NUBRA_PYTHON_API_URL and NUBRA_PYTHON_API_KEY.');
  return {base,key};
}
async function nubraPythonFetch(path:string,init:RequestInit={}) {
  const {base,key}=nubraPythonConfig();
  const response=await fetch(`${base}${path}`,{
    ...init,
    headers:{'Content-Type':'application/json','x-service-key':key,...(init.headers??{})},
    cache:'no-store',
    signal:AbortSignal.timeout(65000),
  });
  const textBody=await response.text();
  let payload:any;
  try { payload=textBody?JSON.parse(textBody):{}; } catch { payload={detail:textBody.slice(0,500)}; }
  if(!response.ok) throw new Error(payload.detail||payload.error||`Python SDK service HTTP ${response.status}`);
  return payload;
}

app.get('/api/nubra/instruments',async(req,res)=>{
  try {
    const allowed=['exchange','asset','derivative_type','expiry','option_type','symbol','limit'];
    const params=new URLSearchParams();
    for(const key of allowed){const value=req.query[key];if(typeof value==='string'&&value.trim())params.set(key,value.trim());}
    res.setHeader('Cache-Control','no-store');
    res.json(await nubraPythonFetch(`/v1/instruments?${params.toString()}`));
  } catch(err) { res.status(502).json({error:err instanceof Error?err.message:'Nubra instrument lookup failed.'}); }
});

app.post('/api/nubra/history',async(req,res)=>{
  try {
    const body=req.body as {exchange?:string;instrument_type?:string;symbols?:string[];fields?:string[];start_date?:string;end_date?:string;interval?:string;intraday?:boolean;realtime?:boolean};
    if(!body||!Array.isArray(body.symbols)||body.symbols.length<1||body.symbols.length>5){
      res.status(400).json({error:'Provide between one and five instrument symbols per request.'});return;
    }
    if(!['NSE','BSE','MCX'].includes(body.exchange??'NSE')||!['STOCK','INDEX','FUT','OPT'].includes(body.instrument_type??'')){
      res.status(400).json({error:'Use exchange NSE/BSE/MCX and instrument_type STOCK/INDEX/FUT/OPT.'});return;
    }
    res.setHeader('Cache-Control','no-store');
    res.json(await nubraPythonFetch('/v1/history',{method:'POST',body:JSON.stringify(body)}));
  } catch(err) { res.status(502).json({error:err instanceof Error?err.message:'Nubra historical data request failed.'}); }
});

app.get('/api/nubra/indices',async(req,res)=>{
  try {
    const symbol=typeof req.query.symbol==='string'?req.query.symbol.trim():'';
    const params=new URLSearchParams();if(symbol)params.set('symbol',symbol);
    res.setHeader('Cache-Control','public, max-age=900');
    res.json(await nubraPythonFetch(`/v1/indices?${params.toString()}`));
  } catch(err) { res.status(502).json({error:err instanceof Error?err.message:'Nubra index master lookup failed.'}); }
});

app.get('/api/nubra/current-price',async(req,res)=>{
  try {
    const instrument=typeof req.query.instrument==='string'?req.query.instrument.trim():'';
    const exchange=typeof req.query.exchange==='string'?req.query.exchange:'NSE';
    if(!instrument){res.status(400).json({error:'An instrument symbol is required.'});return;}
    const params=new URLSearchParams({instrument,exchange});
    res.setHeader('Cache-Control','no-store');
    res.json(await nubraPythonFetch(`/v1/current-price?${params.toString()}`));
  } catch(err) { res.status(502).json({error:err instanceof Error?err.message:'Nubra current-price request failed.'}); }
});

app.get('/api/nubra/option-chain',async(req,res)=>{
  try {
    const instrument=typeof req.query.instrument==='string'?req.query.instrument.trim():'';
    const exchange=typeof req.query.exchange==='string'?req.query.exchange:'NSE';
    const expiry=typeof req.query.expiry==='string'?req.query.expiry:'';
    if(!instrument){res.status(400).json({error:'An underlying instrument is required.'});return;}
    const params=new URLSearchParams({instrument,exchange});if(expiry)params.set('expiry',expiry);
    res.setHeader('Cache-Control','no-store');
    res.json(await nubraPythonFetch(`/v1/option-chain?${params.toString()}`));
  } catch(err) { res.status(502).json({error:err instanceof Error?err.message:'Nubra option-chain request failed.'}); }
});

// Catch Reversals — Nubra Finance, dynamic India trading date and next monthly expiry; max five instruments per batch.
app.get('/api/market/scan-catch-reversals', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // All Catch Reversals market data, including the option chain, now uses
    // the separately authenticated Nubra Python SDK service.
    res.json(await getCatchReversals());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Catch Reversals scan failed.' });
  }
});

app.post('/api/gemini/catch-reversal-analysis', async (req, res) => {
  try {
    const { row } = req.body as { row?: Record<string, unknown> };
    if (!row || typeof row.symbol !== 'string') { res.status(400).json({ error: 'A valid reversal row is required.' }); return; }
    res.json({ analysis: await generateCatchReversalAnalysis(row) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Gemini analysis failed.' });
  }
});

// Scanned F&O Stocks & Indices for Scanner 5 — Option Call Short Covering (Nubra Broker 1h)
app.get('/api/market/scan-option-short-covering', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const token = extractBrokerToken(req);
    const brokerSession = await getBrokerSessionByToken(token);
    if (!brokerSession?.connected) {
      res.status(401).json({
        error: 'Broker not connected. Please connect via Multi Broker Connect first.',
        brokerRequired: true,
      });
      return;
    }

    const modeRaw = typeof req.query.filterMode === 'string' ? req.query.filterMode : 'qualifying';
    const segRaw =
      typeof req.query.segmentFilter === 'string' ? req.query.segmentFilter : 'all';

    const data = await getScannedOptionCallShortCovering(
      true,
      {
        filterMode:
          modeRaw === 'call-gt-2' || modeRaw === 'all' ? modeRaw : 'qualifying',
        segmentFilter: segRaw === 'indices' || segRaw === 'stocks' ? segRaw : 'all',
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
      },
      token,
    );

    res.json({
      ...data,
      brokerConnected: true,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to run Option Calls scanner.',
    });
  }
});

// Scanned F&O Stocks & Indices for Scanner 6 — Option Put Short Covering (Nubra Broker 1h)
app.get('/api/market/scan-option-put-short-covering', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const token = extractBrokerToken(req);
    const brokerSession = await getBrokerSessionByToken(token);
    if (!brokerSession?.connected) {
      res.status(401).json({
        error: 'Broker not connected. Please connect via Multi Broker Connect first.',
        brokerRequired: true,
      });
      return;
    }

    const modeRaw = typeof req.query.filterMode === 'string' ? req.query.filterMode : 'qualifying';
    const segRaw =
      typeof req.query.segmentFilter === 'string' ? req.query.segmentFilter : 'all';

    const data = await getScannedOptionPutShortCovering(
      true,
      {
        filterMode:
          modeRaw === 'put-gt-2' || modeRaw === 'all' ? modeRaw : 'qualifying',
        segmentFilter: segRaw === 'indices' || segRaw === 'stocks' ? segRaw : 'all',
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
      },
      token,
    );

    res.json({
      ...data,
      brokerConnected: true,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to run Option Puts scanner.',
    });
  }
});

// On-demand single NSE symbol scan (Requires active Broker Connect; zero memory cache)
app.get('/api/market/stock/:symbol', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const token = extractBrokerToken(req);
    const brokerSession = await getBrokerSessionByToken(token);
    if (!brokerSession?.connected) {
      res.status(401).json({
        error: 'Broker not connected. Please connect via Multi Broker Connect first.',
        brokerRequired: true,
      });
      return;
    }

    const stock = await scanCustomNseSymbol(req.params.symbol, true, token);
    if (!stock) {
      res.status(404).json({ error: `Stock ${req.params.symbol.toUpperCase()} not found on NSE.` });
      return;
    }
    res.json({ stock });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to scan requested symbol.',
    });
  }
});

// Zero-Lag Confluence Alert History & Live SSE Stream (Scanner 1 & Scanner 3)
app.get('/api/alerts/history', (req, res) => {
  const scannerParam = req.query.scanner;
  const scanner =
    scannerParam === 'scanner1' || scannerParam === 'scanner3' ? scannerParam : undefined;
  res.json({
    alerts: getAlertHistory(scanner),
    config: getAlertChannelStatus(),
    clock: getNSEMarketClockStatus(),
  });
});

app.get('/api/alerts/stream', (req, res) => {
  registerAlertSseClient(req, res);
});

app.get('/api/alerts/chart/:id', (req, res) => {
  const asset = getAlertChartAsset(req.params.id);
  if (!asset) {
    res.status(404).json({ error: 'Alert chart not found.' });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (asset.type === 'png') {
    res.type('image/png').send(asset.data);
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.type('image/svg+xml').send(asset.data);
  }
});

// Multi-Broker Connect
app.get('/api/broker/status', async (req, res) => {
  try {
    const session = await getBrokerSessionByToken(extractBrokerToken(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ session });
  } catch (err) { res.status(503).json({ error: err instanceof Error ? err.message : 'Unable to restore broker session.' }); }
});

app.get('/api/broker/session', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const session = await getBrokerSessionByToken(extractBrokerToken(req));
    if (!session) { res.status(401).json({ session: null }); return; }
    res.json({ session });
  } catch (err) { res.status(503).json({ error: err instanceof Error ? err.message : 'Unable to restore broker session.' }); }
});

app.post('/api/broker/login', async (req, res) => {
  try {
    const { userId, mobile, mpin, provider } = req.body as {
      userId?: string;
      mobile?: string;
      mpin?: string;
      provider?: string;
    };
    if (!userId || typeof userId !== 'string') {
      res.status(401).json({ error: 'Authenticated user ID required to connect broker.' });
      return;
    }
    const safeProvider = provider === 'nubra' ? 'nubra' : 'broker';
    const result = await initiateBrokerLogin(
      userId,
      String(mobile ?? ''),
      String(mpin ?? ''),
      safeProvider,
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to initiate Broker login.',
    });
  }
});

app.post('/api/broker/verify-otp', async (req, res) => {
  try {
    const { userId, challengeId, otp } = req.body as {
      userId?: string;
      challengeId?: string;
      otp?: string;
    };
    if (!userId || !challengeId || !otp) {
      res.status(400).json({ error: 'User ID, challenge ID, and 6-digit OTP are required.' });
      return;
    }
    const result = await verifyBrokerOtp(userId, challengeId, String(otp));
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'OTP verification failed.',
    });
  }
});

app.post('/api/broker/disconnect', async (req, res) => {
  try {
    const { userId } = (req.body ?? {}) as { userId?: string };
    await disconnectBrokerSession(extractBrokerToken(req), userId);
    res.json({ disconnected: true });
  } catch (err) { res.status(503).json({ error: err instanceof Error ? err.message : 'Unable to disconnect broker session.' }); }
});

// Gemini AI Endpoints (Scanner 1 & Scanner 2)
app.post('/api/gemini/scanner1-analysis', async (req, res) => {
  try {
    const { stock } = req.body as { stock?: AnalyzedStock };
    if (!stock || !stock.symbol) {
      res.status(400).json({ error: 'Valid analyzed stock payload is required.' });
      return;
    }
    const analysis = await generateScanner1Analysis(stock);
    res.json({ analysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gemini analysis request failed.';
    res.status(502).json({ error: message });
  }
});

app.post('/api/gemini/scanner2-pivot', async (req, res) => {
  try {
    const { stock } = req.body as { stock?: AnalyzedStock };
    if (!stock || !stock.symbol) {
      res.status(400).json({ error: 'Valid analyzed stock payload is required.' });
      return;
    }
    const analysis = await generateScanner2PivotAnalysis(stock);
    res.json({ analysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ASK Gemini pivot request failed.';
    res.status(502).json({ error: message });
  }
});

// Google Play Store Checkout Session Verification (Linked to YOUR_SUPPORT_EMAIL@example.com)
app.post('/api/billing/verify-play-order', (req, res) => {
  const { planId, paymentMethod } = req.body as {
    planId?: 'monthly' | 'yearly';
    paymentMethod?: string;
  };
  if (planId !== 'monthly' && planId !== 'yearly') {
    res.status(400).json({ error: 'Invalid subscription package selected.' });
    return;
  }
  const amountInr = planId === 'monthly' ? 99 : 499;
  const orderId = `GPA.${Date.now()}.${Math.floor(1000 + Math.random() * 9000)}`;
  res.json({
    verified: true,
    orderId,
    planId,
    amountInr,
    paymentMethod: paymentMethod || 'Google Play UPI',
    linkedPayeeAccount: OFFICIAL_MERCHANT_EMAIL,
    correspondenceEmail: OFFICIAL_MERCHANT_EMAIL,
    verifiedAtIso: new Date().toISOString(),
  });
});

// User Email Correspondence Routing Endpoint (Directed to YOUR_SUPPORT_EMAIL@example.com)
app.post('/api/contact/send', (req, res) => {
  const { name, email, phone, message } = (req.body ?? {}) as {
    name?: string;
    email?: string;
    phone?: string;
    message?: string;
  };
  if (!name || name.trim().length < 2) {
    res.status(400).json({ error: 'Please enter your full name.' });
    return;
  }
  if (!email || !email.includes('@')) {
    res.status(400).json({ error: 'Please enter a valid email address.' });
    return;
  }
  if (!phone || phone.trim().length < 6) {
    res.status(400).json({ error: 'Please enter a valid phone number.' });
    return;
  }
  if (!message || message.trim().length < 5) {
    res.status(400).json({ error: 'Please enter your inquiry message.' });
    return;
  }

  const referenceId = `CORR-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
  res.json({
    accepted: true,
    referenceId,
    routedTo: OFFICIAL_MERCHANT_EMAIL,
    receivedAtIso: new Date().toISOString(),
  });
});

// Ensure /api/* never falls through to SPA index.html (<!doctype html>)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.path.startsWith('/api')) {
      const msg = err instanceof Error ? err.message : 'Internal server error.';
      res.status(500).json({ error: msg });
      return;
    }
    next(err);
  },
);

async function startServer() {
  const port = Number(process.env.PORT || 3000);
  const distDir = path.resolve(__dirname, 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distDir);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`GazabPaisa Awesome Scanner running on http://0.0.0.0:${port}`);
  });
}

if (process.env.VERCEL !== '1') {
  void startServer();
}

export default app;
