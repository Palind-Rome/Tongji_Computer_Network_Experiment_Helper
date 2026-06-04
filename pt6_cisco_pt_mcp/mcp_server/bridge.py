"""Socket.IO bridge to the Packet Tracer plugin.

Listens on ``127.0.0.1:7531`` for the headless cisco-pt-mcp plugin to
connect. Translates ``call_tool(name, args)`` into a ``tool_call`` event,
awaits the matching ``tool_result`` (correlated by ``tool_call_id``), and
returns the raw result dict to the MCP server.

Wire protocol:

* server -> plugin
    - ``tool_call``  ``{tool_call_id, tool_name, tool_input}``

* plugin -> server
    - ``tool_result``  ``{tool_call_id, tool_name, tool_input, result}``

Loopback only. If a second plugin connects, the previous sid is
disconnected so there is exactly one live PT at any time.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from collections.abc import Mapping
from typing import Any

import socketio
from aiohttp import web

log = logging.getLogger(__name__)


class PTBridgeProtocolError(RuntimeError):
    """Raised when the Packet Tracer plugin violates the bridge protocol."""


# Loopback only — both ends are local.
BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 7531

# Bumped via env when long IOS command bursts exceed the default.
TOOL_TIMEOUT_S = float(os.environ.get("CISCO_PT_MCP_TOOL_TIMEOUT", "60"))

# Packet Tracer 6.0's webview is old enough that the bundled Socket.IO client
# does not reliably issue WebSocket requests. Keep the modern Socket.IO path,
# and add a tiny HTTP polling bridge for the PT6-compatible interface.js.
HTTP_POLL_STALE_S = float(os.environ.get("CISCO_PT_MCP_HTTP_POLL_STALE", "10"))


class PTBridge:
    """Async Socket.IO server that proxies MCP tool calls to the PT plugin."""

    def __init__(
        self,
        host: str = BRIDGE_HOST,
        port: int = BRIDGE_PORT,
        tool_timeout: float = TOOL_TIMEOUT_S,
    ) -> None:
        self.host = host
        self.port = port
        self.tool_timeout = tool_timeout

        # cors_allowed_origins="*" is safe — the listener is bound to loopback.
        self._sio = socketio.AsyncServer(
            async_mode="aiohttp",
            cors_allowed_origins="*",
            logger=False,
            engineio_logger=False,
        )
        self._app = web.Application()
        self._sio.attach(self._app)

        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None

        # Single-plugin model. If a second plugin connects, kick the first.
        self._sid: str | None = None
        self._connected = asyncio.Event()
        self._pending: dict[str, asyncio.Future[dict]] = {}
        self._http_client_id: str | None = None
        self._http_last_poll = 0.0
        self._http_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        self._register_handlers()
        self._register_http_handlers()

    async def start(self) -> None:
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.host, self.port)
        await self._site.start()
        log.info("PT bridge listening on http://%s:%d", self.host, self.port)

    async def stop(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(RuntimeError("bridge stopped"))
        self._pending.clear()
        if self._site is not None:
            await self._site.stop()
            self._site = None
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    def _register_handlers(self) -> None:
        sio = self._sio

        @sio.event
        async def connect(sid: str, environ: dict, auth: Any = None) -> None:
            log.info("PT plugin connected sid=%s", sid)
            old_sid = self._sid
            self._sid = sid
            self._connected.set()
            if old_sid is not None and old_sid != sid:
                # A previous plugin is still attached. Drop it so we don't
                # silently route traffic to a stale sid.
                log.info("disconnecting older PT plugin sid=%s", old_sid)
                try:
                    await sio.disconnect(old_sid)
                except Exception:  # noqa: BLE001
                    pass

        @sio.event
        async def disconnect(sid: str) -> None:
            log.info("PT plugin disconnected sid=%s", sid)
            if self._sid == sid:
                self._sid = None
                self._connected.clear()
                # Fail outstanding tool calls — the plugin can't answer them.
                for tcid, fut in list(self._pending.items()):
                    if not fut.done():
                        fut.set_exception(
                            RuntimeError("PT plugin disconnected mid-call")
                        )
                    self._pending.pop(tcid, None)

        @sio.on("tool_result")
        async def on_tool_result(_sid: str, data: dict[str, Any] | None) -> None:
            if not isinstance(data, Mapping):
                log.warning("tool_result must be an object: %r", data)
                return

            tcid = data.get("tool_call_id")
            if not isinstance(tcid, str) or not tcid:
                log.warning("tool_result missing tool_call_id: %r", data)
                return

            fut = self._pending.pop(tcid, None)
            if fut is None or fut.done():
                return

            if data.get("tool_name") is not None and not isinstance(data.get("tool_name"), str):
                fut.set_exception(PTBridgeProtocolError("tool_result field 'tool_name' must be a string when present"))
                return

            tool_input = data.get("tool_input")
            if tool_input is not None and not isinstance(tool_input, Mapping):
                fut.set_exception(PTBridgeProtocolError("tool_result field 'tool_input' must be an object when present"))
                return

            if "result" not in data:
                fut.set_exception(PTBridgeProtocolError("tool_result missing required field 'result'"))
                return

            fut.set_result(_coerce_tool_result(data.get("result")))

    def _register_http_handlers(self) -> None:
        self._app.router.add_route("OPTIONS", "/pt6/poll", self._handle_pt6_options)
        self._app.router.add_route("OPTIONS", "/pt6/result", self._handle_pt6_options)
        self._app.router.add_get("/pt6/poll", self._handle_pt6_poll)
        self._app.router.add_post("/pt6/result", self._handle_pt6_result)

    @staticmethod
    def _with_cors(response: web.Response) -> web.Response:
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Cache-Control"] = "no-store"
        return response

    def _json_response(self, payload: Mapping[str, Any], status: int = 200) -> web.Response:
        return self._with_cors(web.json_response(dict(payload), status=status))

    async def _handle_pt6_options(self, _request: web.Request) -> web.Response:
        return self._with_cors(web.Response(status=204))

    async def _handle_pt6_poll(self, request: web.Request) -> web.Response:
        client_id = request.query.get("client_id") or "pt6"
        if self._http_client_id is not None and self._http_client_id != client_id:
            log.info("PT6 HTTP bridge client changed %s -> %s", self._http_client_id, client_id)
        self._http_client_id = client_id
        self._http_last_poll = time.monotonic()
        self._connected.set()

        try:
            tool_call = self._http_queue.get_nowait()
        except asyncio.QueueEmpty:
            tool_call = None

        return self._json_response(
            {
                "success": True,
                "transport": "pt6-http-poll",
                "client_id": client_id,
                "tool_call": tool_call,
            }
        )

    async def _handle_pt6_result(self, request: web.Request) -> web.Response:
        try:
            raw = await request.text()
            data = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            return self._json_response({"success": False, "error": f"bad json: {exc}"}, status=400)

        if not isinstance(data, Mapping):
            return self._json_response({"success": False, "error": "result must be an object"}, status=400)

        try:
            self._complete_tool_result(data)
        except PTBridgeProtocolError as exc:
            return self._json_response({"success": False, "error": str(exc)}, status=400)

        return self._json_response({"success": True})

    def _complete_tool_result(self, data: Mapping[str, Any]) -> None:
        tcid = data.get("tool_call_id")
        if not isinstance(tcid, str) or not tcid:
            raise PTBridgeProtocolError("tool_result missing tool_call_id")

        fut = self._pending.pop(tcid, None)
        if fut is None or fut.done():
            return

        if data.get("tool_name") is not None and not isinstance(data.get("tool_name"), str):
            fut.set_exception(PTBridgeProtocolError("tool_result field 'tool_name' must be a string when present"))
            return

        tool_input = data.get("tool_input")
        if tool_input is not None and not isinstance(tool_input, Mapping):
            fut.set_exception(PTBridgeProtocolError("tool_result field 'tool_input' must be an object when present"))
            return

        if "result" not in data:
            fut.set_exception(PTBridgeProtocolError("tool_result missing required field 'result'"))
            return

        fut.set_result(_coerce_tool_result(data.get("result")))

    def _http_is_connected(self) -> bool:
        return (
            self._http_client_id is not None
            and (time.monotonic() - self._http_last_poll) <= HTTP_POLL_STALE_S
        )

    @property
    def is_connected(self) -> bool:
        connected = self._sid is not None or self._http_is_connected()
        if not connected:
            self._connected.clear()
        return connected

    async def wait_until_connected(self, timeout: float | None = None) -> None:
        if self.is_connected:
            return
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                f"Packet Tracer plugin did not connect within {timeout:.0f}s. "
                "Open Packet Tracer with the cisco-pt-mcp bridge plugin loaded."
            ) from exc

    async def call_tool(self, tool_name: str, tool_input: dict[str, Any]) -> dict:
        """Send tool_call, await tool_result, return its ``result`` payload."""
        if self._sid is None and not self._http_is_connected():
            raise RuntimeError(
                "No Packet Tracer plugin connected. Open Packet Tracer with "
                "the cisco-pt-mcp bridge plugin loaded."
            )

        tcid = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict] = loop.create_future()
        self._pending[tcid] = fut

        payload = {"tool_call_id": tcid, "tool_name": tool_name, "tool_input": tool_input}
        if self._sid is not None:
            await self._sio.emit("tool_call", payload, to=self._sid)
        else:
            await self._http_queue.put(payload)

        try:
            return await asyncio.wait_for(fut, timeout=self.tool_timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(tcid, None)
            raise RuntimeError(
                f"Tool '{tool_name}' timed out after {self.tool_timeout:.0f}s "
                f"waiting for the Packet Tracer plugin"
            ) from exc


def _normalize_pt6_json(value: Any) -> Any:
    """Normalize PT6 WebView JSON quirks into ordinary Python JSON shapes."""
    if isinstance(value, list):
        return [_normalize_pt6_json(item) for item in value]

    if not isinstance(value, Mapping):
        return value

    length = value.get("length")
    if isinstance(length, int) and length >= 0:
        allowed = {"length"}
        for index in range(length):
            allowed.add(str(index))
            allowed.add(index)
        if set(value.keys()).issubset(allowed):
            return [
                _normalize_pt6_json(value.get(str(index), value.get(index)))
                for index in range(length)
            ]

    return {
        str(key): _normalize_pt6_json(item)
        for key, item in value.items()
    }


def _coerce_tool_result(result: Any) -> dict[str, Any]:
    """Accept both modern object results and older PTBuilder boolean returns."""
    normalized = _normalize_pt6_json(result)
    if isinstance(normalized, Mapping):
        return dict(normalized)
    if isinstance(normalized, bool):
        if normalized:
            return {"success": True, "result": True}
        return {"success": False, "error": "Packet Tracer returned false", "result": False}
    return {"success": True, "result": normalized}
