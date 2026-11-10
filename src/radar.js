// ALFA v1.6 directional early-warning radar — experimental, NOT a trading engine.
// Works exclusively on one exchange's 1H OHLCV rows and its own aggregated 4H.
// No hindsight: only rows/candles available at calculation time; no prediction claims.
const HOUR=3_600_000;
const BASE = {
  BTCUSD: {one:0.65,three:1.15,four:1.5,shock:3,day:2.5},
  ETHUSD: {one:1.0,three:1.75,four:2.2,shock:4.5,day:4},
  SOLUSD: {one:1.5,three:2.5,four:2.9,shock:4.5,day:5.5}
};
function num(x) {
  const n=Number(x);
  if(!Number.isFinite(n))throw Error("Non-finite OHLCV number");
  return n;
}
function med20(xs) {
  if(xs.length!==20)return null;
  const a=xs.slice().sort((x,y)=>x-y);
  const m=(a[9]+a[10])/2;
  return m>0?m:null;
}
function round(x,n=3) {return +x.toFixed(n);}
function pct(a,b) {return (a/b-1)*100;}
function iso(ms) {return new Date(ms).toISOString();}
function classify(x) {return x<0?"DOWN":"UP";}
function pushCandidate(candidates, {
  symbol,direction,severity,kind,interval,changePct,volumeRatio,
  anchor,confirmed,referencePrice,invalidPrice,priority,explanation
}) {
  const id=[symbol,direction,kind,anchor].join("|");
  candidates.push({
    event_id:id,symbol,direction,severity,kind,interval,
    change_pct:round(changePct),volume_ratio_median20:volumeRatio===null?null:round(volumeRatio),
    candle_open_utc:anchor,confirmed,
    reference_price_usd:round(referencePrice,5),
    observation_level_usd:round(invalidPrice,5),
    observation_level_note:"Reference structure only; not a stop-loss or executable order",
    explanation,
    _priority:priority
  });
}
// rows: Kraken/Bitstamp normalized [epoch_sec,O,H,L,C,hourly_vwap,base_volume,trades]
// intervals are the existing validated 1h/4h/1d representation for the SAME venue.
export function analyzeDirectionalRadar(symbol,rows,intervals,nowMs=Date.now()) {
  const cfg=BASE[symbol];
  if(!cfg)throw Error("Unknown radar symbol: "+symbol);
  if(!Array.isArray(rows)||rows.length<65)throw Error("Insufficient hourly rows for radar");
  const parsed=rows.map(r=>{
    const item={t:num(r[0])*1000,o:num(r[1]),h:num(r[2]),l:num(r[3]),
      c:num(r[4]),v:num(r[6])};
    if(item.v<0||item.o<=0||item.c<=0||item.l<=0||item.h<=0||
       item.l>Math.min(item.o,item.c)||item.h<Math.max(item.o,item.c))
      throw Error("Invalid hourly radar OHLCV");
    return item;
  }).filter(r=>r.t<=nowMs);
  for(let i=1;i<parsed.length;i++)
    if(parsed[i].t-parsed[i-1].t!==HOUR)throw Error("Radar 1H chronology gap");
  const closed=parsed.filter(r=>r.t+HOUR<=nowMs);
  const latest=closed.at(-1);
  if(!latest||closed.length<60||nowMs-latest.t>2*HOUR+120_000)
    throw Error("Radar latest closed 1H missing/stale");
  const prev=closed.at(-2);
  const baseline=med20(closed.slice(-21,-1).map(r=>r.v));
  const volRatio=baseline?latest.v/baseline:null;
  const move1=pct(latest.c,latest.o);
  const move3=pct(latest.c,closed.at(-3).o);
  const move24=pct(latest.c,closed.at(-25).c);
  const previous12=closed.slice(-13,-1);
  const previousHigh=Math.max(...previous12.map(r=>r.h));
  const previousLow=Math.min(...previous12.map(r=>r.l));
  const last4=intervals["4h"]?.last_closed;
  if(!last4?.closed)throw Error("Radar 4H closed candle missing");
  const prior4Pct=num(last4.change_pct);
  const prior4Vol=last4.volume_ratio_median20===null?null:num(last4.volume_ratio_median20);
  const candidates=[];
  const candleHour=iso(latest.t);
  const candle4=last4.open_time_utc;
  const hourDirection=classify(move1);
  const hourInvalid=hourDirection==="UP"?latest.l:latest.h;
  if(volRatio!==null&&volRatio>=1.4&&Math.abs(move1)>=cfg.one){
    pushCandidate(candidates,{
      symbol,direction:hourDirection,severity:"WATCH",kind:"1H_IMPULSE_VOLUME",
      interval:"1h",changePct:move1,volumeRatio:volRatio,anchor:candleHour,
      confirmed:true,referencePrice:latest.c,invalidPrice:hourInvalid,priority:40,
      explanation:"Closed 1H impulse with above-median venue volume; early pressure, not a forecast"
    });
  }
  // A range break on a CLOSED candle is earlier but can be a false break.
  const brokeUp=latest.c>previousHigh;
  const brokeDown=latest.c<previousLow;
  if(volRatio!==null&&volRatio>=1.3&&Math.abs(move1)>=cfg.one*0.4&&(brokeUp||brokeDown)){
    const up=brokeUp;
    pushCandidate(candidates,{
      symbol,direction:up?"UP":"DOWN",severity:"WATCH",kind:"1H_RANGE_BREAK_12H",
      interval:"1h",changePct:move1,volumeRatio:volRatio,anchor:candleHour,
      confirmed:true,referencePrice:latest.c,
      invalidPrice:up?previousHigh:previousLow,priority:45,
      explanation:"Closed 1H beyond previous 12 closed-hour range; false break possible"
    });
  }
  // Three-hour directional persistence prevents single-wick false positives.
  const last3=closed.slice(-3);
  const upCount=last3.filter(r=>r.c>r.o).length;
  const downCount=last3.filter(r=>r.c<r.o).length;
  const dir3=classify(move3);
  const agree=dir3==="UP"?upCount>=2:downCount>=2;
  if(agree&&Math.abs(move3)>=cfg.three&&volRatio!==null&&volRatio>=1.15){
    pushCandidate(candidates,{
      symbol,direction:dir3,severity:"WATCH",kind:"3H_TREND_ACCELERATION",
      interval:"3h_from_1h",changePct:move3,volumeRatio:volRatio,anchor:candleHour,
      confirmed:true,referencePrice:latest.c,invalidPrice:dir3==="UP"?Math.min(...last3.map(r=>r.l)):Math.max(...last3.map(r=>r.h)),priority:30,
      explanation:"At least 2 of last 3 closed hourly candles in same direction; no guarantee of continuation"
    });
  }
  const dir4=classify(prior4Pct);
  if(prior4Vol!==null&&prior4Vol>=1.8&&Math.abs(prior4Pct)>=cfg.four){
    pushCandidate(candidates,{
      symbol,direction:dir4,severity:"ALERT",kind:"4H_CONFIRMED_PRESSURE",
      interval:"4h",changePct:prior4Pct,volumeRatio:prior4Vol,anchor:candle4,
      confirmed:true,referencePrice:num(last4.close),
      invalidPrice:dir4==="UP"?num(last4.low):num(last4.high),priority:70,
      explanation:"Closed 4H directional pressure with exceptional relative volume; assess risk, not a BUY/SELL"
    });
  }
  // 4H shock on OPEN candle = early, explicitly unconfirmed.
  const open4=intervals["4h"]?.in_progress;
  if(open4){
    const shockPct=num(open4.change_pct);
    const pace=open4.open_candle_volume_pace_ratio===null?null:num(open4.open_candle_volume_pace_ratio);
    if(Math.abs(shockPct)>=cfg.shock&&pace!==null&&pace>=1.2){
      const direction=classify(shockPct);
      pushCandidate(candidates,{
        symbol,direction,severity:"ALERT",kind:"4H_UNCONFIRMED_SHOCK",
        interval:"4h_in_progress",changePct:shockPct,volumeRatio:pace,
        anchor:open4.open_time_utc,confirmed:false,
        referencePrice:num(open4.close),invalidPrice:direction==="UP"?num(open4.low):num(open4.high),priority:75,
        explanation:"Unclosed 4H large move with accelerated volume; prone to reversal"
      });
    }
  }
  // Early within-hour move: only after 12 minutes, using pace not raw partial volume.
  const open1=intervals["1h"]?.in_progress;
  if(open1){
    const elapsed=nowMs-Date.parse(open1.open_time_utc);
    const m=num(open1.change_pct);
    const pace=open1.open_candle_volume_pace_ratio===null?null:num(open1.open_candle_volume_pace_ratio);
    if(elapsed>=12*60_000&&elapsed<HOUR&&Math.abs(m)>=cfg.one&&pace!==null&&pace>=1.7){
      const direction=classify(m);
      pushCandidate(candidates,{
        symbol,direction,severity:"WATCH",kind:"1H_EARLY_IMPULSE",
        interval:"1h_in_progress",changePct:m,volumeRatio:pace,
        anchor:open1.open_time_utc,confirmed:false,referencePrice:num(open1.close),
        invalidPrice:direction==="UP"?num(open1.low):num(open1.high),priority:48,
        explanation:"Open 1H impulse with volume pace; provisional until candle closes"
      });
    }
  }
  // 24H trend persistence is contextual and never described as advance prediction.
  if(Math.abs(move24)>=cfg.day){
    const direction=classify(move24);
    const fourBucket=iso(Math.floor(nowMs/(4*HOUR))*(4*HOUR));
    pushCandidate(candidates,{
      symbol,direction,severity:"WATCH",kind:"24H_PERSISTENT_TREND",
      interval:"24h_closed_1h_comparison",changePct:move24,volumeRatio:null,
      anchor:fourBucket,confirmed:true,referencePrice:latest.c,
      invalidPrice:direction==="UP"?previousLow:previousHigh,priority:10,
      explanation:"24H change based on closed 1H observations; context, NOT early prediction"
    });
  }
  const strongest={};
  for(const signal of candidates){
    const d=signal.direction;
    if(!strongest[d]||signal._priority>strongest[d]._priority)strongest[d]=signal;
  }
  const signals=Object.values(strongest).map(({_priority,...clean})=>clean)
    .sort((a,b)=>(a.severity==="ALERT"?0:1)-(b.severity==="ALERT"?0:1));
  const mainDirection=signals.length===0?"NEUTRAL":signals.length===1?signals[0].direction:"MIXED";
  return {
    version:"directional-v1",status:mainDirection,
    latest_closed_1h_utc:candleHour,latest_closed_4h_utc:candle4,
    metrics:{
      closed_1h_pct:round(move1),closed_1h_vol_ratio20:volRatio===null?null:round(volRatio),
      closed_3h_pct:round(move3),closed_4h_pct:round(prior4Pct),
      closed_4h_vol_ratio20:prior4Vol===null?null:round(prior4Vol),
      closed_24h_pct:round(move24),
      previous_12h_high:round(previousHigh,5),previous_12h_low:round(previousLow,5)
    },
    signals
  };
}
