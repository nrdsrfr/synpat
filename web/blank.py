"""The virtual "template" destination: a blank project that is built on the server and never read from a file.

Name rule: the library (stprj.template.check_name) accepts 1..15 printable ASCII characters. The GUI offers a
stricter set, the characters seen in real Syntakt project names: A-Z, 0-9, space, '-', '=' and '#', with no leading
or trailing space. validate_name applies the library's check first (so its message is the one users see for names
the library rejects) and then the stricter rule, so a name that passes here is always accepted by the library.
"""

import re

from stprj.template import DEFAULT_NAME, MAX_NAME_LEN, check_name

TEMPLATE_ID = "template"
_GUI_NAME = re.compile(r"[A-Z0-9 =#-]+")


def validate_name(raw) -> str:
    """The template name to use: DEFAULT_NAME when none is given, else `raw` if acceptable (ValueError if not)."""
    if raw is None:
        return DEFAULT_NAME
    if not isinstance(raw, str):
        raise ValueError(f"project name must be text of 1..{MAX_NAME_LEN} characters")
    check_name(raw)
    if not _GUI_NAME.fullmatch(raw) or raw != raw.strip():
        raise ValueError(f"project name {raw!r}: use only A-Z 0-9 space - = # (no leading or trailing space)")
    return raw
