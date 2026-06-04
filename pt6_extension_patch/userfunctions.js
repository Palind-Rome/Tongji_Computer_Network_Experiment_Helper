// User-callable functions exposed by the cisco-pt-mcp bridge.
// Each returns { success: bool, ... } and is invoked via $se('runCode', 'return <fn>(<args>);').

function fail(prefix, err) {
  var msg = (err && (err.message || String(err))) || "unknown error";
  return { success: false, error: prefix ? prefix + ": " + msg : msg };
}

function dismissIosInitialDialog(device) {
  try {
    if (!device) return false;
    if (typeof device.skipBoot === "function") device.skipBoot();

    var line = typeof device.getCommandLine === "function" ? device.getCommandLine() : null;
    if (!line || typeof line.enterCommand !== "function") return false;

    var changed = false;
    for (var i = 0; i < 5; i++) {
      var prompt = typeof line.getPrompt === "function" ? String(line.getPrompt()) : "";
      var output = typeof line.getOutput === "function" ? String(line.getOutput()) : "";
      var tail = output.slice(Math.max(0, output.length - 500));

      if (prompt.indexOf(">") >= 0 || prompt.indexOf("#") >= 0) break;
      if (
        prompt.indexOf("Continue with configuration dialog") >= 0 ||
        tail.indexOf("Continue with configuration dialog") >= 0
      ) {
        line.enterCommand("no");
        changed = true;
        continue;
      }
      if (prompt === "" || tail.indexOf("Press RETURN to get started") >= 0) {
        line.enterCommand("");
        changed = true;
        continue;
      }
      break;
    }
    return changed;
  } catch (ignoreDialogError) {
    return false;
  }
}

addDevice = function (deviceName, deviceModel, x, y) {
  try {
    var deviceType = allDeviceTypes[deviceModel];

    if (deviceType === undefined) {
      return {
        success: false,
        error: "Unknown device model: " + deviceModel,
      };
    }

    var logicalWorkspace = ipc
      .appWindow()
      .getActiveWorkspace()
      .getLogicalWorkspace();

    // PT 6.0 exposes addDevice(DeviceType, model). Newer PT versions add x/y
    // parameters, so position the component separately after creation.
    var originalDeviceName = logicalWorkspace.addDevice(deviceType, deviceModel);

    if (!originalDeviceName) {
      return {
        success: false,
        error: "Failed to add device " + deviceName + " (" + deviceModel + ")",
      };
    }

    try {
      var componentItem = logicalWorkspace.getComponentItem(originalDeviceName);
      if (componentItem && typeof componentItem.moveTo === "function") {
        componentItem.moveTo(x, y);
      }
    } catch (ignoreMoveError) {
    }

    var device = ipc.network().getDevice(originalDeviceName);
    device.setName(deviceName);

    if (deviceType <= 1 || deviceType == 16) {
      device.skipBoot();
    }

    return {
      success: true,
      message: "Device " + deviceName + " added successfully",
    };
  } catch (error) {
    return fail("Error adding device", error);
  }
};

addModule = function (deviceName, slot, model) {
  try {
    var device = ipc.network().getDevice(deviceName);

    if (!device) {
      return {
        success: false,
        error: "Device " + deviceName + " not found",
      };
    }

    var moduleType = allModuleTypes[model];

    if (moduleType === undefined) {
      return {
        success: false,
        error: "Unknown module model: " + model,
      };
    }

    var powerState = device.getPower();
    device.setPower(false);

    var result = device.addModule(slot, moduleType, model);

    if (powerState) {
      device.setPower(true);
      device.skipBoot();
    }

    if (result != true) {
      return {
        success: false,
        error: "Failed to add module " + model + " to slot " + slot + " on " + deviceName,
      };
    }

    return {
      success: true,
      message: "Module " + model + " added to " + deviceName + " slot " + slot,
    };
  } catch (error) {
    return fail("Error adding module", error);
  }
};

