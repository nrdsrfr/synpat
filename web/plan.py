"""Pattern-copy queue ("plan"): simulate many copies from several sources into one destination.

Pure functions over immutable `Project`s: nothing is written and nothing is mutated, so the same
simulation backs both "validate" (preview) and "run" (apply). Slot numbers are 0-based
(0 = A01 ... 127 = H16); `kit_slot` is the destination kit slot, 0-based, default = `dst_slot`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from stprj import CopyError, FormatError, Project, copy_pattern_with_kit, slot_label
from stprj.layout import PATTERN_COUNT

MAX_OPS = 128


class PlanError(ValueError):
    """Malformed plan or an unusable source/destination project."""


@dataclass(frozen=True)
class Op:
    source_file_id: str
    src_slot: int
    dst_slot: int
    kit_slot: int
    force: bool = False


@dataclass(frozen=True)
class OpResult:
    ok: bool
    warnings: list[str] = field(default_factory=list)
    error: str | None = None
    forceable: bool = False  # a refusal that "force" would override


def _slot(value, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PlanError(f"{what} must be an integer 0..{PATTERN_COUNT - 1}")
    if not 0 <= value < PATTERN_COUNT:
        raise PlanError(f"{what} {value} out of range 0..{PATTERN_COUNT - 1}")
    return value


def parse_ops(raw) -> list[Op]:
    if not isinstance(raw, list):
        raise PlanError("ops must be a list")
    if len(raw) > MAX_OPS:
        raise PlanError(f"at most {MAX_OPS} operations")
    ops = []
    for n, item in enumerate(raw, 1):
        if not isinstance(item, dict) or not isinstance(item.get("sourceFileId"), str):
            raise PlanError(f"op #{n}: sourceFileId is required")
        src, dst = _slot(item.get("srcSlot"), f"op #{n} srcSlot"), _slot(item.get("dstSlot"), f"op #{n} dstSlot")
        kit = item.get("kitSlot")
        kit_slot = dst if kit is None else _slot(kit, f"op #{n} kitSlot")
        force = item.get("force", False)
        if not isinstance(force, bool):
            raise PlanError(f"op #{n}: force must be true or false")
        ops.append(Op(item["sourceFileId"], src, dst, kit_slot, force))
    return ops


def simulate(dest: Project, ops: list[Op], load_source: Callable[[str], Project]) -> tuple[Project, list[OpResult]]:
    """Apply `ops` in order to `dest` (in memory). A failing op is reported and skipped; later ops continue
    from the last good state. Returns the resulting project and one OpResult per op."""
    current = dest
    results: list[OpResult] = []
    sources: dict[str, Project | str] = {}
    dst_taken: dict[int, int] = {}
    kit_taken: dict[int, int] = {}
    for n, op in enumerate(ops, 1):
        src = sources.get(op.source_file_id)
        if src is None:
            try:
                src = sources[op.source_file_id] = load_source(op.source_file_id)
            except PlanError as e:
                src = sources[op.source_file_id] = str(e)
        if isinstance(src, str):
            results.append(OpResult(False, error=f"source unusable: {src}"))
            continue
        if not op.force:
            clash = []
            if op.dst_slot in dst_taken:
                clash.append(f"destination slot {slot_label(op.dst_slot)} is already the target of op #{dst_taken[op.dst_slot]}")
            if op.kit_slot in kit_taken:
                clash.append(f"kit slot {op.kit_slot + 1} is already used by op #{kit_taken[op.kit_slot]}")
            if clash:
                results.append(OpResult(False, error="; ".join(clash) + " (force this op to overwrite)", forceable=True))
                continue
        warnings: list[str] = []
        if src.pattern_info(op.src_slot).empty:
            warnings.append(f"source pattern {slot_label(op.src_slot)} is empty")
        try:
            current, copy_warnings = copy_pattern_with_kit(src, op.src_slot, current, op.dst_slot, op.kit_slot, op.force)
        except CopyError as e:
            results.append(OpResult(False, error=str(e), forceable=True))
            continue
        except (FormatError, IndexError, ValueError) as e:
            results.append(OpResult(False, error=str(e)))
            continue
        dst_taken[op.dst_slot] = n
        kit_taken[op.kit_slot] = n
        results.append(OpResult(True, warnings + copy_warnings))
    return current, results
