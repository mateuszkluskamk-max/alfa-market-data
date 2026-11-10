import assert from "node:assert/strict";
import {analyzeDirectionalRadar,mergeSignalWindow} from "../src/radar.js";

const H=3_600_000;
const now=Date.parse("2026-11-10T20:32:00Z");
const current=Math.floor(now/H)*H;
function fixture(direction, options={}) {
  const count=90,base=current-(count-1)*H;
  const rows=Array.from({length:count},(_,i)=>[
    Math.floor((base+i*H)/1000),100,101,99,100,100,100,null
  ]);
  const lastClosed=rows.at(-2);
  lastClosed[1]=100;
  lastClosed[4]=direction==="UP"?102:direction==="DOWN"?98:100;
  lastClosed[2]=direction==="UP"?102.5:101;
  lastClosed[3]=direction==="DOWN"?97.5:99;
  lastClosed[6]=options.volume??260;
  const c4=options.four ?? 0;
  const v4=options.fourVol ?? 1;
  const i4={
    open_time_utc:"2026-11-10T16:00:00.000Z",
    high:103,low:97,open:100,close:100+c4,
    change_pct:c4,volume_ratio_median20:v4,closed:true
  };
  const inter={
    "1h":{last_closed:{closed:true},in_progress:null},
    "4h":{last_closed:i4,in_progress:null}
  };
  return {rows,inter};
}
function get(dir,params={}) {
  const x=fixture(dir,params);
  return analyzeDirectionalRadar(params.symbol??"BTCUSD",x.rows,x.inter,now);
}

let down=get("DOWN");
assert.equal(down.status,"DOWN");
assert.ok(down.signals.find(s=>s.direction==="DOWN"));
assert.ok(down.signals.some(s=>s.kind==="1H_RANGE_BREAK_12H"||s.kind==="1H_IMPULSE_VOLUME"));
assert.ok(down.signals.every(s=>s.severity==="WATCH"));
assert.ok(down.signals.every(s=>s.confirmed));
assert.ok(down.metrics.closed_1h_vol_ratio20>=2.5);
assert.equal(down.metrics.previous_12h_low,99);

let up=get("UP");
assert.equal(up.status,"UP");
assert.ok(up.signals.some(s=>s.direction==="UP"));
assert.ok(up.signals.some(s=>s.kind==="1H_RANGE_BREAK_12H"));
assert.ok(up.signals.every(s=>s.severity==="WATCH"));

let noVolume=get("DOWN",{volume:100});
assert.equal(noVolume.status,"NEUTRAL","price move alone not enough to flag 1H under threshold without volume");

let confirmedDown=get("DOWN",{four:-2,fourVol:2.4});
assert.ok(confirmedDown.signals.some(s=>s.kind==="4H_CONFIRMED_PRESSURE"&&s.severity==="ALERT"&&s.direction==="DOWN"));
let confirmedUp=get("UP",{four:2.1,fourVol:2});
assert.ok(confirmedUp.signals.some(s=>s.kind==="4H_CONFIRMED_PRESSURE"&&s.severity==="ALERT"&&s.direction==="UP"));

let etherDown=get("DOWN",{symbol:"ETHUSD",four:-2.5,fourVol:2.1});
assert.ok(etherDown.signals.some(s=>s.severity==="ALERT"&&s.direction==="DOWN"));
let etherUp=get("UP",{symbol:"ETHUSD",four:2.5,fourVol:2.1});
assert.ok(etherUp.signals.some(s=>s.severity==="ALERT"&&s.direction==="UP"));

{
  const x=fixture("NEUTRAL",{volume:100});
  const currentAnchor=new Date(current).toISOString();
  x.inter["1h"].in_progress={
    open_time_utc:currentAnchor,open:100,close:101,high:101.2,low:99.7,
    change_pct:1,open_candle_volume_pace_ratio:2
  };
  const y=analyzeDirectionalRadar("BTCUSD",x.rows,x.inter,now);
  const early=y.signals.find(z=>z.kind==="1H_EARLY_IMPULSE");
  assert.ok(early,"early unfinished 1H candle should be flagged if enough minutes have elapsed");
  assert.equal(early.confirmed,false);
  assert.equal(early.direction,"UP");
}
{
  const x=fixture("NEUTRAL",{volume:100});
  x.inter["4h"].in_progress={
    open_time_utc:"2026-11-10T20:00:00.000Z",open:100,close:96.8,
    low:96.5,high:100.5,change_pct:-3.2,
    open_candle_volume_pace_ratio:1.9
  };
  const y=analyzeDirectionalRadar("BTCUSD",x.rows,x.inter,now);
  assert.ok(y.signals.some(z=>z.kind==="4H_UNCONFIRMED_SHOCK"&&z.severity==="ALERT"&&!z.confirmed));
}
{
  const x=fixture("UP");
  x.rows.at(-3)[0]+=1800; // gap in 1H bars
  assert.throws(()=>analyzeDirectionalRadar("BTCUSD",x.rows,x.inter,now),/chronology gap/);
}
{
  const x=fixture("DOWN");
  x.rows.at(-2)[6]=-10;
  assert.throws(()=>analyzeDirectionalRadar("BTCUSD",x.rows,x.inter,now),/Non-finite|Invalid/);
}
{
  const a="2026-11-10T15:00:00Z";
  const b="2026-11-10T15:05:00Z";
  const c="2026-11-10T21:06:00Z";
  const sig={...down.signals[0],event_id:"BTCUSD|DOWN|early|2026-11-10T14:00:00Z"};
  const first=mergeSignalWindow([], [sig], a, "Bitstamp spot / USD");
  assert.equal(first.length,1);
  assert.equal(first[0].active_now,true);
  assert.equal(first[0].seen_snapshots,1);
  const second=mergeSignalWindow(first,[],b,"Bitstamp spot / USD");
  assert.equal(second[0].active_now,false,"short-lived signal remains in six-hour ledger");
  assert.equal(second[0].first_seen_utc,a);
  const reactivated=mergeSignalWindow(second,[sig],b,"Bitstamp spot / USD");
  assert.equal(reactivated[0].seen_snapshots,2);
  const crossVenue=mergeSignalWindow(reactivated,[sig],b,"Kraken spot / USD");
  assert.equal(crossVenue.length,2,"venue change does not blend duplicate event IDs");
  const expired=mergeSignalWindow(second,[],c,"Bitstamp spot / USD");
  assert.equal(expired.length,0,"expired events removed");
}
console.log("PASS: ALFA radar DOWN/UP WATCH & ALERT, volume filters, 1H range breakout, open-candle caution, missing-hour guards");