addLink = function (
  device1Name,
  device1Interface,
  device2Name,
  device2Interface,
  linkType
) {
  try {
    var linkTypeValue = allLinkTypes[linkType];

    if (linkTypeValue === undefined) {
      return {
        success: false,
        error: "Unknown link type: " + linkType,
      };
    }

    var result = ipc
      .appWindow()
      .getActiveWorkspace()
      .getLogicalWorkspace()
      .createLink(
        device1Name,
        device1Interface,
        device2Name,
        device2Interface,
        linkTypeValue
      );

    if (result != true) {
      return {
        success: false,
        error: "Failed to create link between " + device1Name + ":" + device1Interface + " and " + device2Name + ":" + device2Interface,
      };
    }

    return {
      success: true,
      message: "Link created between " + device1Name + " and " + device2Name,
    };
  } catch (error) {
    return fail("Error creating link", error);
  }
};

configurePcIp = function (
  deviceName,
  dhcpEnabled,
  ipaddress,
  subnetMask,
  defaultGateway,
  dnsServer
) {
  try {
    var device = ipc.network().getDevice(deviceName);

    if (!device) {
      return {
        success: false,
        error: "Device " + deviceName + " not found",
      };
    }

    var port = device.getPort("FastEthernet0");

    if (!port) {
      return {
        success: false,
        error: "FastEthernet0 port not found on " + deviceName,
      };
    }

    if (dhcpEnabled !== undefined && dhcpEnabled !== null &&
        typeof port.setDhcpClientFlag === "function") {
      port.setDhcpClientFlag(dhcpEnabled);
    } else if (dhcpEnabled !== undefined && dhcpEnabled !== null &&
        typeof device.setDhcpFlag === "function") {
      device.setDhcpFlag(dhcpEnabled);
    }
    if (ipaddress && subnetMask) port.setIpSubnetMask(ipaddress, subnetMask);
    if (defaultGateway && typeof device.setDefaultGateway === "function") {
      device.setDefaultGateway(defaultGateway);
    } else if (defaultGateway && typeof port.setDefaultGateway === "function") {
      port.setDefaultGateway(defaultGateway);
    }
    if (dnsServer && typeof device.setDnsServerIp === "function") {
      device.setDnsServerIp(dnsServer);
    } else if (dnsServer && typeof port.setDnsServerIp === "function") {
      port.setDnsServerIp(dnsServer);
    }

    return {
      success: true,
      message: "IP configuration applied to " + deviceName,
    };
  } catch (error) {
    return fail("Error configuring PC IP", error);
  }
};

configureIosDevice = function (deviceName, commands) {
  try {
    var device = ipc.network().getDevice(deviceName);

    if (!device) {
      return {
        success: false,
        error: "Device " + deviceName + " not found",
      };
    }

    var commandsArray = commands.split("\n");
    dismissIosInitialDialog(device);

    var line = typeof device.getCommandLine === "function" ? device.getCommandLine() : null;
    if (line && typeof line.enterCommand === "function") {
      line.enterCommand("enable");
      line.enterCommand("configure terminal");

      for (var c = 0; c < commandsArray.length; c++) {
        var command = commandsArray[c].replace(/^\s+|\s+$/g, "");
        if (command) {
          line.enterCommand(command);
        }
      }

      line.enterCommand("end");
      line.enterCommand("write memory");
    } else {
      device.enterCommand("!", "global");

      for (var f = 0; f < commandsArray.length; f++) {
        var fallbackCommand = commandsArray[f].replace(/^\s+|\s+$/g, "");
        if (fallbackCommand) {
          device.enterCommand(fallbackCommand, "");
        }
      }

      device.enterCommand("write memory", "enable");
    }

    dismissIosInitialDialog(device);

    return {
      success: true,
      message: "Configuration applied to " + deviceName + " (" + commandsArray.length + " commands)",
    };
  } catch (error) {
    return fail("Error configuring IOS device", error);
  }
};

