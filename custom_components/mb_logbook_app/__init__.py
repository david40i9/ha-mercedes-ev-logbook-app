"""Mercedes EV Logbook web app: the logbook as a phone web app, served by Home Assistant.

An add-on to the Mercedes EV Logbook integration (mb_logbook). It only serves
static files; the page signs in with Home Assistant's own login and then uses
the same websocket commands as the logbook's sidebar page. Nothing here talks
to Mercedes or anything outside Home Assistant.
"""

from __future__ import annotations

from pathlib import Path

from aiohttp import web
from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import APP_PATH, DOMAIN

WWW = Path(__file__).parent / "www"

# Everything the page may load, with its content type. Anything else is a 404.
FILES = {
    "index.html": "text/html",
    "app.js": "text/javascript",
    "app.css": "text/css",
    "manifest.webmanifest": "application/manifest+json",
    "icon-180.png": "image/png",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
    "leaflet/leaflet.js": "text/javascript",
    "leaflet/leaflet.css": "text/css",
}


class LogbookAppView(HomeAssistantView):
    """Serves the web app's files while the integration is set up.

    No auth here: these are the page's own files, and the logbook data comes
    over the websocket only after the user signs in to Home Assistant.
    """

    url = APP_PATH + "/{filename:.*}"
    extra_urls = [APP_PATH]
    name = "mb_logbook_app:files"
    requires_auth = False

    async def get(self, request: web.Request, filename: str | None = None) -> web.StreamResponse:
        hass: HomeAssistant = request.app[KEY_HASS]
        if not hass.data.get(DOMAIN):
            # Removed (or not set up): the app is gone until it's added again.
            raise web.HTTPNotFound
        if filename is None:
            # Relative links in the page need the trailing slash.
            raise web.HTTPFound(APP_PATH + "/")
        name = filename or "index.html"
        kind = FILES.get(name)
        if kind is None:
            raise web.HTTPNotFound
        # no-cache: the phone checks for a newer file each time (cheap, with an ETag), so
        # an update through HACS shows up without reinstalling the home screen icon.
        return web.FileResponse(
            WWW / name, headers={"Content-Type": kind, "Cache-Control": "no-cache"}
        )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if not hass.data.get(f"{DOMAIN}_view"):
        # Views can't be removed again, so the view stays and checks the flag below.
        hass.http.register_view(LogbookAppView())
        hass.data[f"{DOMAIN}_view"] = True
    hass.data[DOMAIN] = True
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data[DOMAIN] = False
    return True
