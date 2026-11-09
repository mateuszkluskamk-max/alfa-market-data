// ALFA Market Feed: fresh public Binance spot OHLCV, served on demand.
// Optional Cloudflare KV ("ALFA_KV") stores successful scheduled snapshots.
// No exchange credentials, user balances, or trading actions.
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const INTERVALS = { "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const PROVIDERS = ["https://data-api.binance.vision", "https://api.binance.com"];
const KEY = "latest:kraken-usd:v2";
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
  const fresh = await collectKraken();
  await store(env, fresh);
  return {...fresh, delivery:"fresh_market_fetch", data_age_seconds:0};
}
function reply(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status, headers:{"content-type":"application/json; charset=utf-8", "cache-control":"no-store",
      "access-control-allow-origin":"*"}
  });
}

const KRAKEN_PAIRS = Object.freeze({BTCUSD:"XBTUSD",ETHUSD:"ETHUSD",SOLUSD:"SOLUSD"});
const KRAKEN_INTERVALS = Object.freeze({"1h":60,"4h":240,"1d":1440});

function krakenCandle(row,interval,index,rows,now) {
  const dur=INTERVALS[interval];
  if (!Array.isArray(row) || row.length < 8) throw Error("Malformed Kraken OHLC row");
  const openMs=Number(row[0])*1000;
  const o=positive(row[1]),h=positive(row[2]),l=positive(row[3]),c=positive(row[4]);
  const vwap=positive(row[5]),base=nonnegative(row[6]);
  const trades=Number(row[7]);
  if (!Number.isInteger(trades)||trades<0||l>Math.min(o,c)||h<Math.max(o,c))
    throw Error("Invalid Kraken OHLC or trade count");
  const prior=index>=20?rows.slice(index-20,index).map(r=>nonnegative(r[6])):null;
  const med=prior?median(prior):null;
  const ratio=med>0?base/med:null;
  const closed=openMs+dur-1 < now;
  const elapsed=Math.max(0,Math.min(now-openMs,dur));
  const pace=!closed && ratio!==null && elapsed>=10*MINUTE
    ? ratio/(elapsed/dur):null;
  return {
    open_time_utc:iso(openMs),close_time_utc:iso(openMs+dur-1),
    open:o,high:h,low:l,close:c,
    volume_base:base,volume_quote_usd_estimate:+(base*vwap).toFixed(2),trades,
    closed,change_pct:+((c/o-1)*100).toFixed(3),
    volume_ratio_median20:ratio===null?null:+ratio.toFixed(3),
    open_candle_volume_pace_ratio:pace===null?null:+pace.toFixed(3)
  };
}
async function krakenOHLC(pair,interval) {
  const dur=INTERVALS[interval];
  const u=new URL("https://api.kraken.com/0/public/OHLC");
  u.searchParams.set("pair",pair);
  u.searchParams.set("interval",String(KRAKEN_INTERVALS[interval]));
  u.searchParams.set("since",String(Math.floor(Date.now()/1000)-60*dur/1000));
  const response=await fetch(u.toString(),{
    headers:{"Accept":"application/json"},signal:AbortSignal.timeout(12_000)
  });
  if(!response.ok)throw Error("Kraken OHLC HTTP "+response.status+" "+pair+" "+interval);
  const payload=await response.json();
  if(!Array.isArray(payload?.error)||payload.error.length)
    throw Error("Kraken OHLC API error "+pair+" "+interval+" "+String(payload?.error).slice(0,100));
  const keys=Object.keys(payload.result||{}).filter(k=>k!=="last"&&Array.isArray(payload.result[k]));
  if(keys.length!==1)throw Error("Ambiguous Kraken pair "+pair+" "+interval);
  const rows=payload.result[keys[0]].slice(-55);
  if(rows.length<25)throw Error("Too few Kraken candles "+pair+" "+interval);
  for(let i=1;i<rows.length;i++)
    if((Number(rows[i][0])-Number(rows[i-1][0]))*1000!==dur)
      throw Error("Missing Kraken candle "+pair+" "+interval);
  const now=Date.now();
  const last=krakenCandle(rows.at(-1),interval,rows.length-1,rows,now);
  const prev=krakenCandle(rows.at(-2),interval,rows.length-2,rows,now);
  if(now-Date.parse(last.open_time_utc)>dur+2*MINUTE)
    throw Error("Stale Kraken candle "+pair+" "+interval);
  const lastClosed=last.closed?last:prev;
  if(!lastClosed.closed)throw Error("No closed Kraken candle "+pair+" "+interval);
  return {last_closed:lastClosed,in_progress:last.closed?null:last};
}
async function getKrakenSymbol([symbol,pair]) {
  const intervals={};
  for(const interval of Object.keys(KRAKEN_INTERVALS))
    intervals[interval]=await krakenOHLC(pair,interval);
  const last=intervals["1h"].in_progress||intervals["1h"].last_closed;
  return [symbol,{source_pair:pair,last_price_usd:last.close,
    price_source:"latest Kraken 1H candle close (not Revolut execution price)",intervals}];
}
async function collectKraken() {
  const pairs=await Promise.all(Object.entries(KRAKEN_PAIRS).map(getKrakenSymbol));
  const symbols=Object.fromEntries(pairs),alerts=[];
  for(const [symbol,entry] of pairs) {
    const c=entry.intervals["4h"].in_progress;
    if(!c)continue;
    const threshold=symbol==="BTCUSD"?3:4.5;
    if(Math.abs(c.change_pct)>=threshold)
      alerts.push({symbol,type:"4h_movement_in_progress",
        change_pct:c.change_pct,threshold_pct:threshold,candle_open_utc:c.open_time_utc});
    if(c.open_candle_volume_pace_ratio!==null&&c.open_candle_volume_pace_ratio>=1.8)
      alerts.push({symbol,type:"4h_unusual_volume_pace_in_progress",
        volume_pace_ratio:c.open_candle_volume_pace_ratio,threshold_ratio:1.8,
        candle_open_utc:c.open_time_utc});
  }
  return {schema_version:2,snapshot_utc:iso(Date.now()),
    market:"Kraken spot / USD (NOT Binance USDT or Revolut X)",
    source:"Kraken public REST OHLC",data_type:"on-demand REST snapshot, not WebSocket",
    symbols,alerts,volume_method:"base asset volume; quote USD volume estimated from base volume times candle VWAP",
    signal_disclaimer:"Market source differs from GitHub Binance USDT. Never merge volume profiles. Thresholds do not imply a trade."};
}

