import assert from "node:assert/strict";
import feed from "../src/index.js";

let calls=0,unreachable=false;
globalThis.fetch = async (url) => {
  calls++;
  if(unreachable)throw new Error("public provider offline");
  const u=new URL(url);
  assert.equal(u.hostname,"api.kraken.com");
  assert.equal(u.pathname,"/0/public/OHLC");
  const pair=u.searchParams.get("pair");
  assert.ok(["XBTUSD","ETHUSD","SOLUSD"].includes(pair));
  assert.equal(u.searchParams.get("interval"),"60");
  const dur=3600000;
  const count=24*28;
  const first=Math.floor(Date.now()/dur)*dur-(count-1)*dur;
  const rows=Array.from({length:count},(_,i)=>{
    const t=first+i*dur;
    return [Math.floor(t/1000),"100","101","99","100","100","100",4000];
  });
  return new Response(JSON.stringify({error:[],result:{[pair]:rows,last:rows.at(-1)[0]}}),{status:200});
};
const storage={};
const env={ALFA_KV:{
  async get(key){return storage[key]?JSON.parse(storage[key]):null;},
  async put(key,value){storage[key]=value;}
}};
const request=(p)=>new Request("https://alfa.test"+p);
let response=await feed.fetch(request("/latest.json"),env);
assert.equal(response.status,200);
let data=await response.json();
assert.equal(data.schema_version,3);
assert.ok(data.market.includes("Kraken spot / USD"));
assert.deepEqual(Object.keys(data.symbols).sort(),["BTCUSD","ETHUSD","SOLUSD"]);
assert.equal(data.symbols.BTCUSD.last_price_usd,100);
assert.ok(data.symbols.BTCUSD.intervals["1h"].last_closed.closed);
assert.ok(data.symbols.BTCUSD.intervals["4h"].last_closed.closed);
assert.ok(data.symbols.BTCUSD.intervals["1d"].last_closed.closed);
assert.ok(!data.symbols.BTCUSD.intervals["4h"].in_progress.closed);
assert.equal(data.symbols.BTCUSD.intervals["4h"].in_progress.volume_quote_usd_estimate,10000 * (Math.floor((Date.now()%14400000)/3600000)+1));
assert.ok(data.source.includes("aggregated on UTC"));
assert.equal(data.delivery,"fresh_market_fetch");
assert.equal(calls,3,"exactly three upstream API calls per uncached snapshot");
const callsBeforeCache=calls;
response=await feed.fetch(request("/latest.json"),env);
data=await response.json();
assert.equal(data.delivery,"cloudflare_kv");
assert.equal(calls,callsBeforeCache);
response=await feed.fetch(request("/health"),env);
assert.equal((await response.json()).status,"fresh");
await feed.scheduled({},env,{});
assert.ok(Object.keys(storage).length>=1);
unreachable=true;
response=await feed.fetch(request("/latest.json"),{});
assert.equal(response.status,200,"memo cache serves successful recent snapshot");
const diagnostics=await feed.fetch(request("/diagnostics"),env);
assert.equal((await diagnostics.json()).collector.ok,true);
console.log("PASS: Kraken three calls, UTC 1H→4H/1D, schema, KV/memo, cron, diagnostics");
