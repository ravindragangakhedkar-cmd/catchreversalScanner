import { analyzeStockData, getNSEMarketClockStatus } from '../shared/indicators.ts';
import {
  INDEX_BASKET_UNIVERSE,
  NIFTY_500_FNO_UNIVERSE,
  type StockUniverseEntry,
} from '../shared/nifty500Universe.ts';
import type {
  AnalyzedStock,
  MarketBiasSetup,
  MarketClockStatus,
  OhlcvBar,
  SuperPivotTrend,
  TickerItem,
  TwinRangeSignal,
} from '../shared/types.ts';
import { evaluateAndDispatchConfluenceAlerts } from './alertService.ts';
import { getNubraCredentialsForSession } from './brokerService.ts';
import { getIstSessionUtcRange, getIstTradingDate, getLastCompletedWeekdayDate } from './marketDates.ts';

const YAHOO_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Cache-Control': 'no-cache',
};

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: { description?: string };
  };
}

export interface UniverseScanFilters {
  bbwpMax?: number;
  pvoPositive?: boolean;
  setupFilter?: 'all-setups' | 'bounce' | 'dip' | 'confluence' | 'universe';
  emaFilter?: 'any' | 'gt' | 'lt';
  skipIntraday?: boolean;
  q?: string;
}

export interface IndexScanFilters {
  marketBiasFilter?: 'ALL' | MarketBiasSetup;
  twinRangeFilter?: 'ALL' | TwinRangeSignal;
  bbwp0To50?: boolean;
  pvoPositive?: boolean;
}

export interface SuperPivotScanFilters {
  trendFilter?: 'ALL' | SuperPivotTrend;
  segmentFilter?: 'all' | 'indices' | 'stocks';
  q?: string;
}

