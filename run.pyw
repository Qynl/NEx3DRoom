"""Windows friendly launcher: double-click to start with no console window."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from run import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
