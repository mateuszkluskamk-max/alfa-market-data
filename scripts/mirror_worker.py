#!/usr/bin/env python3
"""Mirror public Cloudflare crypto OHLCV for connected GitHub readers.

Fail closed: never overwrite the last valid snapshot with stale/partial data.
No credentials, account data or trades.
"""
import json
import math
import subprocess
from datetime import datetime, timezone
from pathlib import Path

URL = "https://alfa-market-data.mateuszkluska-mk.workers.dev/latest.json"
OUT = Path("data/cloudflare_latest.json")
SYMBOLS = ("BTCUSD", "ETHUSD", "SOLUSD")
INTERVALS = ("1h", "4h", "1d")


def fetch():
    cmd = ["curl", "--fail-with-body", "--silent", "--show-error",
           "--max-time", "50", "-H", "Accept: application/json", URL]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True)
    return json.loads(result.stdout)


def check(payload):
    if not isinstance(payload, dict) or int(payload.get("schema_version", 0)) < 4:
        raise ValueError("Unexpected Cloudflare schema")
    if not str(payload.get("market", "")).startswith(("Bitstamp spot / USD", "Kraken spot / USD")):
        raise ValueError("Market source is not an approved spot USD venue")
    when = datetime.fromisoformat(payload["snapshot_utc"].replace("Z", "+00:00"))
    age = (datetime.now(timezone.utc) - when).total_seconds()
    if not -10 <= age <= 300:
        raise ValueError(f"Cloudflare snapshot stale or from future: {age:.1f}s")
    assets = payload.get("symbols")
    if not isinstance(assets, dict) or set(assets) != set(SYMBOLS):
        raise ValueError("BTCUSD/ETHUSD/SOLUSD not all present")
    for symbol in SYMBOLS:
        x = assets[symbol]
        value = float(x["last_price_usd"])
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"Invalid USD price: {symbol}")
        intervals = x.get("intervals")
        if set(intervals) != set(INTERVALS):
            raise ValueError(f"Intervals missing: {symbol}")
        for interval in INTERVALS:
            candle = intervals[interval]["last_closed"]
            if candle.get("closed") is not True:
                raise ValueError(f"Last closed candle unconfirmed: {symbol} {interval}")
            for key in ("open", "high", "low", "close", "volume_base"):
                n = float(candle[key])
                if not math.isfinite(n) or n < 0:
                    raise ValueError(f"Bad OHLCV: {symbol} {interval} {key}")
    return age


def main():
    data = fetch()
    age = check(data)
    data["mirrored_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    data["mirror_note"] = "Copied from Cloudflare by GitHub Action; snapshot_utc is market observation time."
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("CLOUDFLARE MIRROR OK",data["snapshot_utc"],f"age={age:.1f}s",
          "market=",data["market"],"symbols=",list(data["symbols"]))


if __name__ == "__main__":
    main()
