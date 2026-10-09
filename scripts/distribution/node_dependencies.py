"""Bundle executable SDK code and preserve notices, without development files."""
import subprocess
from pathlib import Path


def copy_node_dependencies(desktop: Path, app: Path):
    subprocess.run(['node', str(desktop.parents[1] / 'scripts/distribution/bundle-sdk.cjs'), str(app)], check=True)
