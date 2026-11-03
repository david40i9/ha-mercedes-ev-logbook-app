# Mercedes EV Logbook web app

A phone web app for the [Mercedes EV Logbook](https://github.com/david40i9/ha-mercedes-ev-logbook)
integration, served by your own Home Assistant. On an iPhone you add it to the home screen
from Safari and it opens full screen like an app, with no App Store and no Apple developer account.

It's a separate, optional install. The logbook integration works the same without it.

## What it does

- **Home:** this month's figures, trip types (Business first), 12-month charts and favourite places.
- **Trips:** month by month, grouped by day, filtered by trip type. Hold a trip to set its type.
  Tap a trip for its route map, its figures, and to set its type, split, merge or delete it.
- **Charge:** each charging session, coloured by where it was.

Everything comes from Home Assistant over its websocket, using the logbook's own commands.
The only other thing the page loads is OpenStreetMap map tiles for the route maps.

## Install

1. In HACS, open the menu (⋮) and choose **Custom repositories**. Add
   `https://github.com/david40i9/ha-mercedes-ev-logbook-app` with the type **Integration**.
2. Find **Mercedes EV Logbook web app** in HACS, download it and restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration** and add
   **Mercedes EV Logbook web app**. There's nothing to fill in.

To remove it, delete the integration in Devices & services. The page stops working straight away.

## Put it on a phone

1. On the phone, open Safari at your Home Assistant address followed by `/mb_logbook_app/`.
   Use the address that works away from home too (for example your Nabu Casa
   `https://….ui.nabu.casa/mb_logbook_app/`), because the home screen icon keeps the address it was added from.
2. Tap **Sign in** and log in with a Home Assistant user. This is Home Assistant's own login page.
3. Tap **Share**, then **Add to Home Screen**, then **Add**.

The icon opens the app full screen. It stays signed in until you choose **Sign out** from the ⋮ menu,
or the login is removed from that user's Home Assistant profile (Security → Refresh tokens).

Anyone with a Home Assistant login can see the logbook. Changing trips (their type, split, merge or
delete) needs a Home Assistant **administrator**, the same as in the logbook's sidebar page.

## How it works

The integration only serves the page's files at `/mb_logbook_app/`. The page signs in through
Home Assistant's [authentication API](https://developers.home-assistant.io/docs/auth_api), with its own
address as the client ID, so no long-lived token has to be made or typed in. It keeps a refresh token
for that Home Assistant on the phone, and then sends the same `mb_logbook/*` websocket commands the
sidebar page uses.
