# EV Logbook web app: handover notes

Dave's optional add-on to `david40i9/ha-mercedes-ev-logbook` (the `mb_logbook`
integration). It's the Android app (`david40i9/mb-logbook-android`) as a phone
web app for iPhone users, served by Home Assistant, so nobody needs an Apple
developer account. It must stay a **separate install**: Dave doesn't want the
main integration to carry it.

## How it works

- `custom_components/mb_logbook_app/__init__.py`: one `HomeAssistantView` at
  `/mb_logbook_app/` serving the files listed in `FILES` from `www/`, with
  `Cache-Control: no-cache` (so HACS updates show without reinstalling the icon).
  Views can't be unregistered, so it 404s when the config entry isn't loaded.
  Add any new file to `FILES` or it 404s.
- `www/app.js`: plain JavaScript, no build step, no outside scripts. Leaflet 1.9.4
  is vendored in `www/leaflet/`. OSM tiles are the only outside requests.
- Sign-in: Home Assistant's auth API, with the page's address
  (`<origin>/mb_logbook_app/`) as `client_id` and `redirect_uri`. HA accepts a
  same-host redirect with no setup (tested in `tests/test_app.py`). Tokens live in
  `localStorage` (`mbl.tokens`); the access token is refreshed before each connect.
- Data: the same `mb_logbook/*` websocket commands as the Android app (see its
  CLAUDE.md for the command list and row shapes). Edits need an HA admin; the
  page shows "Only a Home Assistant administrator…" when refused.
- UI copies the Android app: dark and silver theme, Home / Trips / Charge tabs,
  trip page with route map, type chips, split/merge/delete. Hold a trip row to
  set its type. Not done yet: Places, Map tab, naming places.
- Look (0.2.0): it shares the Home Assistant card's trip type colours (`TYPE_COLOURS`,
  `typeColour`: Business blue, Commute orange, Personal green, then other types in the
  order HA lists them). Chart bars carry their figure on top (Dave asked for this; keep
  it). Questions use `ask()` (a `<dialog>`), never the browser's `confirm`/`prompt`.
  Pages show `skeleton()` blocks while loading.

## Testing

`pip install -r requirements_test.txt`, then `ruff check .`, `node --check
custom_components/mb_logbook_app/www/app.js` and `pytest -q`. For the UI, run a
fake HA (aiohttp: serve `www/`, fake `/auth/authorize` and `/auth/token`, and
answer the websocket commands with sample rows) and drive it with Playwright at
iPhone size.

## Shipping

Like the integration: PR from the session branch with a version bump in
`manifest.json`, Dave merges, then publishes release `vX.Y.Z` (the release
workflow checks the tag matches the manifest). HACS installs releases.
Dave's preferences: UK English, no claude.ai links in PR descriptions,
uncluttered phone screens.
