/* global $se */
(function () {
  var MCP_URL = "http://127.0.0.1:7531";
  var CLIENT_ID = "pt6-" + String(Math.floor(Math.random() * 1000000000));
  var toolsHandled = 0;

  var statusText = document.getElementById("status-text");
  var sid = document.getElementById("sid");
  var toolCount = document.getElementById("tool-count");
  var logBox = document.getElementById("log");

  function setText(el, text) {
    if (!el) return;
    if (typeof el.textContent !== "undefined") {
      el.textContent = text;
    } else {
      el.innerText = text;
    }
  }

  function setStatus(state, label) {
    if (statusText) {
      statusText.className = state;
      setText(statusText, label || state);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function logLine(text, cls) {
    if (!logBox) return;
    var now = new Date();
    var ts = now.toTimeString().slice(0, 8);
    var line = document.createElement("div");
    line.className = cls || "";
    line.innerHTML = escapeHtml(ts + "  " + text);
    logBox.appendChild(line);
    while (logBox.childNodes.length > 200) {
      logBox.removeChild(logBox.firstChild);
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  function http(method, url, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        callback(xhr.status, xhr.responseText);
      }
    };
    if (method === "POST") {
      xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
    }
    try {
      xhr.send(body || null);
    } catch (err) {
      callback(0, String(err && err.message ? err.message : err));
    }
  }

  function buildErrorResult(tool, args, message) {
    return {
      success: false,
      error: message,
      tool: tool,
      args: args
    };
  }

  function serializePTArgument(value) {
    if (typeof value === "string") {
      return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    }
    if (value === null || typeof value === "undefined") return "undefined";
    if (typeof value === "boolean") return String(value);
    if (isArray(value) || typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function unwrapRunCodePayload(wrapped) {
    var payload = wrapped;
    if (typeof wrapped === "string") {
      try {
        payload = JSON.parse(wrapped);
      } catch (ignore) {
        payload = wrapped;
      }
    }
    if (payload && typeof payload === "object" &&
        typeof payload.result !== "undefined" &&
        typeof payload.success !== "undefined" &&
        typeof payload.code !== "undefined") {
      return payload.result;
    }
    return payload;
  }

  function executePTCode(funcName, args) {
    var argsStr = [];
    var i;
    for (i = 0; i < args.length; i++) {
      argsStr.push(serializePTArgument(args[i]));
    }
    return unwrapRunCodePayload($se("runCode", "return " + funcName + "(" + argsStr.join(", ") + ");"));
  }

  var TOOL_ARGS = {
    addDevice: ["deviceName", "deviceModel", "x", "y"],
    addModule: ["deviceName", "slot", "model"],
    addLink: ["device1Name", "device1Interface", "device2Name", "device2Interface", "linkType"],
    removeDevice: ["deviceNames"],
    removeLink: ["links"],
    configurePcIp: ["deviceName", "dhcpEnabled", "ipaddress", "subnetMask", "defaultGateway", "dnsServer"],
    configureIosDevice: ["deviceName", "commands"],
    getNetwork: [],
    getDeviceInfo: ["deviceName"],
    setSimulationMode: ["toSimMode"],
    getSimulationStatus: [],
    stepSimulation: ["direction", "steps"],
    sendPdu: ["sourceDevice", "destinationDevice"],
    renameDevice: ["deviceName", "newName"],
    moveDevice: ["deviceName", "x", "y"],
    setPower: ["deviceName", "power"],
    getPduResults: ["types"],
    getCommandLog: ["deviceName", "limit"],
    debugEval: ["code"]
  };

  var TOOL_FUNC = {
    addDevice: "mcpAddDevice",
    addModule: "mcpAddModule",
    addLink: "mcpAddLink",
    removeDevice: "mcpRemoveDevice",
    removeLink: "mcpRemoveLink",
    configurePcIp: "mcpConfigurePcIp",
    configureIosDevice: "mcpConfigureIosDevice",
    getNetwork: "getNetwork",
    getDeviceInfo: "mcpGetDeviceInfo",
    setSimulationMode: "mcpSetSimulationMode",
    getSimulationStatus: "mcpGetSimulationStatus",
    stepSimulation: "mcpStepSimulation",
    sendPdu: "mcpSendPdu",
    renameDevice: "mcpRenameDevice",
    moveDevice: "mcpMoveDevice",
    setPower: "mcpSetPower",
    getPduResults: "mcpGetPduResults",
    getCommandLog: "mcpGetCommandLog",
    debugEval: "mcpDebugEval"
  };

  function buildPositionalArgs(tool, input) {
    var spec = TOOL_ARGS[tool];
    var out = [];
    var i;
    if (!spec) return null;
    input = input || {};
    for (i = 0; i < spec.length; i++) {
      out.push(input[spec[i]]);
    }
    return out;
  }

  function postResult(call, result, done) {
    var payload = {
      tool_call_id: call.tool_call_id,
      tool_name: call.tool_name,
      tool_input: call.tool_input || {},
      result: result
    };
    http("POST", MCP_URL + "/pt6/result", JSON.stringify(payload), function (status, text) {
      if (status >= 200 && status < 300) {
        done();
      } else {
        logLine("result post failed: " + status + " " + text, "err");
        setTimeout(done, 1000);
      }
    });
  }

  function handleToolCall(call, done) {
    var tool = call && call.tool_name;
    var args = (call && call.tool_input) || {};
    var positional;
    var result;

    if (!call || !call.tool_call_id || !tool) {
      logLine("malformed tool_call", "err");
      done();
      return;
    }

    positional = buildPositionalArgs(tool, args);
    if (!positional) {
      result = buildErrorResult(tool, args, "unsupported tool: " + tool);
      postResult(call, result, done);
      return;
    }

    logLine("-> " + tool + " " + JSON.stringify(args).slice(0, 80));
    try {
      result = executePTCode(TOOL_FUNC[tool] || tool, positional);
      toolsHandled++;
      setText(toolCount, String(toolsHandled));
      logLine("<- " + tool + (result && result.success === false ? " err" : " ok"), result && result.success === false ? "err" : "ok");
    } catch (err) {
      result = buildErrorResult(tool, args, String(err && err.message ? err.message : err));
      toolsHandled++;
      setText(toolCount, String(toolsHandled));
      logLine("<- " + tool + " threw: " + result.error, "err");
    }

    postResult(call, result, done);
  }

  function poll() {
    var url = MCP_URL + "/pt6/poll?client_id=" + encodeURIComponent(CLIENT_ID) + "&_=" + String(new Date().getTime());
    http("GET", url, null, function (status, text) {
      var data;
      if (status < 200 || status >= 300) {
        setStatus("offline", "offline");
        logLine("poll failed: " + status + " " + text, "err");
        setTimeout(poll, 1500);
        return;
      }

      try {
        data = JSON.parse(text);
      } catch (err) {
        setStatus("offline", "bad response");
        logLine("bad poll response: " + text, "err");
        setTimeout(poll, 1500);
        return;
      }

      setStatus("connected", "connected");
      setText(sid, CLIENT_ID);

      if (data && data.tool_call) {
        handleToolCall(data.tool_call, function () {
          setTimeout(poll, 100);
        });
      } else {
        setTimeout(poll, 750);
      }
    });
  }

  setStatus("connecting", "connecting");
  setText(sid, CLIENT_ID);
  logLine("polling " + MCP_URL + "/pt6/poll");
  poll();
}());
