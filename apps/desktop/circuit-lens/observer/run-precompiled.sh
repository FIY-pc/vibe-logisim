#!/bin/sh
set -eu

runtime_jar="${VIBE_OBSERVER_RUNTIME_JAR:-/runtime/Logisim-ITA.jar}"
observer_classes="${VIBE_OBSERVER_CLASSES:-/observer}"

if [ ! -f "$runtime_jar" ]; then
  echo "missing exact runtime: $runtime_jar" >&2
  exit 66
fi

if [ ! -f "$observer_classes/com/cburch/logisim/circuit/ExactRuntimeObserver.class" ]; then
  echo "missing precompiled observer classes under: $observer_classes" >&2
  exit 66
fi

exec java \
  -Djava.awt.headless=true \
  -Dobserver.runtime.jar="$runtime_jar" \
  -Dobserver.bundle.path="$observer_classes" \
  -cp "$runtime_jar:$observer_classes" \
  com.cburch.logisim.circuit.ExactRuntimeObserver "$@"
