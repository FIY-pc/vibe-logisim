#!/usr/bin/env python3
"""Compatibility entry point for the local service.

The implementation is composed under ``studio``. These exports keep archived
diagnostic scripts working while callers migrate to the application packages.
"""
import sys

# Every text channel of this service (config JSON, .circ XML, the stdio control
# channel to Electron, Java worker pipes) is UTF-8. Windows defaults stdio to
# the ANSI code page (cp1252/gbk); the Electron host sets PYTHONUTF8=1, and
# this keeps a bare `python server.py` correct as well. File reads/writes pass
# encoding="utf-8" explicitly.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure is not None:
        _reconfigure(encoding="utf-8", errors="surrogateescape" if _stream is not sys.stderr else "backslashreplace")

from studio.bootstrap import Handler, Workspace, main
from studio.domain.errors import LensError
from studio.infrastructure.lease import StateRootLease
from studio.transport.desktop import DesktopControl
from studio.transport.http import LensHTTPServer

if __name__ == "__main__":
    raise SystemExit(main())
