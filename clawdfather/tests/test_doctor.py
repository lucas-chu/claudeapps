"""The preflight's own failure handling.

A doctor that crashes is worse than no doctor, so the parsing helpers are
tested against the shapes Slack actually returns — including no network at all.
"""

from slack_sdk.errors import SlackApiError

from scripts import doctor


class FakeResponse:
    def __init__(self, headers=None, data=None):
        self.headers = headers or {}
        self._data = data or {}

    def get(self, key, default=None):
        return self._data.get(key, default)


def test_scopes_parsed_from_header():
    resp = FakeResponse({"x-oauth-scopes": "chat:write, channels:history,chat:write.customize"})
    assert doctor._scopes(resp) == {"chat:write", "channels:history", "chat:write.customize"}


def test_scopes_tolerates_list_valued_headers():
    """Some HTTP layers hand back header values as lists."""
    assert doctor._scopes(FakeResponse({"x-oauth-scopes": ["chat:write"]})) == {"chat:write"}


def test_scopes_tolerates_capitalised_header():
    assert doctor._scopes(FakeResponse({"X-OAuth-Scopes": "chat:write"})) == {"chat:write"}


def test_scopes_absent_is_empty_not_an_error():
    assert doctor._scopes(FakeResponse()) == set()
    assert doctor._scopes(object()) == set()


def test_slack_api_error_reports_slacks_reason():
    exc = SlackApiError("boom", FakeResponse(data={"error": "invalid_auth"}))
    assert doctor._slack_error(exc) == "invalid_auth"


def test_unreachable_slack_is_reported_not_raised():
    """Offline, VPN, or proxy failures must be a finding, not a traceback."""
    from urllib.error import URLError

    assert doctor._slack_error(URLError("no route")) == "cannot reach Slack: URLError"
