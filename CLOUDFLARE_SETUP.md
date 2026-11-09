# ALFA Market Feed — stan operacyjny 09.11.2026

**Wdrożony** Cloudflare Worker: `alfa-market-data`, połączony z GitHubem `mateuszkluskamk-max/alfa-market-data`.

## Produkcja

- Publiczny endpoint: https://alfa-market-data.mateuszkluska-mk.workers.dev/latest.json
- Test statusu: https://alfa-market-data.mateuszkluska-mk.workers.dev/health
- Test techniczny: https://alfa-market-data.mateuszkluska-mk.workers.dev/diagnostics
- Źródło podstawowe: **Bitstamp spot USD** dla BTC/USD, ETH/USD, SOL/USD.
- Źródło awaryjne: **Kraken spot USD**; awaria Bitstamp powoduje próbę całego snapshotu z Kraken, **bez mieszania giełd wewnątrz jednej migawki**.
- 1H pobierane bezpośrednio z giełdy. 4H i 1D agregowane lokalnie z 1H według pełnych godzin UTC.
- `snapshot_utc` to czas pobrania; `closed` rozróżnia zamknięte świece od bieżących, otwartych. `last_price_usd` jest ostatnią ceną zamknięcia świecy 1H dostępnej w odczycie, **nie ceną BID/ASK Revolut X**.
- `volume_base` to wolumen aktywa. `volume_quote_usd_estimate` jest orientacyjny (Bitstamp: średnia typowa (H+L+C)/3 × wolumen; Kraken: VWAP × wolumen). `trades=null` dla Bitstamp oznacza brak danych, nie zero transakcji.
- Bufor: 120 sekund. Odczyt w krótkim odstępie może zwrócić tę samą migawkę; dla oceny aktualności używaj `snapshot_utc`, **nie** wyłącznie `data_age_seconds`.

## Weryfikacja

9.11.2026 godz. 20:24 CET: GitHub Actions `Probe ALFA Cloudflare Worker` zweryfikował HTTP 200, świeży `snapshot_utc` (opóźnienie ~0,14 s), wszystkie trzy aktywa i interwały 1H/4H/1D. Publiczny dostęp z niektórych narzędzi ChatGPT nadal może być blokowany. Testy kodu w `Validate ALFA Market Feed` są niezależne od testów żywego API.

## Istotne ograniczenia

1. GitHub Actions `ALFA Market Data Snapshot` wciąż prowadzi osobne archiwum Binance USDT i może uruchamiać się znacznie rzadziej niż co 5 minut (best effort).
2. Cloudflare ma cron co 5 minut, ale gdy nie podłączono przestrzeni KV (`ALFA_KV`), cron **nie zapisuje danych** i nie obciąża dostawcy bez potrzeby. Główny endpoint działa **na żądanie**, co ogranicza ryzyko przekroczenia limitów giełdowych.
3. Jeśli wymagane są udokumentowane migawki co 5 minut niezależnie od zapytań, trzeba podłączyć Cloudflare KV do nazwy `ALFA_KV`, sprawdzić limity darmowego planu i potwierdzić zapisy. Sam cron nie stanowi gwarancji wykonania punktualnie.
4. Automatyzacje ChatGPT skanujące rynek działają według swojego harmonogramu i mogą nie mieć bezpośredniego dostępu do `workers.dev`. W takim przypadku oznacz Cloudflare jako niedostępne i korzystaj z GitHub, zamiast przedstawiać stare dane jako nowe.
5. Żadne źródło danych nie składa zleceń. Inwestor zatwierdza i wykonuje transakcje samodzielnie. Bez dźwigni.

## Rozbudowa i diagnostyka

- Kod: `src/index.js`; konfiguracja: `wrangler.jsonc`.
- Automatyczne testy: `.github/workflows/validate-worker.yml` oraz `.github/workflows/probe-worker.yml`.
- W razie awarii sprawdź kolejno: Cloudflare Workers → Wdrożenia, GitHub → Actions, `/health`, `/diagnostics`. Brak świeżych danych = **STALE/N/D**, nie HOLD wywiedziony z nieaktualnego wykresu.
- Dla ograniczenia niepotrzebnych wdrożeń aktualizacje pliku `data/latest.json` w GitHub mają prefiks commit `[skip ci]`.
- Nie publikuj tutaj żadnych kluczy API, prywatnych potwierdzeń transakcji, sald ani danych osobowych.
