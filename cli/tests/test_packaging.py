"""Frozen binaries ship trust roots without changing stdlib-only CLI installs."""
import os
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("existing", [None, "/custom/enterprise-ca.pem"])
def test_frozen_entry_uses_bundled_certificates_unless_configured(monkeypatch, existing):
    if existing:
        monkeypatch.setenv("SSL_CERT_FILE", existing)
    else:
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.setitem(sys.modules, "certifi", SimpleNamespace(where=lambda: "/bundled/cacert.pem"))
    monkeypatch.setitem(sys.modules, "snitch.cli", SimpleNamespace(main=lambda: 0))
    entry = Path(__file__).resolve().parents[1] / "tools" / "pyinstaller-entry.py"
    with pytest.raises(SystemExit) as exc:
        runpy.run_path(str(entry), run_name="__main__")
    assert exc.value.code == 0
    assert os.environ["SSL_CERT_FILE"] == (existing or "/bundled/cacert.pem")
