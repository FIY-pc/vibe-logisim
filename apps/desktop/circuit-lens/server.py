#!/usr/bin/env python3
"""Compatibility entry point for the local service.

The implementation is composed under ``studio``. These exports keep archived
diagnostic scripts working while callers migrate to the application packages.
"""
from studio.bootstrap import Handler, Workspace, main
from studio.domain.errors import LensError
from studio.infrastructure.lease import StateRootLease
from studio.transport.desktop import DesktopControl
from studio.transport.http import LensHTTPServer

if __name__ == "__main__":
    raise SystemExit(main())
