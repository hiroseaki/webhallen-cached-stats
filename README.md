# Webhallen Cached Stats

Tampermonkey-userscript som lägger till en cachad statistiksida på Webhallens medlemssidor.

Scriptet bygger vidare på kod från [Schanihbg/webhallen-userscript](https://github.com/Schanihbg/webhallen-userscript), men sparar orderhistorik lokalt i IndexedDB och uppdaterar sedan bara nya ordrar när cachen är komplett.

## Installation

Installera Tampermonkey och öppna sedan installationslänken:

https://raw.githubusercontent.com/hiroseaki/webhallen-cached-stats/main/userscript/webhallen-cached-stats.user.js

Tampermonkey bör då känna igen filen som ett userscript och visa installationsdialogen.

## Funktioner

- Lokal ordercache i IndexedDB.
- Inkrementell uppdatering av nya ordrar.
- Full ombyggnad av cache vid behov.
- Statistikblock från originalscriptet:
  - Experience
  - Stores
  - Streaks
  - Hoarder Top 10
  - Kategorier
  - Ordrar per månad
- Sorterbara tabeller.
- Export av cachad orderdata till semikolonseparerad CSV för Excel-import.

## Uppdateringar

Scriptet har `@updateURL` och `@downloadURL` som pekar mot raw-filen i detta repo.

## Filer

- `userscript/webhallen-cached-stats.user.js` - Tampermonkey-scriptet.
- `CHANGELOG.md` - versionshistorik och större ändringar.
