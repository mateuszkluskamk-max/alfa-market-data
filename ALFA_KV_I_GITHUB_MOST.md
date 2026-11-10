# ALFA — synchronizacja danych Cloudflare → GitHub (wersja 10.11.2026)

## Co już działa bez żadnej konfiguracji użytkownika

Worker `alfa-market-data` korzysta z publicznych danych Bitstamp USD (Kraken USD awaryjnie). Cloudflare ma przypięty magazyn `ALFA_KV` utworzony automatycznie przez Wrangler. Cron `*/5 * * * *` zapisuje co uruchomienie maksymalnie 2 klucze KV: bieżącą migawkę i archiwalny rekord z TTL 14 dni. 288 uruchomień/dobę to około 576 zapisów, poniżej limitu 1000 zapisów/dobę bezpłatnego KV. Pobrania `/latest.json` **nie zapisują** nic do KV; przy nieaktualnym KV następuje próba pobrania świeżych danych, a błąd pobrania nie jest maskowany jako „fresh”. Źródła są rozdzielone. 

- Bieżący odczyt: https://alfa-market-data.mateuszkluska-mk.workers.dev/latest.json
- Stan KV i ostatni cron: https://alfa-market-data.mateuszkluska-mk.workers.dev/health
- Lista kluczy archiwum: https://alfa-market-data.mateuszkluska-mk.workers.dev/history.json?limit=12
- Zapis w GitHub (harmonogram może się opóźniać): https://github.com/mateuszkluskamk-max/alfa-market-data/blob/main/data/cloudflare_latest.json
- `snapshot_utc`: czas obserwacji rynku; `stored_utc`: czas zapisu do KV, gdy obecny; `mirrored_utc`: czas kopii do GitHub.

**Zweryfikowane**: 10.11.2026 o 10:07 UTC status `kv_configured:true`, `KV latest:2026-11-10T10:05:26.720Z`, archiwum zawiera wpis `archive:v1:2026-11-10T10:05Z`, `/latest.json` HTTP 200. Nie stanowi to jeszcze potwierdzenia niezawodności przez wiele dni.

## Opcja podniesienia częstotliwości GitHub do około 10 minut (wymaga świadomej zgody właściciela)

Kod jest przygotowany, ale wyłączony **do momentu dodania sekretu**. Cloudflare nie ma dostępu do zapisu GitHub. Do uruchomienia można użyć ograniczonego tokena GitHub, bez publikowania go w plikach repozytorium:

1. Na GitHub zaloguj się do właściwego konta → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Nadaj opis `ALFA Cloudflare bridge`, wybierz **Only select repositories → alfa-market-data** i uprawnienie **Repository permissions → Contents: Read and write**. Innych repozytoriów i uprawnień nie zaznaczaj. Ustaw datę wygaśnięcia i pamiętaj o rotacji.
3. Skopiuj utworzony token **do schowka, NIE do ChatGPT ani do publicznego GitHuba**.
4. Cloudflare → **Workers & Pages → alfa-market-data → Settings → Variables and Secrets → Add**. Typ: **Secret**, nazwa: `GITHUB_DISPATCH_TOKEN`, wartość: token z pkt 3. Zapisz/Deploy.
5. Od najbliższego uruchomienia co 10 minut Worker wyśle do GitHub `repository_dispatch` z typem `alfa_cloudflare_sync`. Istniejące `.github/workflows/collect.yml` reaguje na ten event i uruchamia **tylko kopię Cloudflare**; nie wykonuje dodatkowego pobierania Binance dla tego zdarzenia.
6. W GitHub → **Actions → ALFA Market Data Snapshot** sprawdź, czy pojawia się event `repository_dispatch` i nowy `data/cloudflare_latest.json` ze świeżym `snapshot_utc`.

**Bezpieczeństwo**: token umożliwia zapis plików we wskazanym repozytorium, więc przechowuj go wyłącznie jako zaszyfrowany sekret w Cloudflare. Odłączenie = usunięcie sekretu i unieważnienie tokena na GitHub. Nawet z dispatch kolejka GitHub nie ma gwarancji wykonania co do sekundy.

## Co jest, a czego jeszcze nie ma

- Cloudflare: prawdziwy zapis co ok. 5 min **zweryfikowany pojedynczym zapisanym cyklem**, wymagane dalsze obserwacje.
- GitHub: dotychczasowa kopia danych co ok. godzinę, nie stale co 5 min; opcjonalna ścieżka dispatch przez sekret ma zmniejszyć opóźnienie do zwykle poniżej 15 min.
- Nie trzeba tworzyć nowych automatyzacji w ChatGPT ani zmieniać checkpointów ALFA.
- Żadne z opisanych zadań nie składa zleceń inwestycyjnych i nie modyfikuje sald użytkownika.

Źródła: [Cloudflare KV Free limits](https://developers.cloudflare.com/kv/platform/limits/), [Cloudflare automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/), [GitHub repository dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).
