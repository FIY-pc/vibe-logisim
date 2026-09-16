from __future__ import annotations

import contextlib
import json
import os
from http import HTTPStatus
import uuid
from studio.domain.errors import LENS_SCHEMA, LensError
from studio.infrastructure.files import read_json

class StateRootLease:
    """Keep one live authority behind a state root and its current pointer."""

    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.path = self.root / "authority.lock"
        self.owner_id = uuid.uuid4().hex
        self.handle: Any | None = None

    def acquire(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b"\0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError) as error:
            handle.close()
            current = None
            with contextlib.suppress(OSError, UnicodeError, json.JSONDecodeError):
                current = read_json(self.root / "current.json")
            owner = current.get("pid") if isinstance(current, dict) else None
            suffix = f" (pid {owner})" if owner else ""
            raise LensError(
                HTTPStatus.CONFLICT,
                "STATE_ROOT_IN_USE",
                f"Another Circuit Lens authority already owns this workspace{suffix}.",
            ) from error

        self.handle = handle
        payload = (
            json.dumps(
                {"schema": LENS_SCHEMA, "ownerId": self.owner_id, "pid": os.getpid()},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
        handle.seek(0)
        handle.truncate()
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())

    def release(self) -> None:
        handle = self.handle
        if handle is None:
            return
        pointer = self.root / "current.json"
        current = None
        with contextlib.suppress(OSError, UnicodeError, json.JSONDecodeError):
            current = read_json(pointer)
        if isinstance(current, dict) and current.get("ownerId") == self.owner_id:
            with contextlib.suppress(FileNotFoundError):
                pointer.unlink()
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
            self.handle = None

