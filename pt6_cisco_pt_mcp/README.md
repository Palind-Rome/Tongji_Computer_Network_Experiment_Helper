# PT6 patched cisco-pt-mcp package

This package contains the Python MCP server used by the repository root launcher:

```powershell
python -m pip install -e .\pt6_cisco_pt_mcp
python .\run_pt6_cisco_pt_mcp.py
```

For normal installation, use the root `README.md` instead of installing upstream `cisco-pt-mcp` from PyPI. The upstream package targets newer Packet Tracer extension behavior; this copy is patched for Cisco Packet Tracer 6.0.
