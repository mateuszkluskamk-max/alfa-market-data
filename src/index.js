// ALFA Market Feed: fresh public Binance spot OHLCV, served on demand.
// Optional Cloudflare KV ("ALFA_KV") stores successful scheduled snapshots.
// No exchange credentials, user balances, or trading actions.
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const INTERVALS = { "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const PROVIDERS = ["https://data-api.binance.vision", "https://api.binance.com"];
const KEY = "latest:multi-venue-usd:v4";
const MINUTE = 60_000;
const STALE_MS = 6 * MINUTE;
const ARCHIVE_PREFIX = "archive:v1:";
const ARCHIVE_TTL_SECONDS = 14 * 86400;

function iso(ms) { return new Date(ms).toISOString(); }
function positive(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) throw Error("Invalid positive numeric market value");
  return n;
}
function nonnegative(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) throw Error("Invalid nonnegative market value");
  return n;
}
function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  return (a[9] + a[10]) / 2;
}
async function binance(path, params) {
  const q = new URLSearchParams(params);
  let lastError;
  for (const host of PROVIDERS) {
    try {
      const response = await fetch(host + path + "?" + q.toString(), {
        headers: { "Accept": "application/json", "User-Agent": "ALFA-Market-Feed/1.0" },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw Error("HTTP " + response.status);
      return await response.json();
    } catch (error) { lastError = error; }
  }
  throw Error("Public Binance API unavailable: " + String(lastError));
}
function candle(row, interval, index, all, now) {
  if (!Array.isArray(row) || row.length < 11) throw Error("Malformed candle");
  const openMs = Number(row[0]);
  const closeMs = Number(row[6]);
  const o = positive(row[1]), h = positive(row[2]), l = positive(row[3]), c = positive(row[4]);
  const base = nonnegative(row[5]), quote = nonnegative(row[7]);
  if (closeMs !== openMs + INTERVALS[interval] - 1 || l > Math.min(o, c) || h < Math.max(o, c))
    throw Error("Invalid candle chronology/OHLC");
  const earlier = index >= 20 ? all.slice(index - 20, index) : null;
  const m = earlier ? median(earlier.map(k => nonnegative(k[7]))) : null;
  const ratio = m > 0 ? quote / m : null;
  const closed = closeMs < now;
  const elapsed = Math.max(0, Math.min(now - openMs, INTERVALS[interval]));
  const pace = !closed && ratio != null && elapsed >= 10 * MINUTE ? ratio / (elapsed / INTERVALS[interval]) : null;
  return {
    open_time_utc: iso(openMs), close_time_utc: iso(closeMs),
    open: o, high: h, low: l, close: c,
    volume_base: base, volume_quote_usdt: quote, trades: Number(row[8]),
    closed, change_pct: +((c / o - 1) * 100).toFixed(3),
    volume_ratio_median20: ratio == null ? null : +ratio.toFixed(3),
    open_candle_volume_pace_ratio: pace == null ? null : +pace.toFixed(3)
  };
}
async function getSymbol(symbol) {
  const intervals = {};
  for (const interval of Object.keys(INTERVALS)) {
    const rows = await binance("/api/v3/klines", {symbol, interval, limit: "55"});
    if (!Array.isArray(rows) || rows.length < 25) throw Error("Insufficient " + symbol + " " + interval);
    for (let i = 1; i < rows.length; i++)
      if (Number(rows[i][0]) - Number(rows[i - 1][0]) !== INTERVALS[interval])
        throw Error("Missing/duplicate candles " + symbol + " " + interval);
    const now = Date.now();
    const last = candle(rows.at(-1), interval, rows.length - 1, rows, now);
    const previous = candle(rows.at(-2), interval, rows.length - 2, rows, now);
    const lastClosed = last.closed ? last : previous;
    if (!lastClosed.closed) throw Error("No closed candle " + interval);
    if (now - Number(rows.at(-1)[0]) > INTERVALS[interval] + 2 * MINUTE)
      throw Error("Stale candle from market provider " + symbol + " " + interval);
    intervals[interval] = { last_closed: lastClosed, in_progress: last.closed ? null : last };
  }
  const tick = await binance("/api/v3/ticker/price", {symbol});
  if (tick?.symbol !== symbol) throw Error("Wrong ticker symbol");
  const price = positive(tick.price);
  const current = intervals["1h"].in_progress;
  if (current && Math.abs(price / current.close - 1) > 0.03)
    throw Error("Ticker diverges from 1H candle for " + symbol);
  return {last_price_usdt: price, intervals};
}
async function collect() {
  const pairs = await Promise.all(SYMBOLS.map(async symbol => [symbol, await getSymbol(symbol)]));
  const alerts = [];
  const symbols = Object.fromEntries(pairs);
  for (const [symbol, entry] of pairs) {
    const c = entry.intervals["4h"].in_progress;
    if (!c) continue;
    const threshold = symbol === "BTCUSDT" ? 3 : 4.5;
    if (Math.abs(c.change_pct) >= threshold)
      alerts.push({ symbol, type:"4h_movement_in_progress", change_pct:c.change_pct, threshold_pct:threshold, candle_open_utc:c.open_time_utc });
    if (c.open_candle_volume_pace_ratio >= 1.8)
      alerts.push({ symbol, type:"4h_unusual_volume_pace_in_progress", volume_pace_ratio:c.open_candle_volume_pace_ratio, threshold_ratio:1.8, candle_open_utc:c.open_time_utc });
  }
  return {
    schema_version:1, snapshot_utc:iso(Date.now()), market:"Binance spot / USDT (not Revolut X)",
    data_type:"fresh on-demand REST read or scheduled Cloudflare KV snapshot, not WebSocket",
    symbols, alerts, signal_disclaimer:"Volume/move thresholds are alerts only; never automatic BUY/SELL."
  };
}
async function dispatchGitHubMirror(env, snapshot, scheduledTime) {
  if (!env?.GITHUB_DISPATCH_TOKEN) return {enabled:false,reason:"missing_secret"};
  // GitHub data mirror every ten minutes; no duplicate ChatGPT automation.
  const minute=new Date(scheduledTime || Date.now()).getUTCMinutes();
  if(minute%10!==0)return {enabled:true,dispatched:false,reason:"not_due"};
  const response=await fetch(
    "https://api.github.com/repos/mateuszkluskamk-max/alfa-market-data/dispatches",{
      method:"POST",
      headers:{
        "Accept":"application/vnd.github+json",
        "Content-Type":"application/json",
        "Authorization":"Bearer "+env.GITHUB_DISPATCH_TOKEN,
        "User-Agent":"ALFA-Market-Feed/1.0"
      },
      body:JSON.stringify({
        event_type:"alfa_cloudflare_sync",
        client_payload:{snapshot_utc:snapshot.snapshot_utc,market:snapshot.market}
      }),
      signal:AbortSignal.timeout(10000)
    }
  );
  if(response.status!==204)
    throw Error("GitHub repository_dispatch failed: HTTP "+response.status);
  return {enabled:true,dispatched:true};
}

async function store(env, data) {
  if (!env?.ALFA_KV) return;
  const stored = {...data, stored_by:"cloudflare_cron", stored_utc:iso(Date.now())};
  // Two KV writes per five-minute run: latest + immutable 14-day history.
  // Cron runs 288 times per day => 576 writes, under Free 1000/day.
  const bucket = new Date(Math.floor(Date.parse(data.snapshot_utc) / (5 * MINUTE)) * (5 * MINUTE))
    .toISOString().slice(0,16) + "Z";
  const archiveKey = ARCHIVE_PREFIX + bucket;
  await env.ALFA_KV.put(archiveKey, JSON.stringify(stored), {expirationTtl:ARCHIVE_TTL_SECONDS});
  await env.ALFA_KV.put(KEY, JSON.stringify(stored));
}
async function latest(env) {
  if (env?.ALFA_KV) {
    const cached = await env.ALFA_KV.get(KEY, "json");
    const age = cached?.snapshot_utc ? Date.now() - Date.parse(cached.snapshot_utc) : Infinity;
    if (age >= 0 && age < STALE_MS && Object.keys(cached.symbols || {}).length === 3 && (cached.market?.startsWith("Bitstamp")||cached.market?.startsWith("Kraken")))
      return {...cached, delivery:"cloudflare_kv", data_age_seconds:Math.round(age / 1000)};
  }
  const fresh = await liveSnapshot();
  // On-demand reads do not write KV, protecting Free plan quota.
  return {...fresh, delivery:"fresh_market_fetch", data_age_seconds:Math.max(0,Math.round((Date.now()-Date.parse(fresh.snapshot_utc))/1000))};
}
function reply(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status, headers:{"content-type":"application/json; charset=utf-8", "cache-control":"no-store",
      "access-control-allow-origin":"*"}
  });
}

