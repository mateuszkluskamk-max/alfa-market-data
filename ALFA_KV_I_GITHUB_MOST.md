# ALFA — synchronizacja danych Cloudflare → GitHub (wersja 10.11.2026)

## Co już działa bez żadnej konfiguracji użytkownika

Worker `alfa-market-data` korzysta z publicznych danych Bitstamp USD (Kraken USD awaryjnie). Cloudflare ma przypięty magazyn `ALFA_KV` utworzony automatycznie przez Wrangler. Cron `*/5 * * * *` zapisuje co uruchomienie maksymalnie 2 klucze KV: bieżącą migawkę i archiwalny rekord z TTL 14 dni. 288 uruchomień/dobę to około 576 zapisów, poniżej limitu 1000 zapisów/dobę bezpłatnego KV. Pobrania `/latest.json` **nie zapisują** nic do KV; przy nieaktualnym KV następuje próba pobrania świeżych danych, a błąd pobrania nie jest maskowany jako „fresh”. Źródła są rozdzielone. 

- Bieżący odczyt: https://alfa-market-data.mateuszkluska-mk.workers.dev/latest.json
- Stan KV i ostatni cron: https://alfa-market-data.mateuszkluska-mk.workers.dev/health
- Lista kluczy archiwum: https://alfa-market-data.mateuszkluska-mk.workers.dev/history.json?limit=12
- Zapis w GitHub (harmonogram może się opóźniać): https://github.com/mateuszkluskamk-max/alfa-market-data/blob/main/data/cloudflare_latest.json
- `snapshot_utc`: czas obserwacji rynku; `stored_utc`: czas zapisu do KV, gdy obecny; `mirrored_utc`: czas kopii do GitHub.

**Zweryfikowane**: 10.11.2026 o 10:07 UTC status `kv_configured:true`, `KV latest:2026-11-10T10:05:26.720Z`, archiwum zawiera wpis `archive:v1:2026-11-10T10:05Z`, `/latest.json` HTTP 200. Nie stanowi to jeszcze potwierdzenia niezawodności przez wiele dni.

## GitHub Actions przez Cloudflare — stan 10.11.2026

Właściciel dodał w Cloudflare jako zaszyfrowany sekret `GITHUB_DISPATCH_TOKEN`, ważny do 8.02.2027, ograniczony do **jednego** repozytorium `mateuszkluskamk-max/alfa-market-data`. Uprawnienie PAT: **Actions: Read and write** oraz automatyczne **Metadata: Read-only**. Wartości sekretu nie wolno fotografować, wypisywać do logów ani kopiować do repozytorium.

**Istotna poprawka API:** pierwotny `repository_dispatch` wymagał **Contents write**, którego ten bezpieczniejszy token nie ma. Kod Workera został zmieniony na `POST /repos/mateuszkluskamk-max/alfa-market-data/actions/workflows/collect.yml/dispatches`, co wymaga wyłącznie **Actions write**. Worker wysyła `{"ref":"main","inputs":{"cloudflare_mirror_only":"true"}}` na co drugim 5-minutowym cyklu Cron (docelowo około 10 minut), jeżeli sekret jest dostępny.

GitHub Actions `.github/workflows/collect.yml` rozpoznaje wejściowy parametr `cloudflare_mirror_only` i wtedy wykonuje tylko skrypt `scripts/mirror_worker.py`, bez zbędnego pobierania Binance. Nadal zachowuje oryginalny harmonogram i archiwum.

- Podgląd odpowiedzi GitHub (bez klucza): https://alfa-market-data.mateuszkluska-mk.workers.dev/bridge-status.json
- `accepted_by_github` oznacza tylko **HTTP 204** przyjęty przez GitHub; aby potwierdzić faktyczne ukończenie zadania, sprawdź nowe uruchomienie `workflow_dispatch` w Actions oraz `data/cloudflare_latest.json`.
- `dispatch_failed` pokazuje bezpiecznie jedynie kod HTTP, nie treść żądania ani sekret.
- **Aktualizacja 11.11.2026:** po ostrzeżeniu Cloudflare o osiągnięciu 50% limitu KV zlikwidowano trzeci zapis statusu. Od teraz status mostu `bridge_status` jest osadzany w już istniejącym kluczu `latest:multi-venue-usd:v5`, a `/bridge-status.json` najpierw odczytuje go stamtąd (z awaryjnym odczytem starego klucza). Zachowano archiwum i bieżący stan co 5 minut, a GitHub dispatch co ok. 10 minut. Planowane użycie: **2 zapisy × 288 uruchomień = około 576 zapisów/dobę** zamiast 720, poniżej darmowego limitu 1000/dobę. Przedziały i częstotliwość Cron są best effort; inne ręczne operacje w koncie też zużywają limit.
- Zapis Cloudflare KV jest niezależny od GitHuba. Awaria dispatch nie unieważnia rynkowych danych zapisanych w KV.
- Zamknięcie dostępu: usuń sekret w Cloudflare i unieważnij PAT w GitHub.

**Pierwszy rzeczywisty dispatch z Cloudflare został zweryfikowany 10.11.2026, godz. 11:50 CET.** GitHub Actions uruchomił istniejący workflow `ALFA Market Data Snapshot` jako event `workflow_dispatch` (run ID `42802516914`, conclusion `success`). Krok Binance był `skipped`; kopiowanie Cloudflare i publikacja do repo zakończyły się sukcesem. W `data/cloudflare_latest.json` potwierdzono `snapshot_utc=2026-11-10T10:50:37.154Z`, `market=Bitstamp spot / USD`, `delivery=fresh_market_fetch` i wszystkie trzy aktywa BTCUSD/ETHUSD/SOLUSD. Most pobiera `/latest.json?fresh=1`, pomijając ewentualnie opóźnioną kopię KV bez dodatkowego zapisu do KV. Częstotliwość ~10 minut pozostaje best effort, nie gwarancją każdego cyklu.


## Co jest, a czego jeszcze nie ma

- Cloudflare: prawdziwy zapis co ok. 5 min **zweryfikowany pojedynczym zapisanym cyklem**, wymagane dalsze obserwacje.
- GitHub: pierwszy workflow_dispatch uruchomiony automatycznie przez Cloudflare i zakończony sukcesem; deklarowana częstotliwość około 10 minut wymaga dalszej obserwacji stabilności.
- Nie trzeba tworzyć nowych automatyzacji w ChatGPT ani zmieniać checkpointów ALFA.
- Żadne z opisanych zadań nie składa zleceń inwestycyjnych i nie modyfikuje sald użytkownika.

Źródła: [Cloudflare KV Free limits](https://developers.cloudflare.com/kv/platform/limits/), [Cloudflare automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/), [GitHub repository dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
