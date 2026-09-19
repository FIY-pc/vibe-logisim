#!/usr/bin/env bash
set -euo pipefail

observer_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runtime_jar="${VIBE_OBSERVER_RUNTIME_JAR:-$observer_dir/../native/Logisim-ITA.jar}"
observer_source="$observer_dir/src/com/cburch/logisim/circuit/ExactRuntimeObserver.java"

if [[ $# -lt 2 ]]; then
  echo "usage: $0 [--full] ARTIFACT.circ CIRCUIT [X Y WIDTH HEIGHT]" >&2
  echo "   or: $0 --compact ARTIFACT.circ CIRCUIT X Y WIDTH HEIGHT" >&2
  exit 64
fi

if [[ ! -f "$runtime_jar" ]]; then
  echo "missing exact runtime: $runtime_jar" >&2
  exit 66
fi

build_dir="$(mktemp -d -t vibe-logisim-observer.XXXXXXXX)"
trap 'rm -rf -- "$build_dir"' EXIT

javac -encoding UTF-8 -cp "$runtime_jar" -d "$build_dir" "$observer_source" "${observer_source%/*}/NativeAttributeAdapter.java"
java \
  -Djava.awt.headless=true \
  -Dobserver.runtime.jar="$runtime_jar" \
  -Dobserver.source.path="$observer_source" \
  -Dobserver.bundle.path="$build_dir" \
  -cp "$runtime_jar:$build_dir" \
  com.cburch.logisim.circuit.ExactRuntimeObserver "$@"
