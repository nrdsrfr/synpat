"""Read, modify and write Elektron Syntakt project files (.stprj)."""

from .container import FormatError, Payload, StprjFile, read_stprj, write_raw_stprj, write_stprj
from .project import CopyError, Project, copy_pattern_with_kit, parse_slot, slot_label

__all__ = [
    "CopyError",
    "FormatError",
    "Payload",
    "Project",
    "StprjFile",
    "copy_pattern_with_kit",
    "parse_slot",
    "read_stprj",
    "slot_label",
    "write_raw_stprj",
    "write_stprj",
]
