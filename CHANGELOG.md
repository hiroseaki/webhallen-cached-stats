# Changelog

## 1.1.1

### Changed

- Recensioner-menyn använder originalscriptets recensionsikon tydligare.

## 1.1.0

### Added

- Added `Recensioner (cached ver.)` to Webhallen member pages.
- Added local IndexedDB cache for purchased-product review checks.
- Added review sync that reuses the existing local order cache as product source.
- Shows posted reviews and purchased products that are missing reviews.
- Added a note that anonymous reviews cannot be matched to the logged-in account.

## 1.0.3

### Fixed

- Improved CSV export price detection for order rows.
- Empty price fields are no longer exported as `0`.
- Renamed `Pris` to `Produktpris` in the CSV export.
- Removed the empty `Orderstatus` column from the CSV export.
- Removed the ambiguous `Ordersumma` column from the CSV export.

## 1.0.2

Initial public release of Webhallen Cached Stats.

### Added

- Adds `Statistik (cached ver.)` to Webhallen member pages.
- Stores order history locally in the browser using IndexedDB.
- Shows cached statistics immediately when the page opens.
- Updates only new orders after the local cache has been fully built.
- Can rebuild the full order cache from scratch.
- Exports cached order rows to a semicolon-separated CSV file for Excel import.
- Includes the main statistics from the original userscript:
  - Experience
  - Stores
  - Streaks
  - Hoarder Top 10
  - Kategorier
  - Ordrar per månad
- Supports sortable statistics tables.
- Shows sync progress while orders are being cached.

### Notes

- Older partial caches are automatically completed on the next update.
- Older caches created before the `fullCacheComplete` flag are still supported when they were created by a full sync.
- The script includes Tampermonkey update metadata via `@updateURL` and `@downloadURL`.

### Not Included

- Review scanning is not included because it can require one or more API calls per purchased product.
- Product comparison utilities from the original userscript are not included.
- Favorite-store cleanup from the original userscript is not included.