// Kraken REST permits up to 720 hourly candles. We make ONE call per market,
// then aggregate UTC-aligned hours into 4H and 1D candles (three calls total).
const KRAKEN_PAIRS = Object.freeze({BTCUSD:"XBTUSD", ETHUSD:"ETHUSD", SOLUSD:"SOLUSD"});
const KRAKEN_INTERVALS = Object.freeze({"1h":3600000,"4h":14400000,"1d":86400000});
const KRAKEN_URL = "https://api.kraken.com/0/public/OHLC";
const CACHE_FOR_MS = 120_000;
let memo = null, memoAt = 0, inFlight = null;
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function krakenHourly(pair) {
  const url = new URL(KRAKEN_URL);
  url.searchParams.set("pair",pair);
  url.searchParams.set("interval","60");
  // Enough hourly candles for 20 complete daily volume baselines.
  url.searchParams.set("since",String(Math.floor(Date.now()/1000) - 28 * 86400));
  let failure = "unknown";
  for (let attempt=0;attempt<3;attempt++) {
    try {
      const response = await fetch(url.toString(),{
        headers:{"Accept":"application/json"},
        signal:AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw Error("HTTP " + response.status);
      const body = await response.json();
      if (!Array.isArray(body?.error)) throw Error("Malformed Kraken response");
      if (body.error.length) {
        const err = body.error.join(";");
        if (err.toLowerCase().includes("too many requests")) {
          failure = err;
          if (attempt < 2) { await sleep((attempt + 1) * 2200); continue; }
        }
        throw Error("Kraken OHLC error: " + err);
      }
      const keys = Object.keys(body?.result || {}).filter(k=>k!=="last"&&Array.isArray(body.result[k]));
      if(keys.length!==1)throw Error("Kraken pair response ambiguous");
      const rows=body.result[keys[0]];
      if(rows.length < 24*21 + 24)throw Error("Insufficient Kraken 1H candles: " + rows.length);
      for(let i=1;i<rows.length;i++)
        if((Number(rows[i][0])-Number(rows[i-1][0])) !== 3600)
          throw Error("Gap or duplicate in Kraken 1H candles");
      const now=Date.now();
      if(now-Number(rows.at(-1)[0])*1000 > 3600000+120000)
        throw Error("Stale Kraken 1H candle");
      return rows;
    } catch(err) {
      failure=String(err);
      if(attempt===2)break;
      // Retry transport errors as well as Kraken rate limiting.
      await sleep((attempt+1)*2200);
    }
  }
  throw Error("Kraken " + pair + ": " + failure);
}

function synthesizedRows(hourly, duration) {
  const buckets = new Map();
  for(const row of hourly) {
    if(!Array.isArray(row)||row.length<8)throw Error("Malformed Kraken hourly candle");
    const hourStart=Number(row[0])*1000;
    const bucket=Math.floor(hourStart/duration)*duration;
    if(!buckets.has(bucket))buckets.set(bucket,[]);
    buckets.get(bucket).push(row);
  }
  const groups=[];
  const now=Date.now();
  for(const [bucket, rows] of buckets.entries()) {
    const expected=duration/3600000;
    if(Number(rows[0][0])*1000 !== bucket) {
      if(groups.length===0)continue; // oldest partial bucket
      throw Error("Gap at beginning of aggregated Kraken UTC bucket");
    }
    const isCurrent=bucket+duration>now;
    const expectedNow=isCurrent?Math.floor((now-bucket)/3600000)+1:expected;
    if(rows.length !== expectedNow) throw Error("Missing hourly rows for aggregate "+
      duration+" bucket "+iso(bucket)+" ("+rows.length+"/"+expectedNow+")");
    const o=positive(rows[0][1]);
    const c=positive(rows.at(-1)[4]);
    let high=-Infinity,low=Infinity,base=0,quote=0,trades=0,tradesUnknown=false;
    for(const r of rows) {
      high=Math.max(high,positive(r[2]));
      low=Math.min(low,positive(r[3]));
      const vol=nonnegative(r[6]);
      base+=vol;
      quote+=vol*positive(r[5]); // approximate quote turnover from hourly VWAP
      if(r[7]===null||r[7]===undefined)tradesUnknown=true;
      else {const n=Number(r[7]); if(!Number.isInteger(n)||n<0)throw Error("Invalid trade count");trades+=n;}
    }
    // Compatible with krakenCandle input positions (UTC open, OHLC, VWAP, base, trades).
    groups.push([Math.floor(bucket/1000),o,high,low,c,base>0?quote/base:c,base,tradesUnknown?null:trades]);
  }
  return groups;
}

function krakenCandle(row,interval,index,rows,now) {
  const dur=KRAKEN_INTERVALS[interval];
  const openMs=Number(row[0])*1000;
  const o=positive(row[1]),h=positive(row[2]),l=positive(row[3]),c=positive(row[4]);
  const vwap=positive(row[5]),base=nonnegative(row[6]);
  const trades=row[7]===null||row[7]===undefined?null:Number(row[7]);
  if((trades!==null&&(!Number.isInteger(trades)||trades<0))||l>Math.min(o,c)||h<Math.max(o,c))
    throw Error("Invalid Kraken OHLC");
  const prior=index>=20?rows.slice(index-20,index).map(r=>nonnegative(r[6])):null;
  const med=prior?median(prior):null;
  const ratio=med>0?base/med:null;
  const closed=openMs+dur-1 < now;
  const elapsed=Math.max(0,Math.min(now-openMs,dur));
  const pace=!closed&&ratio!==null&&elapsed>=10*MINUTE?ratio/(elapsed/dur):null;
  return {open_time_utc:iso(openMs),close_time_utc:iso(openMs+dur-1),
    open:o,high:h,low:l,close:c,volume_base:base,
    volume_quote_usd_estimate:+(base*vwap).toFixed(2),trades,closed,
    change_pct:+((c/o-1)*100).toFixed(3),
    volume_ratio_median20:ratio===null?null:+ratio.toFixed(3),
    open_candle_volume_pace_ratio:pace===null?null:+pace.toFixed(3)};
}
function summarizeKraken(rows,interval) {
  if(rows.length<25)throw Error("Too few aggregated Kraken "+interval+" candles");
  const now=Date.now();
  const last=krakenCandle(rows.at(-1),interval,rows.length-1,rows,now);
  const prev=krakenCandle(rows.at(-2),interval,rows.length-2,rows,now);
  const closed=last.closed?last:prev;
  if(!closed.closed)throw Error("No closed Kraken "+interval+" candle");
  if(now-Date.parse(last.open_time_utc)>KRAKEN_INTERVALS[interval]+120000)
    throw Error("Stale aggregated Kraken "+interval+" candle");
  return {last_closed:closed,in_progress:last.closed?null:last};
}
async function getKrakenSymbol([symbol,pair]) {
  const hourly=await krakenHourly(pair);
  const intervals={
    "1h":summarizeKraken(hourly,"1h"),
    "4h":summarizeKraken(synthesizedRows(hourly,14400000),"4h"),
    "1d":summarizeKraken(synthesizedRows(hourly,86400000),"1d")
  };
  const last=intervals["1h"].in_progress||intervals["1h"].last_closed;
  return [symbol,{source_pair:pair,last_price_usd:last.close,
    price_source:"latest Kraken hourly candle close (not Revolut execution price)",intervals}];
}
const BITSTAMP_PAIRS=Object.freeze({BTCUSD:"btcusd",ETHUSD:"ethusd",SOLUSD:"solusd"});
async function bitstampHourly(pair) {
  const url="https://www.bitstamp.net/api/v2/ohlc/"+pair+"/?step=3600&limit=700";
  let lastError="unknown";
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const response=await fetch(url,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(12_000)});
      if(!response.ok)throw Error("Bitstamp HTTP "+response.status);
      const body=await response.json();
      const raw=body?.data?.ohlc;
      if(!Array.isArray(raw)||raw.length<24*21+24)
        throw Error("Bitstamp returned insufficient hourly candles");
      const rows=raw.map(k=>{
        const o=positive(k.open),h=positive(k.high),l=positive(k.low),c=positive(k.close);
        const v=nonnegative(k.volume);
        const typical=(h+l+c)/3; // estimate; Bitstamp OHLC does not supply hourly VWAP
        return [Number(k.timestamp),o,h,l,c,typical,v,null];
      }).sort((a,b)=>a[0]-b[0]);
      for(let i=1;i<rows.length;i++)
        if(rows[i][0]-rows[i-1][0]!==3600)
          throw Error("Missing or duplicate Bitstamp hourly candles");
      if(Date.now()-rows.at(-1)[0]*1000>3600000+120000)
        throw Error("Stale Bitstamp hourly candle");
      return rows;
    }catch(err){
      lastError=String(err);
      if(attempt<1)await sleep(1500);
    }
  }
  throw Error("Bitstamp "+pair+": "+lastError);
}
async function getBitstampSymbol([symbol,pair]) {
  const hourly=await bitstampHourly(pair);
  const intervals={
    "1h":summarizeKraken(hourly,"1h"),
    "4h":summarizeKraken(synthesizedRows(hourly,14400000),"4h"),
    "1d":summarizeKraken(synthesizedRows(hourly,86400000),"1d")
  };
  const last=intervals["1h"].in_progress||intervals["1h"].last_closed;
  return [symbol,{source_pair:pair,last_price_usd:last.close,
    price_source:"latest Bitstamp hourly OHLC close (not a Revolut executable price)",intervals}];
}
function marketSnapshot(pairs,market,source,volumeMethod) {
  const symbols=Object.fromEntries(pairs),alerts=[];
  for(const [symbol,entry] of pairs) {
    const c=entry.intervals["4h"].in_progress;
    if(!c)continue;
    const threshold=symbol==="BTCUSD"?3:4.5;
    if(Math.abs(c.change_pct)>=threshold)
      alerts.push({symbol,type:"4h_movement_in_progress",change_pct:c.change_pct,
        threshold_pct:threshold,candle_open_utc:c.open_time_utc});
    if(c.open_candle_volume_pace_ratio!==null&&c.open_candle_volume_pace_ratio>=1.8)
      alerts.push({symbol,type:"4h_unusual_volume_pace_in_progress",
        volume_pace_ratio:c.open_candle_volume_pace_ratio,threshold_ratio:1.8,
        candle_open_utc:c.open_time_utc});
  }
  return {schema_version:4,snapshot_utc:iso(Date.now()),market,source,
    data_type:"on-demand public REST snapshot, not WebSocket",
    symbols,alerts,volume_method:volumeMethod,
    signal_disclaimer:"Do not compare venue volumes as though they were one market. Alerts are not BUY/SELL."};
}
async function collectBitstamp() {
  const pairs=[];
  for(const item of Object.entries(BITSTAMP_PAIRS))pairs.push(await getBitstampSymbol(item));
  return marketSnapshot(pairs,"Bitstamp spot / USD (not Revolut X)",
    "Bitstamp public REST 1H; 4H/1D aggregated UTC",
    "base volume; quote USD estimate = base volume * hourly typical (H+L+C)/3");
}