getNetwork = function () {
  try {
    var deviceCount = ipc.network().getDeviceCount();
    var devices = [];
    var connections = [];

    // PT 6.0 does not expose ipc.network().getLinkCount()/getLinkAt().
    // It exposes links from each port instead: port.getLink().getOtherPortConnectedTo(port).
    var allPorts = [];
    for (var i = 0; i < deviceCount; i++) {
      var device = ipc.network().getDeviceAt(i);
      var deviceName = device.getName();

      var interfaces = [];
      var portCount = device.getPortCount();
      for (var j = 0; j < portCount; j++) {
        var port = device.getPortAt(j);
        if (port) {
          var pname = port.getName();
          var inUse = false;
          try {
            inUse = !!port.getLink();
          } catch (ignoreLinkError) {
            inUse = false;
          }
          interfaces.push({ name: pname, in_use: inUse });
          allPorts.push({
            deviceName: deviceName,
            portName: pname,
            port: port,
          });
        }
      }

      devices.push({
        name: deviceName,
        model: device.getModel(),
        type: device.getType(),
        interfaces: interfaces,
      });
    }

    for (var p = 0; p < allPorts.length; p++) {
      var entry = allPorts[p];
      var linkObj = null;
      var otherPort = null;
      try {
        linkObj = entry.port.getLink();
        if (linkObj) {
          otherPort = linkObj.getOtherPortConnectedTo(entry.port);
        }
      } catch (ignoreConnectionError) {
        linkObj = null;
        otherPort = null;
      }

      if (otherPort) {
        var otherName = otherPort.getName();
        var otherDeviceName = "";
        for (var q = 0; q < allPorts.length; q++) {
          if (allPorts[q].port === otherPort) {
            otherDeviceName = allPorts[q].deviceName;
            break;
          }
        }

        var keyA = entry.deviceName + ":" + entry.portName;
        var keyB = otherDeviceName + ":" + otherName;
        if (otherDeviceName && keyA < keyB) {
          var linkType = "";
          try {
            linkType = linkObj.getConnectionType();
          } catch (ignoreTypeError) {
            linkType = "";
          }
          connections.push({
            from: entry.deviceName,
            fromInterface: entry.portName,
            to: otherDeviceName,
            toInterface: otherName,
            type: linkType,
          });
        }
      }
    }

    if (connections.length === 0) {
      // Object identity for IPC proxy objects is not always stable in PT 6.0.
      // Keep the snapshot useful even if exact endpoint pairing cannot be recovered.
      for (var r = 0; r < allPorts.length; r++) {
        var e = allPorts[r];
        var hasLink = false;
        try {
          hasLink = !!e.port.getLink();
        } catch (ignoreHasLinkError) {
          hasLink = false;
        }
        if (hasLink) {
          // Leave connection details to getDeviceInfo/visual inspection for now.
        }
      }
    }

    return {
      success: true,
      result: {
        deviceCount: devices.length,
        connectionCount: connections.length,
        devices: devices,
        connections: connections,
      },
    };
  } catch (error) {
    return fail("", error);
  }
};

getDeviceInfo = function (deviceName) {
  try {
    var net = getNetwork();
    if (!net || !net.success) {
      return net || { success: false, error: "getNetwork failed" };
    }
    var devices = net.result.devices;
    var connections = net.result.connections;
    for (var i = 0; i < devices.length; i++) {
      if (devices[i].name === deviceName) {
        var related = [];
        for (var j = 0; j < connections.length; j++) {
          var c = connections[j];
          if (c.from === deviceName || c.to === deviceName) related.push(c);
        }
        return {
          success: true,
          result: {
            device: devices[i],
            connections: related,
          },
        };
      }
    }
  return {
    success: false,
    error: "Device " + deviceName + " not found",
  };
  } catch (error) {
    return fail("Error getting device info", error);
  }
};

