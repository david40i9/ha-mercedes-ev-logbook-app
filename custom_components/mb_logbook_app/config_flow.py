"""Add the web app: nothing to fill in, it just turns the page on."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.network import NoURLAvailableError, get_url

from .const import APP_PATH, DOMAIN


class LogbookAppConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="EV Logbook web app", data={})
        try:
            # The address that works away from home when there is one (Nabu Casa or the external URL).
            url = get_url(self.hass, prefer_external=True, allow_ip=True) + APP_PATH + "/"
        except NoURLAvailableError:
            url = f"your Home Assistant address followed by {APP_PATH}/"
        return self.async_show_form(step_id="user", description_placeholders={"url": url})
