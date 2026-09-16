#!/usr/bin/env python3
"""Small stdlib client that connects an AI agent to the open Circuit Lens."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def state_root() -> Path:
    base = os.environ.get("XDG_STATE_HOME")
    if base:
        return Path(base).expanduser() / "vibe-logisim" / "circuit-lens"
    return Path.home() / ".local" / "state" / "vibe-logisim" / "circuit-lens"


def current_pointer(root: Path | None = None) -> dict[str, Any]:
    path = (root or state_root()) / "current.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SystemExit(f"Circuit Lens is not running or has no state pointer: {path}") from error


def request(method: str, endpoint: str, body: Any | None = None, root: Path | None = None) -> Any:
    current = current_pointer(root)
    base = current.get("baseUrl")
    if not base:
        raise SystemExit("Circuit Lens state has no server address.")
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(base.rstrip("/") + endpoint, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=75) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Circuit Lens returned HTTP {error.code}: {payload}") from error
    except URLError as error:
        raise SystemExit(f"Cannot reach Circuit Lens at {base}: {error.reason}") from error


def read_review_input(value: str) -> dict[str, Any]:
    if value == "-":
        data = json.load(sys.stdin)
    else:
        data = json.loads(Path(value).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit("Review JSON must be an object.")
    return data


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Talk to the currently open Circuit Lens")
    parser.add_argument(
        "--state-dir",
        type=Path,
        help="state root used by a server started with --state-dir",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("context", help="read session, current selection, and review")
    sub.add_parser("selection", help="read just the revision-bound current selection")
    query = sub.add_parser("query", help="run an exact query rooted at the selection")
    query.add_argument("--revision-id", required=True)
    query.add_argument("--selection-id", required=True)
    query.add_argument("--question")
    query.add_argument("kind", choices=("overview", "component", "net"), nargs="?", default="overview")
    query.add_argument("ids", nargs="*")
    review = sub.add_parser("review", help="read the current review bundle")
    harness = sub.add_parser("harness", help="run a native Harness experiment")
    harness.add_argument("--revision-id", required=True)
    harness.add_argument("circuit")
    harness.add_argument("--mode", choices=("trace", "simulate"), default="trace")
    harness.add_argument("--ticks", type=int, default=16)
    harness.add_argument("--inputs", default="{}")
    harness.add_argument("--auto-inputs", action="store_true", help="read native input schema and fill zero values")
    harness.add_argument("--watches", default="[]")
    harness.add_argument("--input-events", default="[]")
    schema = sub.add_parser("harness-schema", help="read native Harness stimulus schema")
    schema.add_argument("--revision-id", required=True)
    schema.add_argument("circuit")
    publish = sub.add_parser("publish", help="publish review JSON; use - for stdin")
    publish.add_argument("--revision-id", required=True)
    publish.add_argument("--selection-id", required=True)
    publish.add_argument("file")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    root = args.state_dir.expanduser().resolve() if args.state_dir else None
    if args.command == "context":
        session = request("GET", "/api/session", root=root)
        # /api/session is one lock-held snapshot. Three requests could mix
        # selection A with review B if the user reselects in between.
        session_summary = dict(session)
        selection = session_summary.pop("selection", None)
        review = session_summary.pop("review", None)
        last_query = session_summary.pop("lastQuery", None)
        if isinstance(last_query, dict):
            last_query = {
                key: last_query.get(key)
                for key in (
                    "schema",
                    "revisionId",
                    "selectionId",
                    "selectionReference",
                    "observationProfileId",
                    "kind",
                    "ids",
                    "question",
                )
            }
        result = {
            "session": session_summary,
            "selection": selection,
            "review": review,
            "lastQuery": last_query,
        }
    elif args.command == "selection":
        result = request("GET", "/api/selection", root=root)
    elif args.command == "query":
        result = request(
            "POST",
            "/api/query",
            {
                "revisionId": args.revision_id,
                "selectionId": args.selection_id,
                "kind": args.kind,
                "ids": args.ids,
                "question": args.question,
            },
            root=root,
        )
    elif args.command == "review":
        result = request("GET", "/api/review", root=root)
    elif args.command == "harness":
        try:
            inputs, watches, input_events = json.loads(args.inputs), json.loads(args.watches), json.loads(args.input_events)
        except json.JSONDecodeError as error:
            raise SystemExit(f"Harness inputs/watches must be JSON: {error}") from error
        if args.auto_inputs:
            schema_result = request("POST", "/api/agent/tool", {
                "revisionId": args.revision_id, "tool": "inspect_circuit",
                "arguments": {"circuit": args.circuit},
            }, root=root)
            schema = schema_result.get("stimulusSchema") or []
            inputs = {item["label"]: 0 for item in schema if item.get("label")}
        result = request("POST", "/api/agent/tool", {
            "revisionId": args.revision_id, "tool": "harness_run",
            "arguments": {"mode": args.mode, "circuit": args.circuit,
                          "ticks": args.ticks, "inputs": inputs, "watches": watches,
                          "inputEvents": input_events},
        }, root=root)
    elif args.command == "harness-schema":
        inspected = request("POST", "/api/agent/tool", {
            "revisionId": args.revision_id, "tool": "inspect_circuit",
            "arguments": {"circuit": args.circuit},
        }, root=root)
        result = {"revisionId": inspected.get("revisionId"), "circuit": inspected.get("circuit"),
                  "authority": inspected.get("authority"), "stimulusSchema": inspected.get("stimulusSchema"),
                  "error": inspected.get("error")}
    elif args.command == "publish":
        result = read_review_input(args.file)
        for key, explicit in (
            ("revisionId", args.revision_id),
            ("selectionId", args.selection_id),
        ):
            supplied = result.get(key)
            if supplied is not None and supplied != explicit:
                raise SystemExit(
                    f"Review {key}={supplied!r} conflicts with explicit {explicit!r}; refusing to rebind it."
                )
            result[key] = explicit
        selection_path = (
            (root or state_root())
            / "revisions"
            / args.revision_id
            / "selections"
            / f"{args.selection_id}.json"
        )
        try:
            selection = json.loads(selection_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as error:
            raise SystemExit(f"Cannot read immutable selection binding: {selection_path}") from error
        supplied_profile = result.get("observationProfileId")
        expected_profile = selection.get("observationProfileId")
        if supplied_profile is not None and supplied_profile != expected_profile:
            raise SystemExit("Review observationProfileId conflicts with the immutable selection.")
        result["observationProfileId"] = expected_profile
        result = request("PUT", "/api/review", result, root=root)
    else:
        raise AssertionError(args.command)
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