async function collectKraken() {
  const pairs=[];
  for(const item of Object.entries(KRAKEN_PAIRS)){
    pairs.push(await getKrakenSymbol(item));
    await sleep(400);
  }
  return marketSnapshot(pairs,"Kraken spot / USD (not Revolut X)",
    "Kraken public REST 1H; 4H/1D aggregated UTC",
    "base volume; quote USD estimated from Kraken hourly VWAP");
}

async function liveSnapshot() {
  if(memo&&Date.now()-memoAt<CACHE_FOR_MS)return memo;
  if(inFlight)return await inFlight;
  inFlight=(async()=>{
    try { return await collectBitstamp(); }
    catch(primaryError) {
      console.error("Bitstamp failed; trying Kraken:",String(primaryError).slice(0,200));
      return await collectKraken();
    }
  })().then(s=>{
    memo=s;memoAt=Date.now();return s;
  }).finally(()=>{inFlight=null;});
  return await inFlight;
}
async function providerChecks() {
  const targets = [
    ["bitstamp_btc_1h","https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=3600&limit=36"],
    ["bitstamp_eth_1h","https://www.bitstamp.net/api/v2/ohlc/ethusd/?step=3600&limit=36"],
    ["bitstamp_sol_1h","https://www.bitstamp.net/api/v2/ohlc/solusd/?step=3600&limit=36"],
    ["coinbase_btc_1h","https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600"],
    ["coinbase_eth_1h","https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=3600"],
    ["coinbase_sol_1h","https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=3600"]
  ];
  const checks=[];
  for (const [name,url] of targets) {
    try {
      const resp=await fetch(url,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(7000)});
      const txt=await resp.text();
      let summary={};
      try{
        const json=JSON.parse(txt);
        if(name.startsWith("bitstamp")) {
          const o=json?.data?.ohlc;
          summary={bars:Array.isArray(o)?o.length:null,last_utc:o?.at(-1)?.timestamp||null,pair:json?.data?.pair||null};
        } else summary={bars:Array.isArray(json)?json.length:null,last_utc:Array.isArray(json)?json[0]?.[0]:null};
      }catch(_){summary={body:txt.slice(0,100)};}
      checks.push({name,http_status:resp.status,ok:resp.ok,...summary});
    }catch(err){checks.push({name,ok:false,error:String(err).slice(0,150)});}
  }
  return {snapshot_utc:iso(Date.now()),checks,purpose:"public API connectivity; no account or private market data"};
}

