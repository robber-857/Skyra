# Reports follow-up requested 2026-09-22

Deferred by the owner until after controlled production payment UAT. No Reports code change is included in the current payment preparation.

- Investigate why existing registered customers cannot be found on Reports. Historical Mindbody Sales were not migrated, but do not assume this alone explains missing customer search results.
- At three or more typed characters, show matching customer suggestions in a dropdown.
- Clicking a suggestion selects that customer and closes the dropdown.
- Preserve server-side tenant-scoped search and current report date filters; validate without changing customer records.
