import { getNSEMarketClockStatus, computeEMA, computeBBWPSeries } from '../shared/indicators.ts';
import { INDEX_BASKET_UNIVERSE, NIFTY_500_FNO_UNIVERSE, type StockUniverseEntry } from '../shared/nifty500Universe.ts';
import { getNubraCredentialsForSession } from './brokerService.ts';
import { getIstSessionUtcRange, getIstTradingDate, getLastCompletedWeekdayDate, getNextMonthlyExpiry } from './marketDates.ts';

const NUBRA_BASE = (() => { const raw = process.env.NUBRA_API_BASE_URL?.trim() || 'https://api.nubra.io'; try { const u = new URL(raw); return ['api.nubra.io','uatapi.nubra.io'].includes(u.hostname) && u.protocol === 'https:' ? u.origin : 'https://api.nubra.io'; } catch { return 'https://api.nubra.io'; } })();
const BATCH_SIZE = 5;
type Tick = { ts: number; v: number };
type Bar = { ts: number; open: number; high: number; low: number; close: number; volume: number };
type Contract = { symbol?: string; sp?: number; ltp?: number; oi?: number; prev_oi?: number; ltpchg?: number };
type Chain = { chain?: { cp?: number; atm?: number; expiry?: string; all_expiries?: string[]; ce?: Contract[]; pe?: Contract[]; underlying_instrument?: { ltp?: number; prev_close?: number } } };
export type CatchReversalRow = {
  symbol: string; name: string; isIndex: boolean; underlying: number; reversal: 'Rejected from resistance' | 'Bounce off from Support' | 'Near Daily Support · Watch' | 'Near Daily Resistance · Watch'; level: string; distancePercent: number;
  callChange: number | null; putChange: number | null; emaCross: 'Done' | 'Pending'; bbwp: number; bbwpStatus: string;
  rsi: number; rsiDelta: number; adx: number; adxDelta: number; chop: number; chopDelta: number;
  chartUrl: string; geminiAnalysis: string;
};