removeDevice = function (deviceNames) {
  try {
    var devicesToRemove = [];
    if (typeof deviceNames === "string") {
      devicesToRemove = [deviceNames];
    } else if (Array.isArray(deviceNames)) {
      devicesToRemove = deviceNames;
    } else {
      return {
        success: false,
        error:
          "Invalid input: provide a device name string or array of device names",
      };
    }

    var workspace = ipc.appWindow().getActiveWorkspace().getLogicalWorkspace();
    var results = [];
    var successCount = 0;
    var failCount = 0;

    for (var i = 0; i < devicesToRemove.length; i++) {
      var deviceName = devicesToRemove[i];
      var device = ipc.network().getDevice(deviceName);

      if (!device) {
        results.push({
          device: deviceName,
          success: false,
          error: "Device not found",
        });
        failCount++;
      } else {
        var result = workspace.removeDevice(deviceName);

        if (result === true) {
          results.push({
            device: deviceName,
            success: true,
            message: "Removed successfully",
          });
          successCount++;
        } else {
          results.push({
            device: deviceName,
            success: false,
            error: "Failed to remove",
          });
          failCount++;
        }
      }
    }

    return {
      success: failCount === 0,
      totalDevices: devicesToRemove.length,
      successCount: successCount,
      failCount: failCount,
      results: results,
    };
  } catch (error) {
    return fail("Error removing devices", error);
  }
};

setSimulationMode = function (toSimMode) {
  try {
    var app = ipc.appWindow();
    var sim = ipc.simulation();
    var current = app.isSimulationMode ? app.isSimulationMode() : sim.isSimulationMode();
    if (current === toSimMode) {
      return {
        success: true,
        message: "Already in " + (toSimMode ? "simulation" : "realtime") + " mode",
        mode: toSimMode ? "simulation" : "realtime",
      };
    }
    if (typeof sim.setSimulationMode === "function") {
      sim.setSimulationMode(toSimMode);
    } else if (toSimMode) {
      app.getRSSwitch().showSimulationMode();
    } else {
      app.getRSSwitch().showRealtimeMode();
    }
    return {
      success: true,
      message: "Switched to " + (toSimMode ? "simulation" : "realtime") + " mode",
      mode: toSimMode ? "simulation" : "realtime",
    };
  } catch (error) {
    return fail("Error setting simulation mode", error);
  }
};

getSimulationStatus = function () {
  try {
    var app = ipc.appWindow();
    var sim = ipc.simulation();
    var isSimMode = app.isSimulationMode ? app.isSimulationMode() : sim.isSimulationMode();
    var result = {
      mode: isSimMode ? "simulation" : "realtime",
      frameCount: sim.getFrameInstanceCount ? sim.getFrameInstanceCount() : 0,
    };
    if (isSimMode && typeof sim.getCurrentSimTime === "function") {
      result.currentTime = sim.getCurrentSimTime();
    }
    if (isSimMode && typeof sim.getCurrentFrameInstanceIndex === "function") {
      result.currentFrameIndex = sim.getCurrentFrameInstanceIndex();
    }
    return { success: true, result: result };
  } catch (error) {
    return fail("Error getting simulation status", error);
  }
};

stepSimulation = function (direction, steps) {
  try {
    var sim = ipc.simulation();
    if (!sim.isSimulationMode()) {
      return {
        success: false,
        error: "Not in simulation mode. Call setSimulationMode(true) first.",
      };
    }
    var panel = ipc.appWindow().getSimulationPanel();
    if (direction === "reset") {
      if (typeof sim.resetSimulation === "function") sim.resetSimulation();
      else panel.resetSimulation();
      return { success: true, message: "Simulation reset" };
    }
    var n = steps && steps >= 1 ? Math.min(steps, 100) : 1;
    for (var i = 0; i < n; i++) {
      if (direction === "forward") {
        if (typeof sim.forward === "function") sim.forward();
        else panel.forward();
      } else if (direction === "backward") {
        if (typeof sim.backward === "function") sim.backward();
        else panel.back();
      } else {
        return { success: false, error: "Unknown direction: " + direction };
      }
    }
    return {
      success: true,
      message: direction + " " + n + " step(s)",
      frameCount: sim.getFrameInstanceCount(),
    };
  } catch (error) {
    return fail("Error stepping simulation", error);
  }
};