async function diagnostics() {
  let status;
  try {
    const data=await liveSnapshot();
    status={ok:true,snapshot_utc:data.snapshot_utc,
      market:data.market,symbols:Object.keys(data.symbols)};
  } catch(err) {status={ok:false,error:String(err).slice(0,350)};}
  return {diagnostics_version:"multi-venue-bitstamp-kraken-kv-v5",preferred:"Bitstamp",fallback:"Kraken",
    snapshot_utc:iso(Date.now()),collector:status,
    api_calls_per_uncached_snapshot:3,cache_seconds:120,
    purpose:"diagnostics only; not an investment signal"};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return reply({error:"method_not_allowed"}, 405);
    if (url.pathname === "/provider-check") return reply(await providerChecks());
    if (url.pathname === "/diagnostics") return reply(await diagnostics());
    if (url.pathname === "/history.json") {
      if(!env?.ALFA_KV) return reply({error:"archive_unavailable",kv_configured:false},503);
      const date = url.searchParams.get("date") || iso(Date.now()).slice(0,10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply({error:"invalid_date"},400);
      const limit = Math.min(288,Math.max(1,Number(url.searchParams.get("limit"))||60));
      const prefix = ARCHIVE_PREFIX + date;
      const listed = await env.ALFA_KV.list({prefix,limit:300});
      const keys = (listed.keys||[]).map(k=>k.name).sort().slice(-limit);
      return reply({date,source:"Cloudflare KV, cron-only snapshots",limit,
        count:keys.length,keys,complete_day:listed.list_complete===true});
    }
    if (url.pathname === "/health") {
      try {
        const row = env?.ALFA_KV ? await env.ALFA_KV.get(KEY,"json") : null;
        const age = row?.snapshot_utc ? Math.round((Date.now()-Date.parse(row.snapshot_utc))/1000) : null;
        return reply({status:age != null && age <= 600 ? "fresh" : "unverified",
          kv_configured:!!env?.ALFA_KV, snapshot_utc:row?.snapshot_utc ?? null, age_seconds:age,
          note:"Cron saves latest and 14-day history in KV. /latest.json refreshes from exchange if KV is missing or >6 minutes old, without writing KV."});
      } catch(e) { return reply({status:"error", error:"health_check_failed"},503); }
    }
    if (url.pathname !== "/latest.json") return reply({name:"ALFA Market Feed",source:"Bitstamp Spot USD, Kraken backup",version:"multi-venue-bitstamp-kraken-v4",routes:["/latest.json","/health","/history.json","/diagnostics","/provider-check"]});
    try { const data = await latest(env); return new Response(JSON.stringify(data), {status:200, headers:{"content-type":"application/json; charset=utf-8","cache-control":"public, max-age=120","access-control-allow-origin":"*"}}); }
    catch(e) {
      console.error("live snapshot failed", String(e));
      return reply({error:"market_data_unavailable",snapshot_utc:null,
        note:"No stale snapshot returned as current; GitHub backup remains separate."},503);
    }
  },
  async scheduled(_controller,env,_ctx) {
    if(!env?.ALFA_KV) { console.log("ALFA Cron: no KV binding, skipping redundant provider requests"); return; }
    const snap = await liveSnapshot();
    await store(env, snap);
    console.log("ALFA Cron", snap.snapshot_utc, "KV configured:", !!env?.ALFA_KV);
    // Optional: only if user explicitly installed a repo-scoped Cloudflare secret.
    try {
      const bridge=await dispatchGitHubMirror(env,snap,_controller?.scheduledTime);
      console.log("ALFA GitHub bridge",bridge.enabled?"enabled":"disabled",bridge.dispatched||false);
    } catch(error) {
      // KV archive remains valid even if optional GitHub dispatch fails.
      console.error("ALFA optional GitHub dispatch failed",String(error).slice(0,180));
    }
  }
};
