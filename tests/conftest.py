"""Custom integrations are off by default in the test harness."""

import pytest

pytest_plugins = ["pytest_homeassistant_custom_component"]


@pytest.fixture(autouse=True)
def auto_enable(enable_custom_integrations):
    yield
