// ALFA Market Feed: fresh public Binance spot OHLCV, served on demand.
// Optional Cloudflare KV ("ALFA_KV") stores successful scheduled snapshots.
// No exchange credentials, user balances, or trading actions.
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const INTERVALS = { "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const PROVIDERS = ["https://data-api.binance.vision", "https://api.binance.com"];
const KEY = "latest:kraken-usd:v3";
const MINUTE = 60_000;
const STALE_MS = 10 * MINUTE;

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
async function store(env, data) {
  if (env?.ALFA_KV) await env.ALFA_KV.put(KEY, JSON.stringify(data));
}
async function latest(env) {
  if (env?.ALFA_KV) {
    const cached = await env.ALFA_KV.get(KEY, "json");
    const age = cached?.snapshot_utc ? Date.now() - Date.parse(cached.snapshot_utc) : Infinity;
    if (age >= 0 && age < STALE_MS && Object.keys(cached.symbols || {}).length === 3 && cached.market?.startsWith("Kraken"))
      return {...cached, delivery:"cloudflare_kv", data_age_seconds:Math.round(age / 1000)};
  }
  const fresh = await liveSnapshot();
  await store(env, fresh);
  return {...fresh, delivery:"fresh_market_fetch", data_age_seconds:0};
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
    let high=-Infinity,low=Infinity,base=0,quote=0,trades=0;
    for(const r of rows) {
      high=Math.max(high,positive(r[2]));
      low=Math.min(low,positive(r[3]));
      const vol=nonnegative(r[6]);
      base+=vol;
      quote+=vol*positive(r[5]); // approximate quote turnover from hourly VWAP
      const n=Number(r[7]);
      if(!Number.isInteger(n)||n<0)throw Error("Invalid Kraken trade count");
      trades+=n;
    }
    // Compatible with krakenCandle input positions (UTC open, OHLC, VWAP, base, trades).
    groups.push([Math.floor(bucket/1000),o,high,low,c,base>0?quote/base:c,base,trades]);
  }
  return groups;
}

function krakenCandle(row,interval,index,rows,now) {
  const dur=KRAKEN_INTERVALS[interval];
  const openMs=Number(row[0])*1000;
  const o=positive(row[1]),h=positive(row[2]),l=positive(row[3]),c=positive(row[4]);
  const vwap=positive(row[5]),base=nonnegative(row[6]);
  const trades=Number(row[7]);
  if(!Number.isInteger(trades)||trades<0||l>Math.min(o,c)||h<Math.max(o,c))
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
async function collectKraken() {
  const pairs=[];
  for(const item of Object.entries(KRAKEN_PAIRS)) {
    pairs.push(await getKrakenSymbol(item));
    // Spread provider requests, avoid three simultaneous calls from one Worker.
    await sleep(400);
  }
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
  return {schema_version:3,snapshot_utc:iso(Date.now()),
    market:"Kraken spot / USD (NOT Binance USDT or Revolut X)",
    source:"Kraken public REST 1H; 4H/1D aggregated on UTC boundaries",
    data_type:"on-demand REST snapshot, not WebSocket",
    symbols,alerts,volume_method:"hourly base volumes aggregated; quote USD turnover estimated from hourly VWAP",
    signal_disclaimer:"Market source differs from Binance USDT. Never merge venue volumes. Thresholds do not imply a trade."};
}
async function liveSnapshot() {
  if(memo&&Date.now()-memoAt<CACHE_FOR_MS)return memo;
  if(inFlight)return await inFlight;
  inFlight=collectKraken().then(s=>{
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
  return {diagnostics_version:"kraken-hourly-aggregation-v3",
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
    if (url.pathname === "/health") {
      try {
        const row = env?.ALFA_KV ? await env.ALFA_KV.get(KEY,"json") : null;
        const age = row?.snapshot_utc ? Math.round((Date.now()-Date.parse(row.snapshot_utc))/1000) : null;
        return reply({status:age != null && age <= 600 ? "fresh" : "unverified",
          kv_configured:!!env?.ALFA_KV, snapshot_utc:row?.snapshot_utc ?? null, age_seconds:age,
          note:"Live /latest.json endpoint fetches from exchange when KV is absent/stale"});
      } catch(e) { return reply({status:"error", error:"health_check_failed"},503); }
    }
    if (url.pathname !== "/latest.json") return reply({name:"ALFA Market Feed",source:"Kraken Spot USD",version:"kraken-hourly-aggregation-v3",routes:["/latest.json","/health","/diagnostics","/provider-check"]});
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
  }
};
