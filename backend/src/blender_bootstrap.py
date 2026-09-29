"""Run inside a dedicated Blender GUI process, not ordinary Python."""

import argparse
import importlib.util
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--addon", required=True)
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    os.environ["DISABLE_TELEMETRY"] = "true"
    spec = importlib.util.spec_from_file_location("asset_blender_mcp_addon", args.addon)
    addon = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = addon
    spec.loader.exec_module(addon)
    addon.register()
    server = addon.BlenderMCPServer(host="127.0.0.1", port=args.port)
    server.start()
    if not server.running:
        raise RuntimeError("Blender MCP addon did not start")
    # Keep the server alive without modifying the user's installed addon preferences.
    addon.asset_editor_server = server


if __name__ == "__main__":
    main()
