# ALFA Market Data

Publiczny, testowy zbieracz danych OHLCV. Dane dotyczą **rynku spot Binance (USDT)**, a nie kursów transakcyjnych Revolut X. Repozytorium **nie zawiera sald, historii prywatnych transakcji ani kluczy API**.

## Dane

- `data/latest.json` — ostatni zatwierdzony odczyt BTCUSDT, ETHUSDT, SOLUSDT; bieżąca cena z publicznego REST; ostatnia zamknięta i otwarta świeca 1H / 4H / 1D; informacyjne alerty
- `data/history/BTCUSDT_4h.json` i analogiczne pliki — do 120 ostatnich świec na każdej parze i interwale
- `snapshot_utc` — czas **pobrania**, `open_time_utc`/`close_time_utc` — czas świecy. Flaga `closed` oddziela dane potwierdzone od świecy w toku

**Ważne:** GitHub Actions uruchamia harmonogram orientacyjnie co 5 minut (może się opóźnić lub zostać pominięty). Jest to cykliczny odczyt REST, a **nie strumień WebSocket i nie notowania czasu rzeczywistego**. Przed użyciem sprawdź status workflow, znacznik `snapshot_utc`, kompletność par i wiek danych. Jeśli brakuje danych lub są starsze niż 15 minut, oznacz status STALE i nie wydawaj decyzji na ich podstawie.

## Uruchomienie

1. GitHub → **Actions** → **ALFA Market Data Snapshot** → **Run workflow** (jednorazowy test).
2. Po zielonym przebiegu sprawdź, czy istnieje `data/latest.json` i 9 plików `data/history/*.json`.
3. Dopiero po tym można uznać harmonogram za operacyjny. Jeśli przebieg jest czerwony, otwórz log zadania `snapshot`.
4. GitHub → Settings → Actions → General → **Workflow permissions**: potrzebne `Read and write permissions` dla `GITHUB_TOKEN` (jeśli polityka konta na to pozwala). Brak tego prawa uniemożliwi zapis nowych danych.

Odczyt przez ALFA po weryfikacji wykonania: https://raw.githubusercontent.com/mateuszkluskamk-max/alfa-market-data/main/data/latest.json

## Interpretacja i ryzyko

Filtry dla trwającej świecy 4H: BTC ±3%, ETH/SOL ±4,5%; tempo wolumenu względem mediany 20 poprzednich świec ≥1,8×. Filtry są wyłącznie alarmami, **nie sygnałami BUY/SELL**. Tempo wolumenu jest przybliżeniem i może być niestabilne na początku świecy. Utrzymuj historię audytu decyzji osobno. Kod nie składa zleceń.

## Prywatność

Repozytorium jest publiczne; **nie zapisuj tu kluczy API, danych osobowych, portfela, eksportów transakcji ani danych prywatnych**.

## Nowszy wariant dostarczania danych (09.11.2026)

Godzinowe opóźnienia GitHub Actions mimo cron co 5 minut są potwierdzone. Projekt ma już kod alternatywnego **ALFA Market Feed** opartego na Cloudflare Workers, pozwalający pobierać aktualne świece na żądanie. Moduł przeszedł lokalizowane testy CI, ale **nie został jeszcze wdrożony** — uruchomienie wymaga jednorazowego połączenia konta Cloudflare z repozytorium. Instrukcja: [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md).

Nie interpretuj zaplanowanego cron jako gwarancji dostępności danych co 5 minut. 
