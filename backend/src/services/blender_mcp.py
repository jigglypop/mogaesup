"""MCP client for the pinned blender-mcp server; never retries mutations."""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from datetime import timedelta


# The MCP server runs arbitrary Blender code; provider keys and credentials never reach it.
_SECRET_NAME = re.compile(r"KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL|DSN", re.IGNORECASE)


class BlenderExecutionError(RuntimeError):
    pass


class BlenderExecutionUncertain(BlenderExecutionError):
    pass


class BlenderMCP:
    def __init__(self, *, port: int = 9876, timeout: float = 180):
        if not 1 <= port <= 65535 or timeout <= 0:
            raise ValueError("invalid Blender port or timeout")
        self.port = port
        self.timeout = timeout

    async def execute(self, code: str, user_prompt: str) -> dict:
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
        except ImportError as exc:
            raise BlenderExecutionError("Install the Blender extra: uv sync --extra blender") from exc
        parameters = StdioServerParameters(
            command=sys.executable, args=["-c", "import logging; from blender_mcp.server import main; "
                "logging.disable(logging.INFO); main()"],
            env={**{name: value for name, value in os.environ.items() if not _SECRET_NAME.search(name)},
                 "BLENDER_HOST": "127.0.0.1", "BLENDER_PORT": str(self.port),
                 "DISABLE_TELEMETRY": "true"},
        )
        submitted = False
        try:
            async with asyncio.timeout(self.timeout):
                async with stdio_client(parameters) as (reader, writer):
                    async with ClientSession(reader, writer, read_timeout_seconds=timedelta(seconds=self.timeout)) as session:
                        await session.initialize()
                        tools = await session.list_tools()
                        if not any(tool.name == "execute_blender_code" for tool in tools.tools):
                            raise BlenderExecutionError("MCP server has no execute_blender_code tool")
                        submitted = True
                        response = await session.call_tool("execute_blender_code", {"code": code, "user_prompt": user_prompt})
                        text = "\n".join(item.text for item in response.content if item.type == "text")
                        if response.isError:
                            raise BlenderExecutionUncertain("Blender MCP returned an error; inspect the attempt before resubmitting")
                        if text.startswith(("Error executing code:", "Rejected by safe mode")):
                            raise BlenderExecutionError("Blender rejected the edit; previous revision is unchanged")
                        # This server can return a plain-text error with isError=false.
                        marker = "ASSET_EDITOR_RESULT="
                        if marker not in text:
                            raise BlenderExecutionUncertain("Blender did not confirm completion; inspect the attempt before resubmitting")
                        result = json.loads(text.rsplit(marker, 1)[1].splitlines()[0])
                        if not isinstance(result, dict):
                            raise BlenderExecutionUncertain("Invalid Blender result")
                        return result
        except BlenderExecutionError:
            raise
        except BaseException as exc:
            pending = [exc]
            while pending:
                error = pending.pop()
                if isinstance(error, BlenderExecutionError):
                    raise error from exc
                if isinstance(error, BaseExceptionGroup):
                    pending.extend(error.exceptions)
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            if submitted:
                raise BlenderExecutionUncertain("Blender execution may still be running; no automatic retry") from exc
            raise BlenderExecutionError("Could not initialize Blender MCP connection") from exc
