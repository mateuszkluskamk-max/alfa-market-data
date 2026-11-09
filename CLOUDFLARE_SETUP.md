# ALFA — alternatywny kanał danych Cloudflare Workers (testowany kod, wdrożenie oczekuje)

## Dlaczego

9.11.2026 harmonogram GitHub Actions zadeklarowany co pięć minut wykonał odczyty w praktyce głównie co około godzinę. Wynika to z charakteru GitHub Actions schedule (best effort). Nie można tego naprawić gwarantowanie wyłącznie zmianą cron w GitHubie.

## Co jest już w repozytorium

- `src/index.js`: Cloudflare Worker serwujący **świeże świece na żądanie** pod `GET /latest.json`, zwracający HTTP 503, gdy dostawca rynku nie odpowiada. `GET /health` sprawdza status zapisanego odczytu.
- `wrangler.jsonc`: nazwa usługi `alfa-market-feed` i cron `*/5 * * * *` na Cloudflare (UTC, best effort).
- `scripts/test-worker.mjs`: testy bez dostępu do internetu (podstawowy endpoint, 3 aktywa × 3 interwały, chronologia świec, KV, brak zwracania starych danych jako aktualne).
- `.github/workflows/validate-worker.yml`: automatyczne testy po zmianach kodu.

**To jest przygotowana alternatywa, ale nie oznacza, że usługa została już wdrożona.**

## Aktywacja za zgodą właściciela

1. Załóż / otwórz darmowe konto Cloudflare: https://dash.cloudflare.com/
2. Workers & Pages → Create application → Connect/import **GitHub repository**.
3. Udziel Cloudflare GitHub integracji dostępu **tylko** do `mateuszkluskamk-max/alfa-market-data`.
4. Wybierz repozytorium i branch `main`. Root directory `/`; konfiguracja `wrangler.jsonc`. Jeśli dashboard pyta o build/deploy command, skonfiguruj `npx wrangler deploy`. Nazwa `alfa-market-feed`.
5. Po wdrożeniu skopiuj publiczny adres `https://alfa-market-feed.<twoja-subdomena>.workers.dev/latest.json` i prześlij go do ALFA.
6. ALFA sprawdzi: obecność BTC/ETH/SOL, zakres 1H/4H/1D, `snapshot_utc`, ruch wolumenu i poprawny HTTP 503 przy braku źródła. Dopiero potem zmienimy źródło dla istniejących zadań.

**Bez dodatkowej bazy danych:** endpoint `/latest.json` pobiera świeże dane po każdym wywołaniu, działa bez KV; pięciominutowy cron wtedy tylko testuje pobieranie i loguje, ale nie przechowuje snapshotu. Zapis co pięć minut można włączyć przez Cloudflare KV:

7. Workers & Pages → KV → utwórz przestrzeń `alfa-market-data-kv`; dodaj do Workera binding nazwany dokładnie `ALFA_KV`.
8. Następnie do `wrangler.jsonc` dodaj `kv_namespaces` z `binding:"ALFA_KV"` i prawdziwym `id` wygenerowanym przez Cloudflare (bez żadnego hasła); nie zgaduj ID. Po kolejnym deploy testuj `/health`.
9. Cloudflare może propagować cron przez kilkanaście minut. Sprawdź wydarzenia Cron w panelu. Progi: oczekiwane ~5 minut, alarm `stale` po 10 minutach.

## Rozdział zadań

- GitHub Actions `collect.yml` **pozostaje** mechanizmem zapasowym historii świec.
- Cloudflare Worker udostępnia aktualny snapshot na każde zapytanie, a po podłączeniu KV dodatkowo zapisuje go co ~5 minut.
- Automatyzacje ChatGPT ALFA co godzinę i o checkpointach nie zostają dublowane. Nie gwarantują reagowania w ciągu pięciu minut; do takiej reakcji potrzebny osobny kanał alertowania.
- Brak transakcji automatycznych. Żadnych kluczy giełdowych ani danych użytkownika.
- Gdy brak aktualnych danych: status `STALE` lub `N/D`, żadnych pozornie świeżych sygnałów.

## Walidacja

- GitHub Actions / `Validate ALFA Market Feed`: testy offline muszą być zielone.
- Cloudflare / `/latest.json`: pierwszy publiczny odczyt z prawidłowym timestamp.
- Minimum 12 kolejnych wywołań / 60 minut: policzyć opóźnienie, brakujące dane, błędy HTTP. Tylko wtedy przyjąć system jako operacyjny.
