import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "mcp.json").read_text())["tools"]
DEFAULTS = {
    tool["sql"]: {name: spec["default"] for name, spec in tool.get("params", {}).items() if "default" in spec}
    for tool in MANIFEST
}


class ManifestConnection(sqlite3.Connection):
    """Binds declared parameter defaults for manifest SQL, as the platform does before running an action."""

    def execute(self, sql, parameters=(), /):
        defaults = DEFAULTS.get(sql)
        if defaults and isinstance(parameters, dict):
            parameters = {**defaults, **parameters}
        return super().execute(sql, parameters)


def connect():
    return sqlite3.connect(":memory:", factory=ManifestConnection)
