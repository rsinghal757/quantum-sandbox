from __future__ import annotations

import argparse

from .api import run as run_http_server
from .mcp_server import mcp


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="quantum-sandbox-mcp",
        description="Quantum Sandbox MCP server for stdio and streamable HTTP.",
    )
    parser.add_argument(
        "mode",
        nargs="?",
        default="stdio",
        choices=["stdio", "http"],
        help="Run as stdio MCP server (default) or HTTP host.",
    )
    args = parser.parse_args()

    if args.mode == "http":
        run_http_server()
        return

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
