import assert from "node:assert/strict";
import feed from "../src/index.js";

let calls=0,unreachable=false;
globalThis.fetch = async (url) => {
  calls++;
  if(unreachable)throw new Error("public provider offline");
  const u=new URL(url);
  assert.equal(u.hostname,"www.bitstamp.net");
  assert.ok(u.pathname.startsWith("/api/v2/ohlc/"));
  const pair=u.pathname.split("/")[4];
  assert.ok(["btcusd","ethusd","solusd"].includes(pair));
  assert.equal(u.searchParams.get("step"),"3600");
  const dur=3600000;
  const count=24*28;
  const first=Math.floor(Date.now()/dur)*dur-(count-1)*dur;
  const rows=Array.from({length:count},(_,i)=>{
    const t=first+i*dur;
    return {timestamp:String(Math.floor(t/1000)),
      open:"100",high:"101",low:"99",close:"100",volume:"100"};
  });
  return new Response(JSON.stringify({data:{pair:pair.toUpperCase(),ohlc:rows}}),{status:200});
};
const storage={};
let writes=0;
const env={ALFA_KV:{
  async get(key){return storage[key]?JSON.parse(storage[key]):null;},
  async put(key,value,opts){writes++;storage[key]=value;assert.ok(!key.startsWith("archive:")||opts.expirationTtl===14*86400);},
  async list({prefix,limit}){const keys=Object.keys(storage).filter(k=>k.startsWith(prefix)).sort().slice(0,limit).map(name=>({name}));return {keys,list_complete:true};}
}};
const request=(p)=>new Request("https://alfa.test"+p);
let response=await feed.fetch(request("/latest.json"),env);
assert.equal(response.status,200);
let data=await response.json();
assert.equal(data.schema_version,4);
assert.ok(data.market.includes("Bitstamp spot / USD"));
assert.deepEqual(Object.keys(data.symbols).sort(),["BTCUSD","ETHUSD","SOLUSD"]);
assert.equal(data.symbols.BTCUSD.last_price_usd,100);
assert.equal(data.symbols.BTCUSD.intervals["4h"].last_closed.trades,null,"Bitstamp does not expose count of trades");
assert.ok(data.symbols.BTCUSD.intervals["1h"].last_closed.closed);
assert.ok(data.symbols.BTCUSD.intervals["4h"].last_closed.closed);
assert.ok(data.symbols.BTCUSD.intervals["1d"].last_closed.closed);
assert.ok(!data.symbols.BTCUSD.intervals["4h"].in_progress.closed);
assert.equal(data.symbols.BTCUSD.intervals["4h"].in_progress.volume_quote_usd_estimate,10000 * (Math.floor((Date.now()%14400000)/3600000)+1));
assert.ok(data.source.includes("aggregated UTC"));
assert.equal(data.delivery,"fresh_market_fetch");
assert.equal(calls,3,"exactly three upstream API calls per uncached snapshot");
const callsBeforeCache=calls;
response=await feed.fetch(request("/latest.json"),env);
data=await response.json();
assert.equal(data.delivery,"fresh_market_fetch","on-demand must not write KV");
assert.equal(writes,0,"zero KV writes until cron");
assert.equal(calls,callsBeforeCache);
await feed.scheduled({},env,{});
assert.equal(writes,2,"cron stores latest and one history key");
assert.ok(Object.keys(storage).some(k=>k.startsWith("archive:v1:")));
response=await feed.fetch(request("/latest.json"),env);
data=await response.json();
assert.equal(data.delivery,"cloudflare_kv");
assert.equal(data.stored_by,"cloudflare_cron");
response=await feed.fetch(request("/health"),env);
assert.equal((await response.json()).status,"fresh");
response=await feed.fetch(request("/history.json"),env);
assert.equal(response.status,200);
assert.equal((await response.json()).count,1);
response=await feed.fetch(request("/history.json?date=not-a-date"),env);
assert.equal(response.status,400);
response=await feed.fetch(request("/history.json"),{});
assert.equal(response.status,503);
unreachable=true;
response=await feed.fetch(request("/latest.json"),{});
assert.equal(response.status,200,"memo cache serves successful recent snapshot");
const diagnostics=await feed.fetch(request("/diagnostics"),env);
assert.equal((await diagnostics.json()).collector.ok,true);
console.log("PASS: Bitstamp 1H→4H/1D, KV cron-only quota 2 writes/run, history, health, diagnostics");