function headers(token?: string, device?: string) {
  const h: Record<string,string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (device) h['x-device-id'] = device;
  return h;
}
function chunks<T>(xs:T[], n:number):T[][] { const out:T[][]=[]; for(let i=0;i<xs.length;i+=n) out.push(xs.slice(i,i+n)); return out; }
function num(v: unknown): number | null { const n=Number(v); return Number.isFinite(n) ? n : null; }
function pct(a:number,b:number):number|null { return b>0 ? ((a-b)/b)*100 : null; }
function pivots(b:Bar) { const pp=(b.high+b.low+b.close)/3; return {PP:pp,S1:2*pp-b.high,S2:pp-(b.high-b.low),R1:2*pp-b.low,R2:pp+(b.high-b.low)}; }
function rsi(xs:number[],p=14):number {
  if(xs.length<=p)return 50;
  let gain=0,loss=0;
  for(let i=1;i<=p;i++){const d=xs[i]-xs[i-1];gain+=Math.max(d,0);loss+=Math.max(-d,0);}
  let avgGain=gain/p,avgLoss=loss/p;
  for(let i=p+1;i<xs.length;i++){const d=xs[i]-xs[i-1];avgGain=(avgGain*(p-1)+Math.max(d,0))/p;avgLoss=(avgLoss*(p-1)+Math.max(-d,0))/p;}
  if(avgLoss===0)return 100;
  const rs=avgGain/avgLoss;return 100-100/(1+rs);
}
function adxApprox(bars:Bar[],p=14):number {
  if(bars.length<2*p+1)return 0;
  const tr:number[]=[],plus:number[]=[],minus:number[]=[];
  for(let i=1;i<bars.length;i++){const a=bars[i-1],b=bars[i];const up=b.high-a.high,down=a.low-b.low;tr.push(Math.max(b.high-b.low,Math.abs(b.high-a.close),Math.abs(b.low-a.close)));plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);}
  let trS=tr.slice(0,p).reduce((a,b)=>a+b,0),pS=plus.slice(0,p).reduce((a,b)=>a+b,0),mS=minus.slice(0,p).reduce((a,b)=>a+b,0);
  const dx:number[]=[];
  const addDx=()=>{const pdi=trS?pS/trS*100:0,mdi=trS?mS/trS*100:0;dx.push(pdi+mdi?Math.abs(pdi-mdi)/(pdi+mdi)*100:0);};
  addDx();
  for(let i=p;i<tr.length;i++){trS=trS-trS/p+tr[i];pS=pS-pS/p+plus[i];mS=mS-mS/p+minus[i];addDx();}
  if(dx.length<p)return dx.at(-1)??0;
  let adx=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<dx.length;i++)adx=(adx*(p-1)+dx[i])/p;
  return adx;
}
function chopApprox(bars:Bar[],p=10):number {
  if(bars.length<p+1)return 50;
  const start=bars.length-p;let trSum=0;
  for(let i=start;i<bars.length;i++){const b=bars[i],prev=bars[i-1];trSum+=Math.max(b.high-b.low,Math.abs(b.high-prev.close),Math.abs(b.low-prev.close));}
  const w=bars.slice(-p),hi=Math.max(...w.map(x=>x.high)),lo=Math.min(...w.map(x=>x.low));
  return hi>lo&&trSum>0?100*Math.log10(trSum/(hi-lo))/Math.log10(p):50;
}
function toEpochMilliseconds(raw:unknown):number|null {
  if (raw === null || raw === undefined || raw === '') return null;
  let value:number;
  if (typeof raw === 'number') value=raw;
  else {
    const text=String(raw).trim();
    const numeric=Number(text);
    value=Number.isFinite(numeric) && text!=='' ? numeric : Date.parse(text);
  }
  if (!Number.isFinite(value) || value<=0) return null;
  // Nubra payloads may express candle time as seconds, milliseconds,
  // microseconds, nanoseconds, or an ISO-8601 date string.
  if (value >= 1e17) value=Math.floor(value/1e6);
  else if (value >= 1e14) value=Math.floor(value/1e3);
  else if (value < 1e11) value=Math.floor(value*1000);
  else value=Math.floor(value);
  return Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : null;
}
function toIstDateString(timestamp:number):string {
  const date=new Date(timestamp);
  if (!Number.isFinite(timestamp) || !Number.isFinite(date.getTime())) throw new Error(`Invalid Nubra candle timestamp: ${String(timestamp)}`);
  const parts=new Intl.DateTimeFormat('en-GB',{
    timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(date);
  const part=(type:string)=>parts.find(p=>p.type===type)?.value;
  const year=part('year'),month=part('month'),day=part('day');
  if(!year||!month||!day) throw new Error('Could not format Nubra candle date in Asia/Kolkata.');
  return `${year}-${month}-${day}`;
}
function extractBars(payload:any, symbol:string):Bar[] {
  const root=payload?.result?.find?.((r:any)=>r?.values?.some?.((v:any)=>v?.[symbol])) ?? payload?.result?.[0];
  const values=root?.values?.find?.((v:any)=>v?.[symbol])?.[symbol] ?? root?.values?.[0]?.[symbol];
  const get=(key:string):any[]=>Array.isArray(values?.[key])?values[key]:[];
  const map=new Map<number,Partial<Bar>>();
  for(const key of ['open','high','low','close','volume']) {
    for(const point of get(key)) {
      const ts=toEpochMilliseconds(point?.ts ?? point?.timestamp ?? point?.time ?? point?.date);
      const rawValue=Number(point?.v ?? point?.value);
      if(ts===null || !Number.isFinite(rawValue)) continue;
      const row=map.get(ts)??{ts};
      (row as any)[key]=rawValue/100;
      map.set(ts,row);
    }
  }
  return [...map.values()]
    .filter((b:any)=>Number.isFinite(b.ts)&&Number.isFinite(b.open)&&Number.isFinite(b.high)&&Number.isFinite(b.low)&&Number.isFinite(b.close)&&b.open>0&&b.high>0&&b.low>0&&b.close>0)
    .map((b:any)=>({ts:b.ts,open:b.open,high:b.high,low:b.low,close:b.close,volume:Number.isFinite(b.volume)?b.volume:0}))
    .sort((a,b)=>a.ts-b.ts);
}
async function postTimeseries(query:any[], _authHeaders:Record<string,string>):Promise<any> {
  const serviceUrl=process.env.NUBRA_PYTHON_API_URL?.trim();
  const serviceKey=process.env.NUBRA_PYTHON_API_KEY?.trim();
  if(!serviceUrl||!serviceKey) throw new Error('Nubra Python SDK service is not configured. Set NUBRA_PYTHON_API_URL and NUBRA_PYTHON_API_KEY in Vercel.');
  const instruments=query.flatMap((q:any)=>Array.isArray(q.values)?q.values.map((symbol:string)=>({
    symbol,exchange:q.exchange==='BSE'?'BSE':'NSE',instrument_type:q.type==='INDEX'?'INDEX':'STOCK'
  })):[]);
  if(!instruments.length) throw new Error('No instruments were supplied to the Nubra Python SDK service.');
  if(instruments.length>5) throw new Error('Nubra Python SDK requests are limited to five instruments per batch.');
  const first=query[0];
  const response=await fetch(`${serviceUrl.replace(/\\/$/,'')}/v1/historical`,{
    method:'POST',
    headers:{'Content-Type':'application/json','x-service-key':serviceKey},
    body:JSON.stringify({instruments,start_date:first.startDate,end_date:first.endDate,interval:first.interval??'1d'}),
    cache:'no-store',signal:AbortSignal.timeout(60000)
  });
  if(!response.ok){
    const detail=(await response.text().catch(()=>'' )).slice(0,500);
    throw new Error(`Nubra Python SDK service HTTP ${response.status}${detail?': '+detail:''}`);
  }
  const payload=await response.json() as {items?:Record<string,Array<{timestamp:number;open:number;high:number;low:number;close:number;volume:number}>>;failures?:Record<string,string>};
  const values:any[]=[];
  for(const instrument of instruments){
    const symbol=instrument.symbol.toUpperCase();
    const bars=payload.items?.[symbol]??[];
    if(!bars.length) continue;
    const series=(field:'open'|'high'|'low'|'close'|'volume')=>bars.map(b=>({ts:b.timestamp,v:field==='volume'?b.volume:b[field]*100}));
    values.push({[symbol]:{open:series('open'),high:series('high'),low:series('low'),close:series('close'),volume:series('volume')}});
  }
  if(!values.length){
    const details=Object.entries(payload.failures??{}).map(([symbol,reason])=>`${symbol}: ${reason}`).join(' | ');
    throw new Error(`Nubra Python SDK returned no usable candles.${details?' '+details:''}`);
  }
  return {result:[{values}]};
}
async function getChain(entry:StockUniverseEntry, h:Record<string,string>):Promise<any|null>{
  const exchange=entry.symbol==='SENSEX'?'BSE':'NSE';
  const base=`${NUBRA_BASE}/optionchains/${encodeURIComponent(entry.symbol)}?exchange=${exchange}`;
  const first=await fetch(base,{headers:h,cache:'no-store',signal:AbortSignal.timeout(12000)});
  if(!first.ok)return null; const initial=await first.json() as Chain; if(!initial.chain)return null;
  const expiry=getNextMonthlyExpiry(initial.chain.all_expiries??[]);
  if(initial.chain.expiry===expiry)return initial.chain;
  const selected=await fetch(`${base}&expiry=${expiry}`,{headers:h,cache:'no-store',signal:AbortSignal.timeout(12000)});
  if(!selected.ok)return null; const result=await selected.json() as Chain; return result.chain??null;
}
/**
 * Daily-level watchlist deliberately does not depend on option-chain availability.
 * It uses the latest completed daily close and the prior completed candle's classic pivots.
 */
/** Shared daily OHLCV loader for scanners. Uses the exact multi-symbol Nubra request
 * and extractBars parser already used by Catch Reversals, avoiding a second REST dialect.
 */
export async function fetchDailyBarsForBias(entries:StockUniverseEntry[], brokerToken?:string):Promise<Map<string,Bar[]>> {
  // Historical data is fetched by the separately hosted official Nubra Python SDK service.
  // Browser OTP tokens are deliberately not passed to the Python SDK process.
  const h:Record<string,string>={};
  const endDate=`${getIstSessionUtcRange(getLastCompletedWeekdayDate()).nextDay}T00:00:00.000Z`;
  const startDate=new Date(Date.now()-400*24*60*60*1000).toISOString();
  const output=new Map<string,Bar[]>();
  for(const group of chunks(entries,BATCH_SIZE)){
    const query=group.map(entry=>({
      exchange:entry.symbol==='SENSEX'?'BSE':'NSE',
      type:entry.isIndex?'INDEX':'STOCK',
      values:[entry.symbol],
      fields:['open','high','low','close','volume'],
      interval:'1d',intraDay:false,startDate,endDate
    }));
    let payload:any=null;
    try {
      payload=await postTimeseries(query,h);
    } catch (batchError) {
      const message=batchError instanceof Error ? batchError.message : String(batchError);
      // A single unsupported ticker must not discard the other four valid instruments.
      // Keep authentication/server failures visible; isolate only Nubra's ticker lookup error.
      if (!/ticker not found/i.test(message)) throw batchError;
      for (const entry of group) {
        const singleQuery=[{
          exchange:entry.symbol==='SENSEX'?'BSE':'NSE',
          type:entry.isIndex?'INDEX':'STOCK',
          values:[entry.symbol],
          fields:['open','high','low','close','volume'],
          interval:'1d',intraDay:false,startDate,endDate
        }];
        try {
          const singlePayload=await postTimeseries(singleQuery,h);
          const bars=extractBars(singlePayload,entry.symbol);
          if(bars.length) output.set(entry.symbol,bars.map(b=>({
            date:toIstDateString(b.ts),
            timestamp:b.ts,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume
          })));
        } catch (singleError) {
          const detail=singleError instanceof Error ? singleError.message : String(singleError);
          if (/HTTP 440|HTTP 401|HTTP 403|session expired|authentication/i.test(detail)) throw singleError;
          console.warn(`[Bias MTF] Nubra skipped unsupported ticker ${entry.symbol}: ${detail}`);
        }
      }
      continue;
    }
    for(const entry of group){
      const bars=extractBars(payload,entry.symbol);
      if(bars.length) output.set(entry.symbol,bars.map(b=>({
        date:toIstDateString(b.ts),
        timestamp:b.ts,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume
      })));
    }
  }
  return output;
}

async function fetchDailyWatchlist(entries:StockUniverseEntry[], h:Record<string,string>, historyStart:string, historyEnd:string, sessionIsoDate:string):Promise<CatchReversalRow[]> {
  const out:CatchReversalRow[]=[];
  for(const group of chunks(entries,BATCH_SIZE)){
    const query=group.map(entry=>({
      exchange:entry.symbol==='SENSEX'?'BSE':'NSE',
      type:entry.isIndex?'INDEX':'STOCK',
      values:[entry.symbol],
      fields:['open','high','low','close','volume'],
      interval:'1d',intraDay:false,startDate:historyStart,endDate:historyEnd
    }));
    let data:any;
    try{data=await postTimeseries(query,h);}catch{continue;}
    for(const entry of group){
      const bars=extractBars(data,entry.symbol)
        .filter(b=>toIstDateString(b.ts)<=sessionIsoDate);
      if(bars.length<2)continue;
      const latest=bars.at(-1)!;
      const previous=bars.at(-2)!;
      const spot=latest.close;
      if(!(spot>0))continue;
      const levels=pivots(previous);
      const nearest=Object.entries(levels)
        .map(([level,value])=>({level,value,distance:Math.abs(spot-value)/spot}))
        .sort((a,b)=>a.distance-b.distance)[0];
      if(!nearest||nearest.distance>0.0125)continue;
      const support=nearest.value<spot||(nearest.level==='PP'&&spot>=nearest.value);
      const closes=bars.map(b=>b.close);
      const bb=computeBBWPSeries(closes);
      const bbwp=bb.at(-1)??0;
      const bbwpSma=bb.slice(-9).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(9,bb.length));
      const e9=computeEMA(closes,9),e14=computeEMA(closes,14);
      const liveRsi=rsi(closes);
      const previousRsi=rsi(closes.slice(0,-1));
      const adx=adxApprox(bars),previousAdx=adxApprox(bars.slice(0,-1));
      const chop=chopApprox(bars),previousChop=chopApprox(bars.slice(0,-1));
      out.push({
        symbol:entry.symbol,name:entry.companyName,isIndex:Boolean(entry.isIndex),underlying:spot,
        reversal:support?'Near Daily Support · Watch':'Near Daily Resistance · Watch',
        level:nearest.level,distancePercent:nearest.distance*100,
        callChange:null,putChange:null,
        emaCross:support?(e9.at(-1)!>e14.at(-1)!?'Done':'Pending'):(e9.at(-1)!<e14.at(-1)!?'Done':'Pending'),
        bbwp,bbwpStatus:bbwp<bbwpSma?'Below 9 SMA · Fading':Math.abs(bbwp-bbwpSma)<=1?'At 9 SMA · Fading':'Fading expansion',
        rsi:liveRsi,rsiDelta:liveRsi-previousRsi,adx,adxDelta:adx-previousAdx,chop,chopDelta:chop-previousChop,
        chartUrl:`https://www.tradingview.com/chart/?symbol=${entry.symbol==='SENSEX'?'BSE:SENSEX':`NSE:${entry.symbol}`}`,
        geminiAnalysis:'Awaiting Gemini analysis'
      });
    }
  }
  return out;
}

async function fetchGroup(entries:StockUniverseEntry[], h:Record<string,string>, marketOpen:boolean, sessionRange:{start:string;end:string;nextDay:string}, historyStart:string, historyEnd:string, sessionIsoDate:string):Promise<CatchReversalRow[]> {
  // Exactly five instruments or fewer are requested concurrently in each group.
  const chains=await Promise.all(entries.map(async e=>({entry:e,chain:await getChain(e,h)})));
  const optionRefs=new Map<string,{entry:StockUniverseEntry;call:Contract;put:Contract;spot:number;strike:number}>();
  for(const {entry,chain} of chains){ if(!chain)continue; const spot=((marketOpen ? num(chain.cp)??num(chain.underlying_instrument?.ltp) : num(chain.underlying_instrument?.prev_close)??num(chain.cp))??0)/100; if(!spot)continue;
    const strikeTarget=num(chain.atm)??spot*100;
    const nearest=(arr:Contract[])=>[...arr].sort((a,b)=>Math.abs((a.sp??0)-strikeTarget)-Math.abs((b.sp??0)-strikeTarget)).find(x=>x.symbol&&(num(x.ltp)??0)>0);
    const ce=nearest(chain.ce??[]), pe=nearest(chain.pe??[]); if(!ce?.symbol||!pe?.symbol)continue;
    const strike=(num(ce.sp)??strikeTarget)/100; const id=entry.symbol;
    optionRefs.set(id,{entry,call:ce,put:pe,spot,strike});
  }
  const rows:CatchReversalRow[]=[];
  for(const batch of chunks([...optionRefs.values()],BATCH_SIZE)){
    const q=batch.flatMap(x=>[
      {exchange:x.entry.symbol==='SENSEX'?'BSE':'NSE',type:'OPT',values:[x.call.symbol,x.put.symbol],fields:['open','close','cumulative_oi'],interval:'1m',intraDay:true,startDate:sessionRange.start,endDate:sessionRange.end},
      {exchange:x.entry.symbol==='SENSEX'?'BSE':'NSE',type:x.entry.isIndex?'INDEX':'STOCK',values:[x.entry.symbol],fields:['open','high','low','close','volume'],interval:'1d',intraDay:false,startDate:historyStart,endDate:historyEnd}
    ]);
    let data:any; try{data=await postTimeseries(q,h);}catch{continue;}
    for(const item of batch){
      const callSym=item.call.symbol!,putSym=item.put.symbol!;
      const findValues=(s:string)=>{for(const res of data?.result??[])for(const v of res?.values??[])if(v?.[s])return v[s];return null;};
      const cv=findValues(callSym),pv=findValues(putSym);
      const pctFromOpen=(v:any)=>{const opens=v?.open??[],closes=v?.close??[];const first=num(opens[0]?.v),last=num(closes.at(-1)?.v);return first&&last?pct(last/100,first/100):null;};
      const callChange=pctFromOpen(cv),putChange=pctFromOpen(pv);
      const bars=extractBars(data,item.entry.symbol); if(bars.length<30)continue;
      const completed=bars.filter(b=>toIstDateString(b.ts)<=sessionIsoDate); if(completed.length<25)continue;
      const prev=completed.at(-2)!; const today=completed.at(-1)!; const lv=pivots(prev);
      const spot=item.spot;
      // Daily support/resistance levels are calculated from the previous completed daily candle.
      // A 1.25% distance is the near-term watchlist band; confirmed reversals keep the original 0.60% band.
      const nearestLevel=Object.entries(lv)
        .map(([k,v])=>({k,v,dist:Math.abs(spot-v)/spot}))
        .sort((a,b)=>a.dist-b.dist)[0];
      if(!nearestLevel||nearestLevel.dist>0.0125)continue;
      const support=nearestLevel.v<spot||(nearestLevel.k==='PP'&&spot>=nearestLevel.v);
      const reversal=support?spot>=nearestLevel.v&&spot>=today.open:spot<=nearestLevel.v&&spot<=today.open;
      const closes=completed.map(b=>b.close); const liveCloses=[...closes.slice(0,-1),spot],startCloses=[...closes.slice(0,-1),today.open];
      const bb=computeBBWPSeries(liveCloses); const bbwp=bb.at(-1)??0; const bbwpPrev=bb.at(-2)??bbwp; const bbwpSma=bb.slice(-9).reduce((a,b)=>a+b,0)/Math.min(9,bb.length);
      const e9=computeEMA(liveCloses,9),e14=computeEMA(liveCloses,14); const emaCross=support?(e9.at(-1)!>e14.at(-1)!?'Done':'Pending'):(e9.at(-1)!<e14.at(-1)!?'Done':'Pending');
      const rsiNow=rsi(liveCloses),rsiStart=rsi(startCloses); const liveBars=[...completed.slice(0,-1),{...today,close:spot}],startBars=[...completed.slice(0,-1),{...today,close:today.open}]; const adxNow=adxApprox(liveBars),adxStart=adxApprox(startBars); const chopNow=chopApprox(liveBars),chopStart=chopApprox(startBars);
      const callOiStart=num(cv?.cumulative_oi?.[0]?.v),callOiEnd=num(cv?.cumulative_oi?.at(-1)?.v),putOiStart=num(pv?.cumulative_oi?.[0]?.v),putOiEnd=num(pv?.cumulative_oi?.at(-1)?.v);
      const callOiDrop=callOiStart&&callOiEnd?pct(callOiEnd,callOiStart):null,putOiDrop=putOiStart&&putOiEnd?pct(putOiEnd,putOiStart):null;
      const unwind=support?(putChange!==null&&putChange< -0.1&&putOiDrop!==null&&putOiDrop<=-0.1):(callChange!==null&&callChange< -0.1&&callOiDrop!==null&&callOiDrop<=-0.1);
      const confirmedReversal=nearestLevel.dist<=0.006&&reversal&&bbwp>=75&&bbwp<=95&&bbwp<bbwpPrev&&unwind;
      const watchSupport=support;
      const reversalLabel=confirmedReversal
        ? (support?'Bounce off from Support':'Rejected from resistance')
        : (watchSupport?'Near Daily Support · Watch':'Near Daily Resistance · Watch');
      const distancePercent=nearestLevel.dist*100;
      rows.push({symbol:item.entry.symbol,name:item.entry.companyName,isIndex:Boolean(item.entry.isIndex),underlying:spot,reversal:reversalLabel,level:nearestLevel.k,distancePercent,callChange,putChange,emaCross,bbwp,bbwpStatus:bbwp<bbwpSma?'Below 9 SMA · Fading':Math.abs(bbwp-bbwpSma)<=1?'At 9 SMA · Fading':'Fading expansion',rsi:rsiNow,rsiDelta:rsiNow-rsiStart,adx:adxNow,adxDelta:adxNow-adxStart,chop:chopNow,chopDelta:chopNow-chopStart,chartUrl:`https://www.tradingview.com/chart/?symbol=${item.entry.symbol==='SENSEX'?'BSE:SENSEX':`NSE:${item.entry.symbol}`}`,geminiAnalysis:'Awaiting Gemini analysis'});
    }
  }
  return rows;
}
export async function getCatchReversals(brokerToken?:string){
  const clock=getNSEMarketClockStatus(); const creds=await getNubraCredentialsForSession(brokerToken);
  const tradingDate=getIstTradingDate(); const sessionDate=getLastCompletedWeekdayDate(); const sessionIsoDate=`${sessionDate.slice(0,4)}-${sessionDate.slice(4,6)}-${sessionDate.slice(6,8)}`; const sessionRange=getIstSessionUtcRange(sessionDate);
  const historyStart=new Date(Date.now()-400*24*60*60*1000).toISOString(); const historyEnd=`${sessionRange.nextDay}T00:00:00.000Z`;
  if(!creds.authToken) throw new Error('Connect Nubra Finance first to scan live option and market data.');
  const h=headers(creds.authToken,creds.deviceId);
  const universe=[...NIFTY_500_FNO_UNIVERSE.filter(x=>x.isFno),...INDEX_BASKET_UNIVERSE];
  // Always build the near-level watchlist from daily candles first; it has no option-chain dependency.
  const watchRows=await fetchDailyWatchlist(universe,h,historyStart,historyEnd,sessionIsoDate);
  const confirmedRows:CatchReversalRow[]=[];
  for(const group of chunks(universe,BATCH_SIZE)){ confirmedRows.push(...await fetchGroup(group,h,clock.isOpen,sessionRange,historyStart,historyEnd,sessionIsoDate)); }
  // Confirmed bounce/rejection rows take precedence over watchlist rows for the same instrument.
  const confirmedSymbols=new Set(confirmedRows.map(row=>row.symbol));
  const all=[...confirmedRows,...watchRows.filter(row=>!confirmedSymbols.has(row.symbol))];
  // Expiry is selected per underlying from Nubra's actual monthly contract calendar.
  const firstChain=await getChain(universe[0],h); const expiry=firstChain?.expiry??getNextMonthlyExpiry(firstChain?.all_expiries??[]);
  return {items:all,clock,expiry,tradingDate,batchSize:BATCH_SIZE,universeCount:universe.length,loadedCount:all.length,watchlistCount:watchRows.length,confirmedCount:confirmedRows.length};
}
