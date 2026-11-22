"""HTTP-level tests: a real server on a random port with a temp output dir (uses ../PROJECTS)."""

import hashlib
import http.client
import json
import os
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer

from web import server as srv

PROJECTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "PROJECTS"))
DEST, SRC = "0/027 PPRFC TOUR.stprj", "0/033 SET - HOUSE.stprj"
OPS = [{"sourceFileId": SRC, "srcSlot": 1, "dstSlot": 18, "kitSlot": 18, "force": False}]


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.path.exists(os.path.join(PROJECTS, "027 PPRFC TOUR.stprj")):
            raise unittest.SkipTest("missing backups")
        cls.tmp = tempfile.mkdtemp()
        srv.Handler.log_message = lambda *args: None
        srv.Handler.store = srv.Store([Path(PROJECTS)], Path(cls.tmp))
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        s = srv.Handler.store
        s.session, s.plan, s.plan_rev = None, None, 0

    def request(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        c.request(method, path, body, headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, data, r

    def post(self, path, obj):
        status, data, _ = self.request("POST", path, json.dumps(obj).encode(), {"Content-Type": "application/json"})
        return status, json.loads(data)

    def raw_post(self, length_header, body=b"{}"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.putrequest("POST", "/api/plan/store")
        c.putheader("Content-Length", length_header)
        c.endheaders(body)
        r = c.getresponse()
        r.read()
        c.close()
        return r.status

    # --- 4: Content-Length / body shape
    def test_bad_content_length_and_body(self):
        self.assertEqual(self.raw_post("abc"), 400)
        self.assertEqual(self.raw_post("-5"), 400)
        self.assertEqual(self.raw_post(str(srv.MAX_BODY + 1)), 413)
        self.assertEqual(self.post("/api/plan/validate", {"destFileId": DEST, "ops": []})[0], 200)
        for body in (b"[1]", b"\"x\"", b"7", b"null"):
            status, _, _ = self.request("POST", "/api/plan/store", body, {"Content-Type": "application/json"})
            self.assertEqual(status, 400, body)
        self.assertEqual(self.request("POST", "/api/plan/store", b"{nope", {})[0], 400)

    # --- 5: strict ops
    def test_force_must_be_bool(self):
        bad = [{**OPS[0], "force": "yes"}]
        status, body = self.post("/api/plan/validate", {"destFileId": DEST, "ops": bad})
        self.assertEqual(status, 400)
        self.assertIn("force", body["error"])
        self.assertEqual(self.post("/api/plan/validate", {"destFileId": DEST, "ops": [{**OPS[0], "dstSlot": "B03"}]})[0], 400)

    # --- 10: negative dir index
    def test_negative_dir_index_rejected(self):
        name = "999 tmp.stprj"
        shutil.copy(os.path.join(PROJECTS, "027 PPRFC TOUR.stprj"), os.path.join(self.tmp, name))
        self.assertEqual(self.request("GET", f"/api/project?file=1/{name.replace(' ', '%20')}")[0], 200)
        self.assertEqual(self.request("GET", f"/api/project?file=-1/{name.replace(' ', '%20')}")[0], 400)

    # --- 1: session revision ties payload to the validated result
    def test_session_revision(self):
        status, run = self.post("/api/plan/run", {"destFileId": DEST, "ops": OPS})
        self.assertEqual(status, 200)
        rev = run["revision"]
        self.assertEqual(self.request("GET", "/api/session/payload?rev=999-deadbeef0000")[0], 409)
        status, data, resp = self.request("GET", f"/api/session/payload?rev={rev['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(hashlib.sha256(data).hexdigest(), rev["sha"])
        self.assertEqual(resp.getheader("X-Project-Revision"), rev["id"])
        status, saved = self.post("/api/session/save", {"name": "rev-test.stprj"})
        self.assertEqual((status, saved["revision"]), (200, rev))  # saving does not change the content
        status, undone = self.post("/api/session/undo", {})
        self.assertEqual(status, 200)
        self.assertNotEqual(undone["revision"]["id"], rev["id"])
        self.assertEqual(self.request("GET", f"/api/session/payload?rev={rev['id']}")[0], 409)
        self.assertEqual(self.request("GET", f"/api/session/payload?rev={undone['revision']['id']}")[0], 200)
        self.assertEqual(self.request("GET", "/api/session/payload")[0], 200)  # rev is optional

    def test_session_payload_matches_revision_under_concurrent_undo(self):
        self.post("/api/plan/run", {"destFileId": DEST, "ops": OPS})
        results, stop = [], threading.Event()

        def flip():  # alternate the session between two contents via undo/redo-by-rerun
            while not stop.is_set():
                self.post("/api/session/undo", {})
                self.post("/api/plan/run", {"destFileId": DEST, "ops": OPS})

        t = threading.Thread(target=flip)
        t.start()
        try:
            for _ in range(15):
                status, data, resp = self.request("GET", "/api/session/payload")
                if status == 200:
                    results.append((hashlib.sha256(data).hexdigest()[:12], resp.getheader("X-Project-Revision")))
        finally:
            stop.set()
            t.join()
        self.assertTrue(results)
        for digest, rev in results:  # the served bytes always hash to the revision served with them
            self.assertTrue(rev.endswith(digest), (digest, rev))

    # --- 3: previews keyed to the validated plan; stale plan stores rejected
    def test_preview_key_and_plan_store_revision(self):
        status, a = self.post("/api/plan/validate", {"destFileId": DEST, "ops": OPS})
        _, b = self.post("/api/plan/validate", {"destFileId": DEST, "ops": []})
        self.assertNotEqual(a["key"], b["key"])
        pa = json.loads(self.request("GET", f"/api/plan/preview?key={a['key']}&slot=18")[1])
        pb = json.loads(self.request("GET", f"/api/plan/preview?key={b['key']}&slot=18")[1])
        self.assertGreater(pa["trigs"], 0)
        self.assertEqual(pb["trigs"], 0)
        self.assertEqual(self.request("GET", "/api/plan/preview?key=nope&slot=18")[0], 409)
        status, got = self.request("GET", "/api/plan")[0], json.loads(self.request("GET", "/api/plan")[1])
        rev = got["rev"]
        status, stored = self.post("/api/plan/store", {"plan": {"queue": []}, "rev": rev})
        self.assertEqual((status, stored["rev"]), (200, rev + 1))
        status, stale = self.post("/api/plan/store", {"plan": {"queue": [1]}, "rev": rev})  # other tab, old rev
        self.assertEqual(status, 409)
        self.assertEqual(stale["rev"], rev + 1)
        self.assertEqual(json.loads(self.request("GET", "/api/plan")[1])["plan"], {"queue": []})


if __name__ == "__main__":
    unittest.main()
