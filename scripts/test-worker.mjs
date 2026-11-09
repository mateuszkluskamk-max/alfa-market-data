import assert from "node:assert/strict";
import feed from "../src/index.js";

const bars = {"1h":3600000,"4h":14400000,"1d":86400000};
let calls = 0;
let unreachable = false;
globalThis.fetch = async (url) => {
  calls++;
  if (unreachable) throw new Error("provider offline");
  const u = new URL(url);
  const symbol = u.searchParams.get("symbol");
  assert.ok(["BTCUSDT","ETHUSDT","SOLUSDT"].includes(symbol));
  if (u.pathname.endsWith("/ticker/price"))
    return new Response(JSON.stringify({symbol,price:"100"}),{status:200});
  const interval = u.searchParams.get("interval");
  const dur = bars[interval];
  assert.ok(dur);
  const first = Math.floor(Date.now()/dur)*dur - 54*dur;
  const klines = Array.from({length:55}, (_,i)=>{
    const begin = first + i*dur;
    return [begin,"100","101","99","100","100",begin+dur-1,"10000",4000,"50","5000","0"];
  });
  return new Response(JSON.stringify(klines),{status:200});
};
const data = {};
const env = {ALFA_KV:{
  async get(k){return data[k]?JSON.parse(data[k]):null;},
  async put(k,v){data[k]=v;}
}};
const api = (path)=>new Request("https://alfa.test"+path);
let response = await feed.fetch(api("/latest.json"),env);
assert.equal(response.status,200);
let body=await response.json();
assert.equal(body.delivery,"fresh_market_fetch");
assert.equal(Object.keys(body.symbols).length,3);
assert.ok(body.symbols.BTCUSDT.intervals["4h"].last_closed.closed);
assert.ok(!body.symbols.BTCUSDT.intervals["4h"].in_progress.closed);
assert.ok(body.snapshot_utc);
const callsAfterFirst=calls;
response=await feed.fetch(api("/latest.json"),env);
body=await response.json();
assert.equal(body.delivery,"cloudflare_kv");
assert.equal(calls,callsAfterFirst);
response=await feed.fetch(api("/health"),env);
assert.equal((await response.json()).status,"fresh");
await feed.scheduled({},env,{});
assert.ok(calls>callsAfterFirst);
unreachable=true;
response=await feed.fetch(api("/latest.json"),{});
assert.equal(response.status,503);
assert.equal((await response.json()).error,"market_data_unavailable");
console.log("PASS: on-demand, three markets, 1H/4H/1D, KV cache, health, cron, failure");