var PDU_TRAFFIC_TYPES = {
  ICMP: 0,
  TCP: 1,
  UDP: 2,
  HTTP: 17,
  HTTPS: 18,
  DNS: 19,
};

sendPdu = function (sourceDevice, destinationDevice) {
  try {
    var source = ipc.network().getDevice(sourceDevice);
    var destination = ipc.network().getDevice(destinationDevice);
    if (!source) {
      return { success: false, error: "Source device not found: " + sourceDevice };
    }
    if (!destination) {
      return { success: false, error: "Destination device not found: " + destinationDevice };
    }

    var userCreatedPdu = ipc.appWindow().getUserCreatedPDU();
    if (userCreatedPdu && typeof userCreatedPdu.addSimplePdu === "function") {
      var sim = ipc.simulation();
      var modeEnabled = false;
      if (!sim.isSimulationMode()) {
        setSimulationMode(true);
        modeEnabled = true;
      }
      var errCode = userCreatedPdu.addSimplePdu(sourceDevice, destinationDevice);
      var errStr = String(errCode);
      if (errCode && errStr !== "0") {
        return { success: false, error: "PT rejected PDU (ADD_PDU_ERROR=" + errStr + ")" };
      }
      return {
        success: true,
        message: "ICMP PDU added from " + sourceDevice + " to " + destinationDevice,
        simulationModeEnabled: modeEnabled,
      };
    }

    var destinationIp = "";
    for (var p = 0; p < destination.getPortCount(); p++) {
      var port = destination.getPortAt(p);
      if (!port || typeof port.getIpAddress !== "function") continue;
      var ip = String(port.getIpAddress());
      if (ip && ip !== "0.0.0.0") {
        destinationIp = ip;
        break;
      }
    }
    if (!destinationIp) {
      return { success: false, error: "Destination device has no IPv4 address: " + destinationDevice };
    }

    var line = source.getCommandLine();
    if (!line || typeof line.enterCommand !== "function") {
      return { success: false, error: "Source device has no command line: " + sourceDevice };
    }
    dismissIosInitialDialog(source);
    var command = "ping " + destinationIp;
    line.enterCommand(command);
    return {
      success: true,
      message: "Started ping command from " + sourceDevice + " to " + destinationDevice,
      result: {
        sourceDevice: sourceDevice,
        destinationDevice: destinationDevice,
        destinationIp: destinationIp,
        command: command,
        initialOutput: typeof line.getOutput === "function" ? line.getOutput() : "",
      },
    };
  } catch (error) {
    return fail("Error sending PDU", error);
  }
};

renameDevice = function (deviceName, newName) {
  try {
    var device = ipc.network().getDevice(deviceName);
    if (!device) {
      return { success: false, error: "Device not found: " + deviceName };
    }
    device.setName(newName);
    return { success: true, message: "Renamed " + deviceName + " to " + newName };
  } catch (error) {
    return fail("Error renaming device", error);
  }
};

moveDevice = function (deviceName, x, y) {
  try {
    var device = ipc.network().getDevice(deviceName);
    if (!device) {
      return { success: false, error: "Device not found: " + deviceName };
    }
    device.moveToLocation(x, y);
    return {
      success: true,
      message: "Moved " + deviceName + " to (" + x + ", " + y + ")",
    };
  } catch (error) {
    return fail("Error moving device", error);
  }
};