async function diagnostics() {
  const checks = [];
  for (const [name, url] of [
    ["kraken_time", "https://api.kraken.com/0/public/Time"],
    ["kraken_btc_4h", "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=240"],
    ["kraken_eth_4h", "https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=240"],
    ["kraken_sol_4h", "https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=240"]
  ]) {
    try {
      const response = await fetch(url, {headers:{"Accept":"application/json"},signal:AbortSignal.timeout(8000)});
      const body = await response.text();
      let apiError=null, rows=null;
      try {
        const parsed=JSON.parse(body);
        apiError=parsed?.error||null;
        rows=Object.entries(parsed?.result||{}).find(([k,v])=>k!=="last"&&Array.isArray(v))?.[1]?.length ?? null;
      } catch (_) {}
      checks.push({name,http_status:response.status,ok:response.ok,
        api_error:apiError,rows,body_prefix:body.startsWith("{")?null:body.slice(0,100)});
    } catch(err) {
      checks.push({name,ok:false,error:String(err).slice(0,180)});
    }
  }
  const pairValidation = [];
  for (const [symbol,pair] of Object.entries(KRAKEN_PAIRS)) {
    for (const interval of Object.keys(KRAKEN_INTERVALS)) {
      try {
        const value=await krakenOHLC(pair,interval);
        pairValidation.push({symbol,interval,ok:true,
          last_closed_utc:value.last_closed.open_time_utc,
          in_progress_utc:value.in_progress?.open_time_utc??null});
      } catch(e) {
        pairValidation.push({symbol,interval,ok:false,error:String(e).slice(0,270)});
      }
    }
  }
  let collector = {ok:false};
  try {
    const snapshot=await collectKraken();
    collector={ok:true,market:snapshot.market,symbols:Object.keys(snapshot.symbols)};
  } catch(e) {collector={ok:false,error:String(e).slice(0,270)};}
  return {diagnostics_version:"kraken-2026-11-09-v2",
    snapshot_utc:iso(Date.now()),service:"alfa-market-data",
    checks,pairValidation,collector,git_backup:"separate",
    purpose:"diagnostics only, not a trading signal"};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return reply({error:"method_not_allowed"}, 405);
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
    if (url.pathname !== "/latest.json") return reply({name:"ALFA Market Feed",source:"Kraken Spot USD",version:"kraken-2026-11-09-v2",routes:["/latest.json","/health","/diagnostics"]});
    try { return reply(await latest(env)); }
    catch(e) {
      console.error("live snapshot failed", String(e));
      return reply({error:"market_data_unavailable",snapshot_utc:null,
        note:"No stale snapshot returned as current; GitHub backup remains separate."},503);
    }
  },
  async scheduled(_controller,env,_ctx) {
    const snap = await collectKraken();
    await store(env, snap);
    console.log("ALFA Cron", snap.snapshot_utc, "KV configured:", !!env?.ALFA_KV);
  }
};
