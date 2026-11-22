"""Command line: inspect projects, verify round-trips, copy pattern + kit."""

from __future__ import annotations

import argparse
import os
import sys

from .container import FormatError, decode_payload, encode_payload, read_stprj, write_stprj
from .project import PATTERN_COUNT, CopyError, Project, copy_pattern_with_kit, parse_slot, slot_label


def load(path: str) -> Project:
    project = Project(read_stprj(path))
    project.validate()
    return project


def cmd_info(args: argparse.Namespace) -> None:
    project = load(args.file)
    pattern_v, kit_v, sound_v = project.structure_versions()
    print(f"{project.name}  slot {project.file.payload.slot + 1:03d}  project v0x{project.version:02X}  "
          f"(pattern v{pattern_v}, kit v{kit_v}, sound v{sound_v})")
    for i in range(PATTERN_COUNT):
        info = project.pattern_info(i)
        if info.empty and not args.all:
            continue
        print(f"  {info.label}  {info.name or '-':16s}  kit {info.kit + 1:3d} {project.kit_name(info.kit) or '-':16s}"
              f"  {info.tempo:6.1f} bpm  {info.trigs:4d} trigs  {info.locks:2d} lock slots")


def cmd_verify(args: argparse.Namespace) -> None:
    for path in args.files:
        project = load(path)
        again = decode_payload(encode_payload(project.file.payload))
        status = "ok" if again.data == project.data and again.header == project.file.payload.header else "MISMATCH"
        print(f"{status}  {path}")


def cmd_copy(args: argparse.Namespace) -> None:
    src = load(args.src)
    dst = load(args.dst)
    src_index = parse_slot(args.src_slot)
    dst_index = parse_slot(args.dst_slot)
    kit_index = parse_slot(args.kit_slot) if args.kit_slot else None
    result, warnings = copy_pattern_with_kit(src, src_index, dst, dst_index, kit_index, force=args.force)
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)

    out = args.output
    if out is None:
        stem = os.path.splitext(os.path.basename(args.dst))[0]
        out = os.path.join(os.path.dirname(args.dst) or ".",
                           f"{stem} + {src.name} {slot_label(src_index)} at {slot_label(dst_index)}.stprj")
    write_stprj(out, result.file)
    info = result.pattern_info(dst_index)
    print(f"wrote {out}")
    print(f"  {src.name} {slot_label(src_index)} -> {dst.name} {info.label}, kit {info.kit + 1} "
          f"({result.kit_name(info.kit) or 'unnamed'}), {info.trigs} trigs, {info.locks} lock slots")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stprj", description="Elektron Syntakt .stprj tool")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("info", help="list non-empty patterns")
    p.add_argument("file")
    p.add_argument("--all", action="store_true", help="include empty patterns")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("verify", help="decode and re-encode, check the round-trip")
    p.add_argument("files", nargs="+")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("copy", help="copy a pattern and its kit into another project (converts between project versions)")
    p.add_argument("src", help="source .stprj")
    p.add_argument("src_slot", help="source pattern, e.g. A01")
    p.add_argument("dst", help="destination .stprj (not modified)")
    p.add_argument("dst_slot", help="destination pattern, e.g. H16")
    p.add_argument("--kit-slot", help="destination kit slot (default: same as destination pattern)")
    p.add_argument("-o", "--output", help="output .stprj (default: next to destination; never overwritten)")
    p.add_argument("--force", action="store_true",
                   help="allow overwriting a non-empty pattern or a kit used by other patterns")
    p.set_defaults(func=cmd_copy)

    args = parser.parse_args(argv)
    try:
        args.func(args)
    except (FormatError, CopyError, ValueError, FileExistsError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0