async function fetchYahooChartFresh(
  yahooSymbol: string,
  range: '5d' | '3mo' | '1y',
  interval: '1d' | '1h' = '1d',
): Promise<{
  bars: OhlcvBar[];
  regularMarketPrice: number | null;
  previousClose: number;
} | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${interval}&_=${Date.now()}`;
  try {
    const res = await fetch(url, {
      headers: YAHOO_HEADERS,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as YahooChartResponse;
    const result = json.chart?.result?.[0];
    if (!result || !result.timestamp || !result.indicators?.quote?.[0]) return null;

    const quote = result.indicators.quote[0];
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i] ?? 0;
      if (o == null || h == null || l == null || c == null) continue;
      const ts = result.timestamp[i] * 1000;
      bars.push({
        date: new Date(ts).toISOString().slice(0, 10),
        timestamp: ts,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
      });
    }

    if (bars.length === 0) return null;

    const metaPrice = result.meta?.regularMarketPrice ?? bars[bars.length - 1].close;
    const prevClose =
      result.meta?.previousClose ??
      (bars.length >= 2
        ? bars[bars.length - 2].close
        : result.meta?.chartPreviousClose ?? bars[bars.length - 1].close);

    return {
      bars,
      regularMarketPrice: metaPrice,
      previousClose: prevClose,
    };
  } catch {
    return null;
  }
}

export async function fetchNubraChartFresh(
  entry: StockUniverseEntry,
  range: '1y' | '3mo' | '1d',
  interval: '1d' | '1h' | '1m',
  brokerToken?: string,
  historyDays = 365,
): Promise<{ bars: OhlcvBar[]; regularMarketPrice: number | null; previousClose: number } | null> {
  const { authToken, deviceId } = await getNubraCredentialsForSession(brokerToken);
  if (!authToken) return null;
  const exchange = entry.symbol === 'SENSEX' ? 'BSE' : 'NSE';
  const type = entry.isIndex ? 'INDEX' : 'STOCK';
  const today = getIstTradingDate();
  const sessionDate = getLastCompletedWeekdayDate();
  const sessionRange = getIstSessionUtcRange(sessionDate);
  const startDate = interval === '1d'
    ? `${new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(4, 6)) - 1, Number(today.slice(6, 8)) - historyDays)).toISOString().slice(0, 10)}T00:00:00.000Z`
    : interval === '1h'
      ? `${new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()}`
      : sessionRange.start;
  const endDate = interval === '1d' ? `${sessionRange.nextDay}T00:00:00.000Z` : interval === '1m' ? sessionRange.end : new Date().toISOString();
  try {
    const configuredBase = process.env.NUBRA_API_BASE_URL?.trim() || 'https://api.nubra.io';
    let nubraBase = 'https://api.nubra.io';
    try { const parsed = new URL(configuredBase); if (parsed.protocol === 'https:' && ['api.nubra.io', 'uatapi.nubra.io'].includes(parsed.hostname)) nubraBase = parsed.origin; } catch { /* keep production default */ }
    const response = await fetch(`${nubraBase}/charts/timeseries`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, 'x-device-id': deviceId || 'GP-WEB' },
      body: JSON.stringify({ query: [{ exchange, type, values: [entry.symbol], fields: ['open', 'high', 'low', 'close', 'volume'], interval, intraDay: interval === '1m', startDate, endDate }] }),
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const json = await response.json() as { result?: Array<{ values?: Array<Record<string, Record<string, Array<{ ts: number; v: number }>>>> }> };
    const block = json.result?.[0]?.values?.[0]?.[entry.symbol];
    if (!block) return null;
    const map = new Map<number, Partial<OhlcvBar>>();
    for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
      for (const point of block[field] ?? []) {
        const row = map.get(point.ts) ?? { timestamp: point.ts, date: new Date(point.ts).toISOString().slice(0, 10) };
        (row as any)[field] = field === 'volume' ? point.v : point.v / 100;
        map.set(point.ts, row);
      }
    }
    const bars = [...map.values()].filter((b): b is OhlcvBar => typeof b.open === 'number' && typeof b.high === 'number' && typeof b.low === 'number' && typeof b.close === 'number').sort((a, b) => a.timestamp - b.timestamp);
    if (!bars.length) return null;
    const previousClose = bars.length > 1 ? bars[bars.length - 2].close : bars[bars.length - 1].close;
    return { bars, regularMarketPrice: bars[bars.length - 1].close, previousClose };
  } catch {
    return null;
  }
}


async function fetchAndAnalyzeFreshInstrument(
  entry: StockUniverseEntry,
  clock: MarketClockStatus,
  brokerConnected: boolean,
  brokerToken?: string,
  include1h = true,
): Promise<AnalyzedStock | null> {
  if (!brokerConnected) return null;
  const [dailyChart, chart1h, liveQuote] = await Promise.all([
    fetchNubraChartFresh(entry, '1y', '1d', brokerToken),
    include1h && clock.isOpen ? fetchNubraChartFresh(entry, '3mo', '1h', brokerToken) : Promise.resolve(null),
    clock.isOpen ? fetchNubraChartFresh(entry, '1d', '1m', brokerToken) : Promise.resolve(null),
  ]);
  if (!dailyChart || dailyChart.bars.length < 30) return null;
  const liveLtp = clock.isOpen ? liveQuote?.regularMarketPrice ?? null : dailyChart.bars[dailyChart.bars.length - 1].close;
  if (clock.isOpen && (!liveLtp || liveLtp <= 0)) return null;
  return analyzeStockData(entry, dailyChart.bars, liveLtp, dailyChart.previousClose, clock, brokerConnected, chart1h?.bars);
}

async function fetchNubraTickerChart(entry: StockUniverseEntry, brokerToken?: string) {
  const [daily, minute] = await Promise.all([
    fetchNubraChartFresh(entry, '1y', '1d', brokerToken),
    fetchNubraChartFresh(entry, '1d', '1m', brokerToken),
  ]);
  if (!daily) return null;
  return { ...daily, regularMarketPrice: minute?.regularMarketPrice ?? daily.regularMarketPrice };
}

export async function getLiveMarketTicker(brokerToken?: string): Promise<{
  items: TickerItem[];
  clock: MarketClockStatus;
}> {
  const clock = getNSEMarketClockStatus();

  const [niftyRes, bankNiftyRes, finNiftyRes, sensexRes, vixRes, usdInrRes, crudeRes, goldRes, silverRes] =
    await Promise.all([
      brokerToken ? fetchNubraTickerChart(INDEX_BASKET_UNIVERSE[0], brokerToken) : fetchYahooChartFresh('^NSEI', '5d'),
      brokerToken ? fetchNubraTickerChart(INDEX_BASKET_UNIVERSE[1], brokerToken) : fetchYahooChartFresh('^NSEBANK', '5d'),
      brokerToken ? fetchNubraTickerChart(INDEX_BASKET_UNIVERSE[2], brokerToken) : fetchYahooChartFresh('NIFTY_FIN_SERVICE.NS', '5d'),
      brokerToken ? fetchNubraTickerChart(INDEX_BASKET_UNIVERSE[3], brokerToken) : fetchYahooChartFresh('^BSESN', '5d'),
      fetchYahooChartFresh('^INDIAVIX', '5d'),
      fetchYahooChartFresh('INR=X', '5d'),
      fetchYahooChartFresh('CL=F', '5d'),
      fetchYahooChartFresh('GC=F', '5d'),
      fetchYahooChartFresh('SI=F', '5d'),
    ]);

  const usdInr = usdInrRes?.regularMarketPrice ?? 84.4;
  const usdInrPrev = usdInrRes?.previousClose ?? usdInr;

  const buildIndexItem = (
    id: string,
    label: string,
    symbol: string,
    res: { bars: OhlcvBar[]; regularMarketPrice: number | null; previousClose: number } | null,
    unitPrefix = '',
  ): TickerItem | null => {
    if (!res) return null;
    const latestBar = res.bars[res.bars.length - 1];
    const prevBar = res.bars[res.bars.length - 2];
    const price = clock.isOpen && res.regularMarketPrice ? res.regularMarketPrice : latestBar.close;
    const basePrev = res.previousClose || prevBar?.close || price;
    const change = Math.round((price - basePrev) * 100) / 100;
    const changePercent = basePrev > 0 ? Math.round((change / basePrev) * 10000) / 100 : 0;
    return {
      id,
      label,
      symbol,
      price: Math.round(price * 100) / 100,
      change,
      changePercent,
      unitPrefix,
    };
  };

  const items: TickerItem[] = [];

  const nifty = buildIndexItem('nifty', 'Nifty 50 Spot', '^NSEI', niftyRes);
  if (nifty) items.push(nifty);

  const bankNifty = buildIndexItem('banknifty', 'Bank Nifty Spot', '^NSEBANK', bankNiftyRes);
  if (bankNifty) items.push(bankNifty);

  const finNifty = buildIndexItem('finnifty', 'FinNifty Spot', 'NIFTY_FIN_SERVICE', finNiftyRes);
  if (finNifty) items.push(finNifty);

  const sensex = buildIndexItem('sensex', 'Sensex Spot', 'SENSEX', sensexRes);
  if (sensex) items.push(sensex);

  if (crudeRes) {
    const usdPrice = crudeRes.regularMarketPrice ?? crudeRes.bars[crudeRes.bars.length - 1].close;
    const usdPrev = crudeRes.previousClose || usdPrice;
    const inrPrice = Math.round(usdPrice * usdInr * 100) / 100;
    const inrPrev = usdPrev * usdInrPrev;
    const change = Math.round((inrPrice - inrPrev) * 100) / 100;
    const changePercent = inrPrev > 0 ? Math.round((change / inrPrev) * 10000) / 100 : 0;
    items.push({
      id: 'crude',
      label: 'Crude Oil (INR)',
      symbol: 'MCX CRUDE',
      price: inrPrice,
      change,
      changePercent,
      unitPrefix: '₹',
      unitSuffix: '/bbl',
    });
  }

  if (goldRes) {
    const usdPrice = goldRes.regularMarketPrice ?? goldRes.bars[goldRes.bars.length - 1].close;
    const usdPrev = goldRes.previousClose || usdPrice;
    const ozTo10g = 10 / 31.1035;
    const inrPrice = Math.round(usdPrice * usdInr * ozTo10g);
    const inrPrev = usdPrev * usdInrPrev * ozTo10g;
    const change = Math.round(inrPrice - inrPrev);
    const changePercent = inrPrev > 0 ? Math.round((change / inrPrev) * 10000) / 100 : 0;
    items.push({
      id: 'gold',
      label: 'Gold (INR / 10g)',
      symbol: 'MCX GOLD',
      price: inrPrice,
      change,
      changePercent,
      unitPrefix: '₹',
      unitSuffix: '/10g',
    });
  }

  if (silverRes) {
    const usdPrice = silverRes.regularMarketPrice ?? silverRes.bars[silverRes.bars.length - 1].close;
    const usdPrev = silverRes.previousClose || usdPrice;
    const ozTo1Kg = 1000 / 31.1035;
    const inrPrice = Math.round(usdPrice * usdInr * ozTo1Kg);
    const inrPrev = usdPrev * usdInrPrev * ozTo1Kg;
    const change = Math.round(inrPrice - inrPrev);
    const changePercent = inrPrev > 0 ? Math.round((change / inrPrev) * 10000) / 100 : 0;
    items.push({
      id: 'silver',
      label: 'Silver (INR / kg)',
      symbol: 'MCX SILVER',
      price: inrPrice,
      change,
      changePercent,
      unitPrefix: '₹',
      unitSuffix: '/kg',
    });
  }

  const vix = buildIndexItem('vix', 'India VIX', '^INDIAVIX', vixRes);
  if (vix) items.push(vix);

  return { items, clock };
}

export async function getScannedIndexBasket(
  brokerConnected: boolean,
  filters: IndexScanFilters = {},
  brokerToken?: string,
): Promise<{
  allIndices: AnalyzedStock[];
  indices: AnalyzedStock[];
  clock: MarketClockStatus;
}> {
  if (!brokerConnected) {
    return {
      allIndices: [],
      indices: [],
      clock: getNSEMarketClockStatus(),
    };
  }

  const clock = getNSEMarketClockStatus();
  const settled = await Promise.allSettled(
    INDEX_BASKET_UNIVERSE.map((entry) =>
      fetchAndAnalyzeFreshInstrument(entry, clock, brokerConnected, brokerToken),
    ),
  );

  const allIndices: AnalyzedStock[] = [];
  for (const res of settled) {
    if (res.status === 'fulfilled' && res.value) {
      allIndices.push(res.value);
    }
  }

  // Zero-lag intraday-only 1h candle confluence evaluation for Scanner 3 Index Basket
  evaluateAndDispatchConfluenceAlerts('scanner3', allIndices, clock);

  const indices = allIndices.filter((idx) => {
    if (
      filters.marketBiasFilter &&
      filters.marketBiasFilter !== 'ALL' &&
      idx.marketBiasSetup !== filters.marketBiasFilter
    ) {
      return false;
    }
    if (
      filters.twinRangeFilter &&
      filters.twinRangeFilter !== 'ALL' &&
      idx.twinRangeSignal !== filters.twinRangeFilter
    ) {
      return false;
    }
    if (filters.bbwp0To50 && !(idx.bbwp >= 0 && idx.bbwp <= 50)) return false;
    if (filters.pvoPositive && !idx.pvoPositive) return false;
    return true;
  });

  return { allIndices, indices, clock };
}

export async function getScannedUniverse(
  brokerConnected: boolean,
  filters: UniverseScanFilters = {},
  brokerToken?: string,
): Promise<{
  stocks: AnalyzedStock[];
  clock: MarketClockStatus;
  totalUniverseTracked: number;
  loadedCount: number;
  confluenceMatchedCount: number;
}> {
  if (!brokerConnected) {
    return {
      stocks: [],
      clock: getNSEMarketClockStatus(),
      totalUniverseTracked: NIFTY_500_FNO_UNIVERSE.length,
      loadedCount: 0,
      confluenceMatchedCount: 0,
    };
  }

  const clock = getNSEMarketClockStatus();
  const query = filters.q?.trim().toUpperCase();
  const targetEntries = query
    ? NIFTY_500_FNO_UNIVERSE.filter(
        (s) => s.symbol.includes(query) || s.companyName.toUpperCase().includes(query),
      )
    : NIFTY_500_FNO_UNIVERSE;

  const include1h = !filters.skipIntraday;
  const batchSize = 5;
  const freshAnalyzed: AnalyzedStock[] = [];

  for (let i = 0; i < targetEntries.length; i += batchSize) {
    const batch = targetEntries.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((entry) =>
        fetchAndAnalyzeFreshInstrument(entry, clock, brokerConnected, brokerToken, include1h),
      ),
    );
    for (const res of settled) {
      if (res.status === 'fulfilled' && res.value) {
        freshAnalyzed.push(res.value);
      }
    }
  }

  // Zero-lag intraday-only 1h candle confluence evaluation for Scanner 1 Universe
  if (include1h) {
    evaluateAndDispatchConfluenceAlerts('scanner1', freshAnalyzed, clock);
  }
  const confluenceMatchedCount = freshAnalyzed.filter((s) => s.confluenceMatched).length;

  const filtered = freshAnalyzed.filter((s) => {
    if (typeof filters.bbwpMax === 'number' && !(s.bbwp >= 0 && s.bbwp <= filters.bbwpMax)) {
      return false;
    }
    if (filters.pvoPositive && !s.pvoPositive) {
      return false;
    }
    if (filters.emaFilter === 'gt' && !(s.ema10 > s.ema20)) return false;
    if (filters.emaFilter === 'lt' && !(s.ema10 < s.ema20)) return false;

    if (filters.setupFilter === 'bounce') {
      if (s.marketBiasSetup !== 'Bullish Bounce') return false;
    } else if (filters.setupFilter === 'dip') {
      if (s.marketBiasSetup !== 'Bearish Dip') return false;
    } else if (filters.setupFilter === 'confluence') {
      if (!s.confluenceMatched) return false;
    } else if (filters.setupFilter === 'all-setups') {
      if (s.marketBiasSetup === 'Neutral' && s.twinRangeSignal === 'HOLD') return false;
    }

    return true;
  });

  return {
    stocks: filtered,
    clock,
    totalUniverseTracked: NIFTY_500_FNO_UNIVERSE.length,
    loadedCount: freshAnalyzed.length,
    confluenceMatchedCount,
  };
}

export async function scanCustomNseSymbol(
  rawSymbol: string,
  brokerConnected: boolean,
  brokerToken?: string,
): Promise<AnalyzedStock | null> {
  if (!brokerConnected) return null;

  const cleaned = rawSymbol.trim().toUpperCase().replace(/\.NS$/, '');
  if (!/^[A-Z0-9&-]{1,25}$/.test(cleaned)) {
    throw new Error('Invalid NSE stock symbol format.');
  }

  const existingEntry = NIFTY_500_FNO_UNIVERSE.find((s) => s.symbol === cleaned) ?? {
    symbol: cleaned,
    companyName: `${cleaned} (NSE)`,
    sector: 'NSE Equity',
    isFno: false,
    isNifty500: true,
  };

  const clock = getNSEMarketClockStatus();
  const analyzed = await fetchAndAnalyzeFreshInstrument(
    existingEntry,
    clock,
    brokerConnected,
    brokerToken,
  );
  if (analyzed) {
    evaluateAndDispatchConfluenceAlerts('scanner1', [analyzed], clock);
  }
  return analyzed;
}

export async function getScannedSuperPivots(
  brokerConnected: boolean,
  filters: SuperPivotScanFilters = {},
  brokerToken?: string,
): Promise<{
  items: AnalyzedStock[];
  clock: MarketClockStatus;
  totalUniverseTracked: number;
  loadedCount: number;
  trendCounts: Record<SuperPivotTrend, number>;
}> {
  const fullUniverse = [...INDEX_BASKET_UNIVERSE, ...NIFTY_500_FNO_UNIVERSE];
  const emptyCounts: Record<SuperPivotTrend, number> = {
    'Strong Uptrend': 0,
    Uptrend: 0,
    Sideways: 0,
    Downtrend: 0,
    'Severe Downtrend': 0,
  };

  if (!brokerConnected) {
    return {
      items: [],
      clock: getNSEMarketClockStatus(),
      totalUniverseTracked: fullUniverse.length,
      loadedCount: 0,
      trendCounts: emptyCounts,
    };
  }

  const clock = getNSEMarketClockStatus();
  const query = filters.q?.trim().toUpperCase();
  const baseUniverse =
    filters.segmentFilter === 'indices'
      ? INDEX_BASKET_UNIVERSE
      : filters.segmentFilter === 'stocks'
        ? NIFTY_500_FNO_UNIVERSE
        : fullUniverse;

  const targetEntries = query
    ? baseUniverse.filter(
        (s) => s.symbol.includes(query) || s.companyName.toUpperCase().includes(query),
      )
    : baseUniverse;

  const batchSize = 5;
  const freshAnalyzed: AnalyzedStock[] = [];

  for (let i = 0; i < targetEntries.length; i += batchSize) {
    const batch = targetEntries.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((entry) =>
        fetchAndAnalyzeFreshInstrument(entry, clock, brokerConnected, brokerToken, false),
      ),
    );
    for (const res of settled) {
      if (res.status === 'fulfilled' && res.value) {
        freshAnalyzed.push(res.value);
      }
    }
  }

  const trendCounts: Record<SuperPivotTrend, number> = { ...emptyCounts };
  for (const item of freshAnalyzed) {
    trendCounts[item.superPivots.trend] += 1;
  }

  const filtered =
    filters.trendFilter && filters.trendFilter !== 'ALL'
      ? freshAnalyzed.filter((item) => item.superPivots.trend === filters.trendFilter)
      : freshAnalyzed;

  const trendRank: Record<SuperPivotTrend, number> = {
    'Strong Uptrend': 0,
    Uptrend: 1,
    'Severe Downtrend': 2,
    Downtrend: 3,
    Sideways: 4,
  };

  filtered.sort((a, b) => {
    // Keep indices visible at top within the same rank, then order by classification strength
    const rankDiff = trendRank[a.superPivots.trend] - trendRank[b.superPivots.trend];
    if (rankDiff !== 0) return rankDiff;
    if (Boolean(a.isIndex) !== Boolean(b.isIndex)) return a.isIndex ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });

  return {
    items: filtered,
    clock,
    totalUniverseTracked: fullUniverse.length,
    loadedCount: freshAnalyzed.length,
    trendCounts,
  };
}
