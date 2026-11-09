#!/usr/bin/env python3
"""ALFA Market Data — public Binance spot snapshots. No account or API key required."""
import json
import math
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
INTERVALS_MS = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
HOSTS = ("https://data-api.binance.vision", "https://api.binance.com")
DATA_DIR = Path("data")
CANDLES_TO_KEEP = 120


def utc_iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def fetch_json(path, params):
    query = urlencode(params)
    failures = []
    for host in HOSTS:
        url = host + path + "?" + query
        try:
            req = Request(url, headers={"User-Agent": "ALFA-Market-Data/1.0", "Accept": "application/json"})
            with urlopen(req, timeout=16) as response:
                if response.status != 200:
                    raise ValueError("HTTP " + str(response.status))
                return json.load(response)
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as err:
            failures.append(host + ": " + str(err))
            time.sleep(0.5)
    raise RuntimeError("Binance public market-data request failed: " + " | ".join(failures))


def positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError("Invalid positive market value")
    return number


def nonnegative(value):
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError("Invalid nonnegative market value")
    return number


def build_candles(rows, interval, now_ms):
    if not isinstance(rows, list) or len(rows) < 25:
        raise ValueError("Too few candles for " + interval)
    result = []
    prev_open = None
    for i, k in enumerate(rows):
        if not isinstance(k, list) or len(k) < 11:
            raise ValueError("Malformed kline")
        opened, ended = int(k[0]), int(k[6])
        op, hi, lo, cl = (positive(k[j]) for j in (1, 2, 3, 4))
        base, quote = nonnegative(k[5]), nonnegative(k[7])
        if lo > min(op, cl) or hi < max(op, cl) or ended != opened + INTERVALS_MS[interval] - 1:
            raise ValueError("Invalid OHLCV/time")
        if prev_open is not None and opened - prev_open != INTERVALS_MS[interval]:
            raise ValueError("Missing or duplicated candles: " + interval)
        prev_open = opened
        previous = rows[max(0, i - 20):i]
        median = statistics.median(float(r[7]) for r in previous) if len(previous) == 20 else None
        ratio = quote / median if median and median > 0 else None
        is_closed = ended < now_ms
        elapsed_ms = max(0, min(now_ms - opened, INTERVALS_MS[interval]))
        elapsed_fraction = elapsed_ms / INTERVALS_MS[interval]
        pace = ratio / elapsed_fraction if (not is_closed and ratio is not None and elapsed_ms >= 600_000) else None
        result.append({
            "open_time_utc": utc_iso(opened),
            "close_time_utc": utc_iso(ended),
            "open": op, "high": hi, "low": lo, "close": cl,
            "volume_base": base, "volume_quote_usdt": quote,
            "trades": int(k[8]), "closed": is_closed,
            "change_pct": round((cl / op - 1) * 100, 3),
            "volume_ratio_median20": round(ratio, 3) if ratio is not None else None,
            "open_candle_volume_pace_ratio": round(pace, 3) if pace is not None else None,
        })
    last = result[-1]
    if last["closed"] and now_ms - int(rows[-1][6]) > 120_000:
        raise ValueError("Latest candle is unexpectedly stale: " + interval)
    if int(rows[-1][0]) > now_ms + 15_000:
        raise ValueError("Candle starts in the future")
    return result[-CANDLES_TO_KEEP:]


def main():
    snapshot_ms = int(time.time() * 1000)
    latest = {
        "schema_version": 1,
        "snapshot_utc": utc_iso(snapshot_ms),
        "market": "Binance spot / USDT (not Revolut X)",
        "data_type": "scheduled REST snapshot, not a continuous live stream",
        "symbols": {},
        "alerts": [],
        "signal_disclaimer": "Thresholds are informational, not BUY/SELL signals.",
    }
    histories = {}
    for symbol in SYMBOLS:
        print("Fetching", symbol, flush=True)
        ticker = fetch_json("/api/v3/ticker/price", {"symbol": symbol})
        if not isinstance(ticker, dict) or ticker.get("symbol") != symbol:
            raise ValueError("Invalid ticker response for " + symbol)
        price = positive(ticker["price"])
        entry = {"last_price_usdt": price, "intervals": {}}
        for interval in INTERVALS_MS:
            raw = fetch_json("/api/v3/klines", {"symbol": symbol, "interval": interval, "limit": 150})
            candles = build_candles(raw, interval, int(time.time() * 1000))
            histories[f"{symbol}_{interval}.json"] = {
                "symbol": symbol, "interval": interval, "source": "Binance spot USDT",
                "snapshot_utc": latest["snapshot_utc"], "candles": candles,
            }
            closed = next((c for c in reversed(candles) if c["closed"]), None)
            current = candles[-1] if not candles[-1]["closed"] else None
            if closed is None:
                raise ValueError("No closed candle")
            entry["intervals"][interval] = {
                "last_closed": closed,
                "in_progress": current,
            }
            if interval == "4h" and current is not None:
                threshold = 3.0 if symbol == "BTCUSDT" else 4.5
                if abs(current["change_pct"]) >= threshold:
                    latest["alerts"].append({
                        "symbol": symbol, "type": "4h_movement_in_progress",
                        "change_pct": current["change_pct"], "threshold_pct": threshold,
                        "candle_open_utc": current["open_time_utc"],
                    })
                pace = current["open_candle_volume_pace_ratio"]
                if pace is not None and pace >= 1.8:
                    latest["alerts"].append({
                        "symbol": symbol, "type": "4h_unusual_volume_pace_in_progress",
                        "volume_pace_ratio": pace, "threshold_ratio": 1.8,
                        "candle_open_utc": current["open_time_utc"],
                    })
        candle = entry["intervals"]["1h"]["in_progress"]
        if candle and abs(price / candle["close"] - 1) > 0.03:
            raise ValueError("Ticker and latest candle price disagree by over 3%: " + symbol)
        latest["symbols"][symbol] = entry
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / "history").mkdir(exist_ok=True)
    for filename, payload in histories.items():
        (DATA_DIR / "history" / filename).write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
        )
    (DATA_DIR / "latest.json").write_text(
        json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("SUCCESS:", latest["snapshot_utc"], "alerts:", len(latest["alerts"]))


if __name__ == "__main__":
    main()
