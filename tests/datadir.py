"""Where the real backups live for the tests that use them.

$SYNPAT_DATA (the folder containing PROJECTS and OLD BACKUP) when set, else the repository's parent directory.
Tests skip when the data is missing.
"""

import os

DATA = os.environ.get("SYNPAT_DATA") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
PROJECTS = os.path.abspath(os.path.join(DATA, "PROJECTS"))
OLD_BACKUP = os.path.abspath(os.path.join(DATA, "OLD BACKUP"))
