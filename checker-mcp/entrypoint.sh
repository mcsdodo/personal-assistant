#!/bin/sh
# Start MCP server in background, Flask web UI as PID 1
python server.py &
exec python webapp.py
