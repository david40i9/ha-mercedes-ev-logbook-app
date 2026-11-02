"""Add the web app: nothing to fill in, it just turns the page on."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import APP_PATH, DOMAIN


class LogbookAppConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="EV Logbook web app", data={})
        return self.async_show_form(step_id="user", description_placeholders={"path": APP_PATH + "/"})
