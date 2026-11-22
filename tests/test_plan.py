"""Run from synpat/: python3 -B -m unittest discover tests  (uses the real backups in ../PROJECTS)."""

import os
import unittest

from stprj import Project, copy_pattern_with_kit, read_stprj
from web.plan import Op, PlanError, parse_ops, simulate

PROJECTS = os.path.join(os.path.dirname(__file__), "..", "..", "PROJECTS")


def load(name: str) -> Project:
    path = os.path.join(PROJECTS, name + ".stprj")
    if not os.path.exists(path):
        raise unittest.SkipTest(f"missing {path}")
    return Project(read_stprj(path))


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.projects = {n: load(n) for n in ("027 PPRFC TOUR", "033 SET - HOUSE", "024 FUNKY GOSPEL", "026 NEW PROJECT")}
        self.loader = lambda fid: self._load(fid)

    def _load(self, fid):
        try:
            return self.projects[fid]
        except KeyError:
            raise PlanError(f"unknown {fid}")

    def test_multi_source_queue_equals_sequential_copies(self):
        dest = self.projects["027 PPRFC TOUR"]
        ops = [Op("033 SET - HOUSE", 1, 18, 18), Op("024 FUNKY GOSPEL", 0, 19, 19)]  # A02->B03, A01->B04 (0x0A->0x0C)
        before = dest.data
        result, res = simulate(dest, ops, self.loader)
        self.assertEqual([r.ok for r in res], [True, True])
        step, _ = copy_pattern_with_kit(self.projects["033 SET - HOUSE"], 1, dest, 18)
        step, w = copy_pattern_with_kit(self.projects["024 FUNKY GOSPEL"], 0, step, 19)
        self.assertEqual(result.data, step.data)
        self.assertTrue(any("converted" in x for x in res[1].warnings))
        self.assertIs(dest.data, before)  # destination untouched
        self.assertTrue(result.pattern_info(18).trigs > 0 and result.pattern_info(19).trigs > 0)

    def test_empty_queue_returns_destination(self):
        dest = self.projects["027 PPRFC TOUR"]
        result, res = simulate(dest, [], self.loader)
        self.assertIs(result, dest)
        self.assertEqual(res, [])

    def test_duplicate_destination_slot_detected_and_forceable(self):
        dest = self.projects["027 PPRFC TOUR"]
        ops = [Op("033 SET - HOUSE", 1, 18, 18), Op("033 SET - HOUSE", 2, 18, 20)]
        result, res = simulate(dest, ops, self.loader)
        self.assertTrue(res[0].ok)
        self.assertFalse(res[1].ok)
        self.assertTrue(res[1].forceable)
        self.assertIn("B03 is already the target of op #1", res[1].error)
        first, _ = copy_pattern_with_kit(self.projects["033 SET - HOUSE"], 1, dest, 18)
        self.assertEqual(result.data, first.data)  # the failed op changed nothing
        forced = [ops[0], Op("033 SET - HOUSE", 2, 18, 20, force=True)]
        result2, res2 = simulate(dest, forced, self.loader)
        self.assertTrue(all(r.ok for r in res2))
        expect, _ = copy_pattern_with_kit(self.projects["033 SET - HOUSE"], 2, first, 18, 20, force=True)
        self.assertEqual(result2.data, expect.data)

    def test_duplicate_kit_slot_detected(self):
        dest = self.projects["027 PPRFC TOUR"]
        ops = [Op("033 SET - HOUSE", 1, 18, 18), Op("033 SET - HOUSE", 2, 19, 18)]
        _, res = simulate(dest, ops, self.loader)
        self.assertFalse(res[1].ok)
        self.assertIn("kit slot 19 is already used by op #1", res[1].error)

    def test_non_empty_destination_refused(self):
        dest = self.projects["033 SET - HOUSE"]
        _, res = simulate(dest, [Op("027 PPRFC TOUR", 0, 1, 1)], self.loader)
        self.assertFalse(res[0].ok)
        self.assertTrue(res[0].forceable)
        self.assertIn("not empty", res[0].error)

    def test_lossy_downgrade_needs_force(self):
        dest = self.projects["026 NEW PROJECT"]  # 0x0A
        op = Op("033 SET - HOUSE", 1, 16, 16)    # 0x0C source, lossy kit
        _, res = simulate(dest, [op], self.loader)
        self.assertFalse(res[0].ok)
        self.assertTrue(res[0].forceable)
        self.assertIn("lossy", res[0].error)
        result, res = simulate(dest, [Op("033 SET - HOUSE", 1, 16, 16, force=True)], self.loader)
        self.assertTrue(res[0].ok)
        self.assertTrue(any("conversion:" in w for w in res[0].warnings))
        result.validate()

    def test_failed_op_does_not_block_later_ops(self):
        dest = self.projects["027 PPRFC TOUR"]
        ops = [Op("missing", 0, 18, 18), Op("033 SET - HOUSE", 1, 19, 19)]
        result, res = simulate(dest, ops, self.loader)
        self.assertFalse(res[0].ok)
        self.assertIn("source unusable", res[0].error)
        self.assertTrue(res[1].ok)
        self.assertGreater(result.pattern_info(19).trigs, 0)

    def test_validation_does_not_mutate_inputs(self):
        dest, src = self.projects["027 PPRFC TOUR"], self.projects["033 SET - HOUSE"]
        snap = (dest.data, src.data)
        simulate(dest, [Op("033 SET - HOUSE", 1, 18, 18), Op("033 SET - HOUSE", 1, 18, 18)], self.loader)
        simulate(dest, [Op("033 SET - HOUSE", 1, 18, 18)], self.loader)
        self.assertEqual((dest.data, src.data), snap)

    def test_parse_ops(self):
        ops = parse_ops([{"sourceFileId": "a", "srcSlot": 1, "dstSlot": 18, "kitSlot": None, "force": True}])
        self.assertEqual(ops, [Op("a", 1, 18, 18, True)])
        self.assertEqual(parse_ops([{"sourceFileId": "a", "srcSlot": 0, "dstSlot": 5}])[0].force, False)
        base = {"sourceFileId": "a", "srcSlot": 1, "dstSlot": 1}
        for bad in ("x", [{"srcSlot": 1, "dstSlot": 2}], [{**base, "srcSlot": 200}], [{**base, "kitSlot": 999}],
                    [{**base, "dstSlot": "B03"}], [{**base, "dstSlot": True}], [{**base, "srcSlot": 1.5}],
                    [{**base, "kitSlot": ""}], [{**base, "dstSlot": -1}],
                    [{**base, "force": "yes"}], [{**base, "force": 1}], [{**base, "force": None}]):
            with self.assertRaises(PlanError, msg=repr(bad)):
                parse_ops(bad)


if __name__ == "__main__":
    unittest.main()