// Maps both numeric and C++ enum-string forms of eTrafficType to readable names.
// PT's JS host may expose the enum as "0" or as "eTrafficType_Icmp" — handle both.
var TRAFFIC_TYPE_NAMES = {
  "0": "ICMP",  "eTrafficType_Icmp": "ICMP",
  "1": "TCP",   "eTrafficType_Tcp": "TCP",
  "2": "UDP",   "eTrafficType_Udp": "UDP",
  "3": "RIPv1", "eTrafficType_RipV1": "RIPv1",
  "4": "RIPv2", "eTrafficType_RipV2": "RIPv2",
  "5": "ARP",   "eTrafficType_Arp": "ARP",
  "6": "CDP",   "eTrafficType_Cdp": "CDP",
  "7": "DHCP",  "eTrafficType_Dhcp": "DHCP",
  "11": "STP",  "eTrafficType_Stp": "STP",
  "12": "OSPF", "eTrafficType_Ospf": "OSPF",
  "13": "DTP",  "eTrafficType_Dtp": "DTP",
  "17": "HTTP", "eTrafficType_Http": "HTTP",
  "18": "HTTPS","eTrafficType_Https": "HTTPS",
  "19": "DNS",  "eTrafficType_Dns": "DNS",
  "36": "BGP",  "eTrafficType_Bgp": "BGP",
  "1000": "Custom", "eTrafficType_Custom": "Custom",
};

getPduResults = function (types) {
  try {
    var sim = ipc.simulation();
    if (!sim.isSimulationMode()) {
      return { success: false, error: "Not in simulation mode. Call setSimulationMode(true) first." };
    }

    var typeFilter = null;
    if (Array.isArray(types) && types.length > 0) {
      typeFilter = {};
      for (var t = 0; t < types.length; t++) typeFilter[types[t].toUpperCase()] = true;
    }

    var total = sim.getFrameInstanceCount();
    var frames = [];
    for (var i = 0; i < total; i++) {
      var fi = sim.getFrameInstanceAt(i);
      if (!fi) continue;

      var rawType = String(fi.getUserTrafficType());
      var typeName = TRAFFIC_TYPE_NAMES[rawType] || rawType;

      if (typeFilter && !typeFilter[typeName.toUpperCase()]) continue;

      var status = "unknown";
      if (fi.isFrameAccepted())          status = "accepted";
      else if (fi.isFrameDropped())      status = "dropped";
      else if (fi.isFrameNotForwarded()) status = "not_forwarded";
      else if (fi.isFrameUnexpected())   status = "unexpected";
      else if (fi.isFrameCollidedOnLink() || fi.isFrameCollidedAtDevice()) status = "collision";
      else if (fi.isFrameBuffered())     status = "buffered";
      else if (fi.isFrameOnTransit())    status = "in_transit";
      else if (fi.isFrameSent())         status = "sent";

      frames.push({
        index: i,
        source: fi.getSourceString(),
        destination: fi.getDestinationString(),
        trafficType: typeName,
        status: status,
      });
    }
    return {
      success: true,
      result: { totalFrames: total, shown: frames.length, frames: frames },
    };
  } catch (error) {
    return fail("Error getting PDU results", error);
  }
};

getCommandLog = function (deviceName, limit) {
  try {
    var log = ipc.commandLog();
    var total = log.getEntryCount();
    var cap = limit && limit > 0 ? Math.min(limit, 500) : 50;
    var entries = [];

    for (var i = total - 1; i >= 0 && entries.length < cap; i--) {
      var entry = log.getEntryAt(i);
      if (!entry) continue;
      var dev = entry.getDeviceName();
      if (deviceName && dev !== deviceName) continue;
      entries.push({
        timestamp: entry.getTimeToString(),
        device: dev,
        prompt: entry.getPrompt(),
        command: entry.getCommand(),
        resolvedCommand: entry.getResolvedCommand(),
      });
    }

    return {
      success: true,
      result: { totalEntries: total, returned: entries.length, entries: entries },
    };
  } catch (error) {
    return fail("Error getting command log", error);
  }
};

