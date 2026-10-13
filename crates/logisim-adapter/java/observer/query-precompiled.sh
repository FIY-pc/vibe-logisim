#!/bin/sh
set -eu

runtime_jar="${VIBE_OBSERVER_RUNTIME_JAR:-/runtime/Logisim-ITA.jar}"
observer_classes="${VIBE_OBSERVER_CLASSES:-/observer/classes}"
query_program="${VIBE_OBSERVER_QUERY_PROGRAM:-/observer/query.py}"

if [ "$#" -lt 6 ]; then
  echo "usage: $0 ARTIFACT.circ CIRCUIT X Y WIDTH HEIGHT [overview|component ID...|net NET_ID...]" >&2
  exit 64
fi

if [ ! -f "$runtime_jar" ]; then
  echo "missing exact runtime: $runtime_jar" >&2
  exit 66
fi
if [ ! -f "$observer_classes/com/cburch/logisim/circuit/ExactRuntimeObserver.class" ]; then
  echo "missing precompiled observer classes under: $observer_classes" >&2
  exit 66
fi
if [ ! -f "$query_program" ]; then
  echo "missing query program: $query_program" >&2
  exit 66
fi

artifact="$1"
circuit="$2"
x="$3"
y="$4"
width="$5"
height="$6"
shift 6

java \
  -Djava.awt.headless=true \
  -Dobserver.runtime.jar="$runtime_jar" \
  -Dobserver.bundle.path="$observer_classes" \
  -cp "$runtime_jar:$observer_classes" \
  com.cburch.logisim.circuit.ExactRuntimeObserver \
  --compact "$artifact" "$circuit" "$x" "$y" "$width" "$height" \
  | python3 "$query_program" "$@"
