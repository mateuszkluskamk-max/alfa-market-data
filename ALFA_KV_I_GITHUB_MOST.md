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
- KV zapisuje standardowo 2 klucze co 5 minut (~576 zapisów/dzień) oraz dodatkowy status tylko przy 10-minutowym dispatch (~144/dzień). Razem około **720 zapisów/dzień** (z marginesem do 1000 w planie Free); żadnych dodatkowych zapisów przy zwykłym odczycie.
- Zapis Cloudflare KV jest niezależny od GitHuba. Awaria dispatch nie unieważnia rynkowych danych zapisanych w KV.
- Zamknięcie dostępu: usuń sekret w Cloudflare i unieważnij PAT w GitHub.

**Testy kodu i wdrożenia zakończone pomyślnie 10.11.2026.** Potwierdzenie pierwszego faktycznego dispatch z Cron Workera jest odrębnym etapem — wymagane sprawdzenie statusu i eventu GitHub. Docelowa częstotliwość jest best effort, a nie gwarantowane 10 minut.


## Co jest, a czego jeszcze nie ma

- Cloudflare: prawdziwy zapis co ok. 5 min **zweryfikowany pojedynczym zapisanym cyklem**, wymagane dalsze obserwacje.
- GitHub: dotychczasowa kopia danych co ok. godzinę, nie stale co 5 min; ścieżka workflow_dispatch co ~10 minut została uruchomiona w kodzie i wymaga obserwacji pierwszych rzeczywistych zadań GitHuba.
- Nie trzeba tworzyć nowych automatyzacji w ChatGPT ani zmieniać checkpointów ALFA.
- Żadne z opisanych zadań nie składa zleceń inwestycyjnych i nie modyfikuje sald użytkownika.

Źródła: [Cloudflare KV Free limits](https://developers.cloudflare.com/kv/platform/limits/), [Cloudflare automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/), [GitHub repository dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