mcpDebugEval = function (code) {
  try {
    var fn = new Function(code);
    return {
      success: true,
      result: fn(),
    };
  } catch (error) {
    return fail("debugEval", error);
  }
};

setPower = function (deviceName, power) {
  try {
    var device = ipc.network().getDevice(deviceName);
    if (!device) {
      return { success: false, error: "Device not found: " + deviceName };
    }
    device.setPower(power);
    return {
      success: true,
      message: deviceName + " powered " + (power ? "on" : "off"),
    };
  } catch (error) {
    return fail("Error setting device power", error);
  }
};

removeLink = function (links) {
  try {
    var linksToRemove = [];

    if (typeof links === "object" && links !== null && !Array.isArray(links)) {
      linksToRemove = [links];
    } else if (Array.isArray(links)) {
      linksToRemove = links;
    } else {
      return {
        success: false,
        error:
          "Invalid input: provide link object {device, port} or array of link objects",
      };
    }

    var workspace = ipc.appWindow().getActiveWorkspace().getLogicalWorkspace();
    var results = [];
    var successCount = 0;
    var failCount = 0;

    for (var i = 0; i < linksToRemove.length; i++) {
      var link = linksToRemove[i];
      var deviceName = link.device || link.deviceName;
      var portName = link.port || link.portName;

      if (!deviceName || !portName) {
        results.push({
          device: deviceName,
          port: portName,
          success: false,
          error: "Missing device or port",
        });
        failCount++;
        continue;
      }

      var device = ipc.network().getDevice(deviceName);
      if (!device) {
        results.push({
          device: deviceName,
          port: portName,
          success: false,
          error: "Device not found",
        });
        failCount++;
        continue;
      }

      var result = workspace.deleteLink(deviceName, portName);

      if (result === true) {
        results.push({
          device: deviceName,
          port: portName,
          success: true,
          message: "Link removed successfully",
        });
        successCount++;
      } else {
        results.push({
          device: deviceName,
          port: portName,
          success: false,
          error: "Failed to remove link",
        });
        failCount++;
      }
    }

    return {
      success: failCount === 0,
      totalLinks: linksToRemove.length,
      successCount: successCount,
      failCount: failCount,
      results: results,
    };
  } catch (error) {
    return fail("Error removing links", error);
  }
};

if (typeof addDevice !== "undefined") mcpAddDevice = addDevice;
if (typeof addModule !== "undefined") mcpAddModule = addModule;
if (typeof addLink !== "undefined") mcpAddLink = addLink;
if (typeof removeDevice !== "undefined") mcpRemoveDevice = removeDevice;
if (typeof removeLink !== "undefined") mcpRemoveLink = removeLink;
if (typeof configurePcIp !== "undefined") mcpConfigurePcIp = configurePcIp;
if (typeof configureIosDevice !== "undefined") mcpConfigureIosDevice = configureIosDevice;
if (typeof getNetwork !== "undefined") mcpGetNetwork = getNetwork;
if (typeof getDeviceInfo !== "undefined") mcpGetDeviceInfo = getDeviceInfo;
if (typeof setSimulationMode !== "undefined") mcpSetSimulationMode = setSimulationMode;
if (typeof getSimulationStatus !== "undefined") mcpGetSimulationStatus = getSimulationStatus;
if (typeof stepSimulation !== "undefined") mcpStepSimulation = stepSimulation;
if (typeof sendPdu !== "undefined") mcpSendPdu = sendPdu;
if (typeof renameDevice !== "undefined") mcpRenameDevice = renameDevice;
if (typeof moveDevice !== "undefined") mcpMoveDevice = moveDevice;
if (typeof setPower !== "undefined") mcpSetPower = setPower;
if (typeof getPduResults !== "undefined") mcpGetPduResults = getPduResults;
if (typeof getCommandLog !== "undefined") mcpGetCommandLog = getCommandLog;
