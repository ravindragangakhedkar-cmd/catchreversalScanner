import { computeMarketBias, computeTwinRangeFilter } from '../shared/indicators.ts';
import { INDEX_BASKET_UNIVERSE, NIFTY_500_FNO_UNIVERSE, type StockUniverseEntry } from '../shared/nifty500Universe.ts';
import { fetchNubraChartFresh } from './marketDataService.ts';

type Bar = { date: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number };
type Row = {
  symbol: string; name: string; price: number;
  weeklyTrend: 'Bullish' | 'Bearish'; dailyTrend: 'Bullish' | 'Bearish';
  jointStatus: 'Aligned' | 'Divergent'; twinRangeStatus: 'Long' | 'Short' | 'No fresh signal';
  rsi: number; adx: number; chop: number; chartUrl: string;
};

function round2(n: number) { return Math.round(n * 100) / 100; }
function weeklyBars(daily: Bar[]): Bar[] {
  const groups = new Map<string, Bar[]>();
  for (const bar of daily) {
    // Group by ISO week using the exchange candle date (NSE timezone date).
    const d = new Date(bar.date + 'T12:00:00Z');
    const weekday = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - weekday);
    const key = d.toISOString().slice(0, 10);
    const list = groups.get(key) ?? [];
    list.push(bar);
    groups.set(key, list);
  }
  return [...groups.values()].map((bars) => ({
    date: bars[0].date, timestamp: bars[0].timestamp,
    open: bars[0].open, high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)), close: bars[bars.length - 1].close,
    volume: bars.reduce((sum, b) => sum + b.volume, 0),
  }));
}
function biasTrend(bars: Bar[], period: number, smoothing: number): 'Bullish' | 'Bearish' {
  const mb = computeMarketBias(bars, { period, smoothing, oscPeriod: 7 });
  const i = bars.length - 1;
  return mb.mbClose[i] >= mb.mbOpen[i] ? 'Bullish' : 'Bearish';
}
function rsi(closes: number[], period = 14): number {
  if (closes.length <= period) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0);
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}
function adx(bars: Bar[], period = 14): number {
  if (bars.length < period * 2 + 1) return 0;
  const tr: number[] = [], plus: number[] = [], minus: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i], up = cur.high - prev.high, down = prev.low - cur.low;
    tr.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
    plus.push(up > down && up > 0 ? up : 0); minus.push(down > up && down > 0 ? down : 0);
  }
  let smTr = tr.slice(0, period).reduce((a,b)=>a+b,0);
  let smPlus = plus.slice(0, period).reduce((a,b)=>a+b,0);
  let smMinus = minus.slice(0, period).reduce((a,b)=>a+b,0);
  const dx: number[] = [];
  for (let i = period; i <= tr.length; i++) {
    const p = smTr ? smPlus / smTr * 100 : 0, m = smTr ? smMinus / smTr * 100 : 0;
    dx.push(p + m ? Math.abs(p - m) / (p + m) * 100 : 0);
    if (i < tr.length) { smTr += tr[i] - smTr / period; smPlus += plus[i] - smPlus / period; smMinus += minus[i] - smMinus / period; }
  }
  let value = dx.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < dx.length; i++) value = (value * (period - 1) + dx[i]) / period;
  return value;
}
function choppiness(bars: Bar[], period = 10): number {
  if (bars.length < period + 1) return 50;
  let sumTr = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const cur = bars[i], prev = bars[i - 1];
    sumTr += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  const window = bars.slice(-period), highest = Math.max(...window.map(b=>b.high)), lowest = Math.min(...window.map(b=>b.low));
  return highest > lowest && sumTr > 0 ? 100 * Math.log10(sumTr / (highest - lowest)) / Math.log10(period) : 50;
}
function chartUrl(entry: StockUniverseEntry) {
  const symbol = entry.symbol === 'SENSEX' ? 'BSE:SENSEX' : `NSE:${entry.symbol}`;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
}

export async function getBiasMultiTimeframe(brokerToken?: string) {
  // Match the proven production scanner's one-year Nubra daily-history request. Nubra
  // rejects oversized 900-day requests; use a weekly Market Bias period that fits this history.
  const universe = [...NIFTY_500_FNO_UNIVERSE.filter((entry) => entry.isFno), ...INDEX_BASKET_UNIVERSE];
  const results: Row[] = [];
  const failures: Array<{ symbol: string; reason: string }> = [];
  const batchSize = 5;
  for (let start = 0; start < universe.length; start += batchSize) {
    const batch = universe.slice(start, start + batchSize);
    const settled = await Promise.allSettled(batch.map(async (entry) => {
      const chart = await fetchNubraChartFresh(entry, '1y', '1d', brokerToken, 365);
      if (!chart?.bars?.length) throw new Error('Nubra returned no daily candles');
      const daily = chart.bars as Bar[];
      const weekly = weeklyBars(daily);
      if (daily.length < 60) throw new Error(`Insufficient daily candles (${daily.length})`);
      if (weekly.length < 40) throw new Error(`Insufficient weekly candles for Market Bias period 40 (${weekly.length})`);
      const weeklyTrend = biasTrend(weekly, 40, 20);
      const dailyTrend = biasTrend(daily, 50, 20);
      const twin = computeTwinRangeFilter(daily.map((b) => b.close));
      const last = daily.length - 1;
      const fresh = twin.signals[last];
      // Only publish a Twin Range entry when it agrees with the Daily Market Bias direction.
      const twinRangeStatus = fresh === 'BUY' && dailyTrend === 'Bullish'
        ? 'Long'
        : fresh === 'SELL' && dailyTrend === 'Bearish'
          ? 'Short'
          : 'No fresh signal';
      const closes = daily.map((b) => b.close);
      return {
        symbol: entry.symbol, name: entry.companyName,
        price: round2(chart.regularMarketPrice && chart.regularMarketPrice > 0 ? chart.regularMarketPrice : daily[last].close),
        weeklyTrend, dailyTrend,
        jointStatus: weeklyTrend === dailyTrend ? 'Aligned' as const : 'Divergent' as const,
        twinRangeStatus, rsi: round2(rsi(closes)), adx: round2(adx(daily)), chop: round2(choppiness(daily)),
        chartUrl: chartUrl(entry),
      };
    }));
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') results.push(result.value);
      else failures.push({ symbol: batch[i].symbol, reason: result.reason instanceof Error ? result.reason.message : 'Unknown Nubra data error' });
    });
    if (start + batchSize < universe.length) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return {
    items: results,
    universeCount: universe.length,
    loadedCount: results.length,
    failedCount: failures.length,
    failures: failures.slice(0, 30),
    settings: {
      weekly: { period: 40, smoothing: 20, oscillator: 7 },
      daily: { period: 50, smoothing: 20, oscillator: 7 },
      twinRange: { fastPeriod: 27, fastMultiplier: 1.6, slowPeriod: 55, slowMultiplier: 2.0 },
    },
  };
}
