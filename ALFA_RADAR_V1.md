# ALFA v1.6 — Dwukierunkowy Radar v1
10 listopada 2026 — wersja eksperymentalna, bez resetowania historii ALFA v1.5.

## Zadanie
Wykrywać **wczesne ostrzeżenia** o nasilających się spadkach i wzrostach BTC, ETH i SOL, zanim minie cały 4-godzinny lub dobowy ruch. Nie prognozować pewnych cen ani nie wykonywać transakcji. Dotychczasowy globalny skan 9 sektorów pozostaje osobnym etapem analizy.

**Źródło:** publiczne OHLCV Bitstamp USD, awaryjnie Kraken USD. 1H pochodzi z giełdy, 4H i 1D są składane z kompletnych 1H według UTC. Dane nie obejmują spreadu i prowizji Revolut X, order flow, CVD, funding ani faktycznych przepływów ETF. Nie wolno zmyślać brakujących wskaźników.

## Reguły v1 (symetryczne dla UP i DOWN)

| Aktywo | 1H ruch WATCH | 3H ruch WATCH | 4H ruch ALERT | Otwarta 4H SHOCK | Zmiana zamkniętych 24H (kontekst) |
|---|---:|---:|---:|---:|---:|
| BTC/USD | 0,65% | 1,15% | 1,50% | 3,00% | 2,50% |
| ETH/USD | 1,00% | 1,75% | 2,20% | 4,50% | 4,00% |
| SOL/USD | 1,50% | 2,50% | 2,90% | 4,50% | 5,50% |

Ruchy liczymy z zachowaniem znaku, ten sam próg obowiązuje dla wzrostu i spadku. To **parametry do testów**, nie statystycznie skalibrowany model.

- **WATCH 1H:** zamknięta świeca z ruchem powyżej progu oraz wolumenem co najmniej 1,4× mediany poprzednich 20 świec godzinowych **tej samej giełdy**.
- **WATCH wybicie zakresu 12H:** zamknięta 1H ponad maksimum lub pod minimum poprzednich 12 zamkniętych 1H, wolumen co najmniej 1,3×, ruch 1H co najmniej 40% progu WATCH.
- **WATCH przyspieszenie 3H:** ruch 3H powyżej progu, co najmniej dwie z trzech godzin w tym samym kierunku, ostatni wolumen ≥1,15× mediany.
- **WATCH w trakcie 1H:** po ≥12 minutach otwartej świecy ruch ≥progu WATCH oraz tempo wolumenu ≥1,7×. Oznaczenie `confirmed=false`, bo sygnał może zniknąć.
- **ALERT potwierdzone 4H:** ukończona świeca powyżej progu ALERT oraz wolumen ≥1,8× mediany 20 wcześniejszych 4H.
- **ALERT 4H SHOCK:** otwarta 4H powyżej progu SHOCK i tempo wolumenu ≥1,2×. `confirmed=false` — wysoka zmienność i możliwy fałszywy ruch.
- **Kontekst 24H:** różnica zamknięć godzinowych sprzed 24 godzin i obecnie, nie należy przedstawiać jako wcześniejszego przewidzenia.
- Jeśli występują sygnały w obu kierunkach, pokazuj **MIXED / możliwe odbicie przeciwtrendowe**, nie automatyczne odwrócenie trendu.

## Gdzie czytać

- Publiczny krótki radar: https://alfa-market-data.mateuszkluska-mk.workers.dev/radar.json
- Pełne dane: https://alfa-market-data.mateuszkluska-mk.workers.dev/latest.json
- Kopia dla ChatGPT: https://github.com/mateuszkluskamk-max/alfa-market-data/blob/main/data/cloudflare_latest.json
- Archiwum KV: obecne co 5 minut w ramach istniejącego `archive:v1:` — **bez dodatkowych zapisów**.
- Pola: `signals` (obecnie wykrywane), `recent_events` (do 6 godzin wcześniejszych, również wygasłe), `event_id`, `first_seen_utc`, `last_seen_utc`, `active_now`, `confirmed`, `severity`, `direction`, `symbols.*.radar.metrics`.
- `observation_level_usd` to **poziom techniczny do obserwacji**, nie ustawiony stop-loss.
- Dla źródeł zawsze porównuj `snapshot_utc` z aktualnym czasem; starsze niż 15 minut oznaczaj STALE, nie aktualny sygnał.

## Częstotliwość i granice

Cloudflare próbuje wykonywać pomiary co 5 minut (best effort); istniejący most zapisuje do GitHub średnio co 10 minut (best effort). Istniejące automatyzacje ChatGPT mają skan godzinowy, alerty portfeli godzinowo i checkpointy o 09:00, 13:00, 16:00, 21:00. **Nie jest to nieprzerwany strumień ani gwarancja natychmiastowego powiadomienia**. Nie tworzono nowych zadań. Automatyzacje mają korzystać także z `recent_events`, żeby nie przeoczyć impulsu, który zniknął przed godzinowym odczytem.

## Standard komunikatu przy sygnale

`WATCH UP/DOWN` lub `ALERT UP/DOWN`; instrument i kierunek; wielkość i interwał; porównanie wolumenu; czas i giełda; czy świeca zamknięta; wsparcie/opór lub warunek zanegowania; ryzyko fałszywego wybicia; decyzja: obserwacja, ochrona, badanie setupu, a **nie automatyczny zakup**. Nie dublować komunikatu z tym samym `event_id` bez eskalacji.

Zakup/sprzedaż wymaga niezależnie kwoty, poziomu, SL/unieważnienia, celu, ryzyka PLN/% i R/R netto ≥1,8 po kosztach oraz potwierdzenia, że dotyczy portfela ALFA. Ochrona kapitału i gotówka pozostają dopuszczalne.

## Audyt przez 07.11–06.12.2026

Nie zmieniać historii wcześniejszych wersji. Dla każdego zdarzenia z `first_seen_utc` oceń: czy pojawiło się **przed największą świecą, podczas niej czy po niej**, czy trafiło do raportu, opóźnienie raportu, kierunek ruchu po 24 godzinach i 7 dniach, fałszywe wybicie i potencjalny wynik **hipotetyczny** po kosztach. Porównuj z benchmarkami i rezerwą. Rozdzielaj ostrzeżenia `WATCH/ALERT` od rzeczywiście zatwierdzonych `BUY/SELL`.

**Stan testów 10.11.2026:** CI `Validate ALFA Market Feed` potwierdził dwa kierunki i poziomy na danych syntetycznych; Cloudflare `Probe ALFA Cloudflare Worker` potwierdził publiczną usługę z polami radaru i trzema instrumentami. To dowód sprawności kodu, **nie dowód przewagi nad rynkiem**.
