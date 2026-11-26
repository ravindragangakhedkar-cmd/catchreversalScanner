import { computeEMA, computeMarketBias, computeTwinRangeFilter } from '../shared/indicators.ts';
import { INDEX_BASKET_UNIVERSE, NIFTY_500_FNO_UNIVERSE, type StockUniverseEntry } from '../shared/nifty500Universe.ts';
import { getBrokerSessionByToken } from './brokerService.ts';
import { getIstTradingDate, getLastCompletedWeekdayDate } from './marketDates.ts';

const BASE = process.env.NUBRA_API_BASE_URL?.trim() || 'https://api.nubra.io';
const BATCH = 5;
type Bar={date:string;timestamp:number;open:number;high:number;low:number;close:number;volume:number};
type Row={symbol:string;name:string;price:number;weeklyTrend:'Bullish'|'Bearish';dailyTrend:'Bullish'|'Bearish';jointStatus:'Aligned'|'Divergent';twinRangeStatus:'Long'|'Short'|'No fresh signal';rsi:number;adx:number;chop:number;chartUrl:string};
const chunks=<T,>(a:T[],n:number)=>Array.from({length:Math.ceil(a.length/n)},(_,i)=>a.slice(i*n,(i+1)*n));
function indicators(bars:Bar[],period:number,smoothing:number){
 const mb=computeMarketBias(bars.map(b=>({...b,timestamp:b.timestamp})),{period,smoothing,oscPeriod:7});
 const i=bars.length-1;
 return {trend:mb.mbClose[i]>=mb.mbOpen[i]?'Bullish' as const:'Bearish' as const};
}
function rsi(v:number[],p=14){if(v.length<=p)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=v[i]-v[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}let ag=g/p,al=l/p;for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}return al===0?100:100-100/(1+ag/al);}
function adx(b:Bar[],p=14){if(b.length<2*p+1)return 0;const tr:number[]=[],pd:number[]=[],md:number[]=[];for(let i=1;i<b.length;i++){const x=b[i-1],y=b[i],u=y.high-x.high,d=x.low-y.low;tr.push(Math.max(y.high-y.low,Math.abs(y.high-x.close),Math.abs(y.low-x.close)));pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);}let t=tr.slice(0,p).reduce((a,x)=>a+x,0),a=pd.slice(0,p).reduce((x,y)=>x+y,0),z=md.slice(0,p).reduce((x,y)=>x+y,0);const dx:number[]=[];for(let i=p;i<=tr.length;i++){const pi=t?a/t*100:0,mi=t?z/t*100:0;dx.push(pi+mi?Math.abs(pi-mi)/(pi+mi)*100:0);if(i<tr.length){t=t-t/p+tr[i];a=a-a/p+pd[i];z=z-z/p+md[i];}}let out=dx.slice(0,p).reduce((x,y)=>x+y,0)/p;for(let i=p;i<dx.length;i++)out=(out*(p-1)+dx[i])/p;return out;}
function chop(b:Bar[],p=10){if(b.length<p+1)return 50;let sum=0;for(let i=b.length-p;i<b.length;i++){const x=b[i],q=b[i-1];sum+=Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close));}const w=b.slice(-p),hi=Math.max(...w.map(x=>x.high)),lo=Math.min(...w.map(x=>x.low));return hi>lo&&sum>0?100*Math.log10(sum/(hi-lo))/Math.log10(p):50;}
function extract(payload:any,symbol:string):Bar[]{const root=payload?.result?.find?.((r:any)=>r?.values?.some?.((v:any)=>v?.[symbol]))??payload?.result?.[0];const vals=root?.values?.find?.((v:any)=>v?.[symbol])?.[symbol]??root?.values?.[0]?.[symbol];if(!vals)return[];const map=new Map<number,any>();for(const k of ['open','high','low','close','volume'])for(const t of vals[k]??[]){const ts=Number(t.ts),o=map.get(ts)??{timestamp:ts};o[k]=Number(t.v)/100;map.set(ts,o);}return [...map.values()].filter(x=>x.open>0&&x.high>0&&x.low>0&&x.close>0).map(x=>({...x,date:new Date(x.timestamp).toISOString().slice(0,10)})).sort((a,b)=>a.timestamp-b.timestamp);}
async function fetchBatch(entries:StockUniverseEntry[],token:string,device:string,start:string,end:string){const h:Record<string,string>={Accept:'application/json','Content-Type':'application/json',Authorization:`Bearer ${token}`};if(device)h['x-device-id']=device;const query=entries.map(e=>({exchange:e.symbol==='SENSEX'?'BSE':'NSE',type:e.isIndex?'INDEX':'STOCK',values:[e.symbol],fields:['open','high','low','close','volume'],interval:'1d',intraDay:false,startDate:start,endDate:end}));const r=await fetch(`${BASE}/charts/timeseries`,{method:'POST',headers:h,body:JSON.stringify({query}),cache:'no-store',signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Nubra historical candles returned HTTP ${r.status}`);return r.json();}
function toWeekly(bars:Bar[]){const map=new Map<string,Bar[]>();for(const b of bars){const d=new Date(b.timestamp);const day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day);const key=d.toISOString().slice(0,10);const a=map.get(key)??[];a.push(b);map.set(key,a);}return [...map.values()].map(a=>({date:a[0].date,timestamp:a[0].timestamp,open:a[0].open,high:Math.max(...a.map(x=>x.high)),low:Math.min(...a.map(x=>x.low)),close:a.at(-1)!.close,volume:a.reduce((s,x)=>s+x.volume,0)}));}
export async function getBiasMultiTimeframe(brokerToken?:string){
 const session=await getBrokerSessionByToken(brokerToken);
 if(!session?.connected||session.provider!=='nubra'||!session.nubraLiveAuth)throw new Error('Connect your live Nubra Finance account before scanning.');
 const token=session.nubraLiveAuth.authToken,device=session.nubraLiveAuth.deviceId??'';
 const universe=[...NIFTY_500_FNO_UNIVERSE.filter(x=>x.isFno),...INDEX_BASKET_UNIVERSE];
 const end=new Date().toISOString(),start=new Date(Date.now()-900*86400000).toISOString();
 const rows:Row[]=[];let failed=0;
 for(const group of chunks(universe,BATCH)){let payload:any;try{payload=await fetchBatch(group,token,device,start,end);}catch{failed+=group.length;continue;}
  for(const entry of group){const bars=extract(payload,entry.symbol);if(bars.length<220){failed++;continue;}
   const weekly=toWeekly(bars);if(weekly.length<120){failed++;continue;}
   const w=indicators(weekly,100,50),d=indicators(bars,50,20);
   const twin=computeTwinRangeFilter(bars.map(x=>x.close));const last=bars.length-1;
   const latest=twin.signals[last];const trendSignal=latest==='BUY'?'Long':latest==='SELL'?'Short':'No fresh signal';
   const closes=bars.map(x=>x.close);
   rows.push({symbol:entry.symbol,name:entry.companyName,price:bars[last].close,weeklyTrend:w.trend,dailyTrend:d.trend,jointStatus:w.trend===d.trend?'Aligned':'Divergent',twinRangeStatus:trendSignal,rsi:rsi(closes),adx:adx(bars),chop:chop(bars),chartUrl:`https://www.tradingview.com/chart/?symbol=${entry.symbol==='SENSEX'?'BSE:SENSEX':`NSE:${entry.symbol}`}`});
  }
 }
 return {items:rows,universeCount:universe.length,loadedCount:rows.length,failedCount:failed,tradingDate:getLastCompletedWeekdayDate(),settings:{weekly:{period:100,smoothing:50,oscillator:7},daily:{period:50,smoothing:20,oscillator:7},twinRange:{fastPeriod:27,fastMultiplier:1.6,slowPeriod:55,slowMultiplier:2.0}}};
}
