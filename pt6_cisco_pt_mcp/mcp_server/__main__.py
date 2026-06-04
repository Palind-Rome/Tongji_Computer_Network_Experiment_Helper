"""Allow ``python -m mcp_server`` to start the server."""

from .server import main

if __name__ == "__main__":
    raise SystemExit(main())
