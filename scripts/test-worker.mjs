import assert from "node:assert/strict";
import feed from "../src/index.js";

const durations = {"60":3600000,"240":14400000,"1440":86400000};
let calls=0,unreachable=false;
globalThis.fetch = async (url) => {
  calls++;
  if(unreachable) throw new Error("public provider offline");
  const u=new URL(url);
  assert.equal(u.hostname,"api.kraken.com");
  assert.equal(u.pathname,"/0/public/OHLC");
  const pair=u.searchParams.get("pair");
  assert.ok(["XBTUSD","ETHUSD","SOLUSD"].includes(pair));
  const dur=durations[u.searchParams.get("interval")];
  assert.ok(dur);
  const first=Math.floor(Date.now()/dur)*dur-54*dur;
  const rows=Array.from({length:55},(_,i)=>{
    const begin=first+i*dur;
    return [Math.floor(begin/1000),"100","101","99","100","100","100",4000];
  });
  return new Response(JSON.stringify({error:[],result:{[pair]:rows,last:rows.at(-1)[0]}}),{status:200});
};
const memory={};
const env={ALFA_KV:{
  async get(key){return memory[key]?JSON.parse(memory[key]):null;},
  async put(key,value){memory[key]=value;}
}};
const request=(p)=>new Request("https://alfa.test"+p);
let response=await feed.fetch(request("/latest.json"),env);
assert.equal(response.status,200);
let data=await response.json();
assert.equal(data.schema_version,2);
assert.ok(data.market.includes("Kraken spot / USD"));
assert.deepEqual(Object.keys(data.symbols).sort(),["BTCUSD","ETHUSD","SOLUSD"]);
assert.equal(data.symbols.BTCUSD.last_price_usd,100);
assert.ok(data.symbols.BTCUSD.intervals["4h"].last_closed.closed);
assert.ok(!data.symbols.BTCUSD.intervals["4h"].in_progress.closed);
assert.equal(data.symbols.BTCUSD.intervals["4h"].in_progress.volume_quote_usd_estimate,10000);
assert.equal(data.source,"Kraken public REST OHLC");
assert.equal(data.delivery,"fresh_market_fetch");
const callsBeforeCache=calls;
response=await feed.fetch(request("/latest.json"),env);
data=await response.json();
assert.equal(data.delivery,"cloudflare_kv");
assert.equal(calls,callsBeforeCache);
response=await feed.fetch(request("/health"),env);
assert.equal((await response.json()).status,"fresh");
await feed.scheduled({},env,{});
assert.ok(calls>callsBeforeCache);
unreachable=true;
response=await feed.fetch(request("/latest.json"),{});
assert.equal(response.status,503);
assert.equal((await response.json()).error,"market_data_unavailable");
console.log("PASS: Kraken USD 1H/4H/1D, schema, KV, cron, health, provider outage, no stale masquerade");
