#!/usr/bin/env bash
set -euo pipefail

observer_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 6 ]]; then
  echo "usage: $0 ARTIFACT.circ CIRCUIT X Y WIDTH HEIGHT [overview]" >&2
  echo "   or: $0 ARTIFACT.circ CIRCUIT X Y WIDTH HEIGHT component ID [ID ...]" >&2
  echo "   or: $0 ARTIFACT.circ CIRCUIT X Y WIDTH HEIGHT net NET_ID [NET_ID ...]" >&2
  exit 64
fi

artifact="$1"
circuit="$2"
x="$3"
y="$4"
width="$5"
height="$6"
shift 6

"$observer_dir/run.sh" --compact \
  "$artifact" "$circuit" "$x" "$y" "$width" "$height" \
  | python3 "$observer_dir/query.py" "$@"
