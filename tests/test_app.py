"""The web app's files are served only while the integration is set up."""

from __future__ import annotations

from homeassistant import config_entries
from homeassistant.components.auth import indieauth
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.mb_logbook_app import FILES, WWW
from custom_components.mb_logbook_app.const import DOMAIN


async def _setup(hass: HomeAssistant) -> MockConfigEntry:
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def test_every_listed_file_exists() -> None:
    for name in FILES:
        assert (WWW / name).is_file(), name


async def test_serves_the_app(hass: HomeAssistant, hass_client_no_auth) -> None:
    await _setup(hass)
    client = await hass_client_no_auth()

    resp = await client.get("/mb_logbook_app", allow_redirects=False)
    assert resp.status == 302
    assert resp.headers["Location"] == "/mb_logbook_app/"

    resp = await client.get("/mb_logbook_app/")
    assert resp.status == 200
    assert resp.headers["Content-Type"].startswith("text/html")
    assert resp.headers["Cache-Control"] == "no-cache"
    assert "app.js" in await resp.text()

    resp = await client.get("/mb_logbook_app/manifest.webmanifest")
    assert resp.status == 200
    assert resp.headers["Content-Type"].startswith("application/manifest+json")

    resp = await client.get("/mb_logbook_app/leaflet/leaflet.js")
    assert resp.status == 200


async def test_nothing_else_is_served(hass: HomeAssistant, hass_client_no_auth) -> None:
    await _setup(hass)
    client = await hass_client_no_auth()
    for path in ("/mb_logbook_app/__init__.py", "/mb_logbook_app/../manifest.json", "/mb_logbook_app/nope.js"):
        resp = await client.get(path)
        assert resp.status == 404, path


async def test_gone_after_removal(hass: HomeAssistant, hass_client_no_auth) -> None:
    entry = await _setup(hass)
    client = await hass_client_no_auth()
    assert (await client.get("/mb_logbook_app/")).status == 200
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert (await client.get("/mb_logbook_app/")).status == 404


async def test_config_flow_once(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_home_assistant_accepts_the_login_redirect(hass: HomeAssistant) -> None:
    """The page signs in with its own address as client_id and redirect_uri (app.js)."""
    for origin in ("https://abc.ui.nabu.casa", "http://192.168.1.5:8123"):
        url = origin + "/mb_logbook_app/"
        assert await indieauth.verify_redirect_uri(hass, url, url)
