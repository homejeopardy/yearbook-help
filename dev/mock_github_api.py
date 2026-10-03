"""
A stand-in for the slice of GitHub's REST API that js/sync.js uses, for testing sync
locally without a real account or access key. It follows GitHub's rules where sync
depends on them:

  GET  /repos/{owner}/{repo}                  401 bad key, 404 wrong repo
  GET  /repos/{owner}/{repo}/contents/{path}  base64 content + sha, ETag; 304 on If-None-Match
  PUT  /repos/{owner}/{repo}/contents/{path}  409 if sha is stale, 422 if sha missing for an
                                              existing file; sha = git blob sha1

Test controls (not part of GitHub):
  POST /__reset          forget every file        GET /__files   decoded files + commit count
  POST /__latency?ms=N   delay every API reply    POST /__down   answer 503 until /__up

Run:  python3 dev/mock_github_api.py [port]   (default 8789; key: test-key)
Then in the app on localhost:  localStorage['yearbook-help-dev-api'] = 'http://localhost:8789'
"""
import base64, hashlib, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

REPO = "homejeopardy/yearbook-help-data"
# repository -> readable without a key?
REPOS = {REPO: False, "homejeopardy/yearbook-help-accounts": True}
KEY = "test-key"
files = {}          # path -> bytes
commits = []        # (path, message)
state = {"latency": 0, "down": False}
lock = threading.Lock()


def blob_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("mock-github: " + (fmt % args) + "\n")

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "ETag, X-RateLimit-Remaining")

    def reply(self, code, body=None, headers=None):
        raw = b"" if body is None else json.dumps(body).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    # --- test controls ---
    def control(self):
        u = urlparse(self.path)
        if u.path == "/__reset":
            with lock:
                files.clear(); commits.clear(); state.update(latency=0, down=False)
            return self.reply(200, {"ok": True})
        if u.path == "/__files":
            with lock:
                out = {p: json.loads(d.decode() or "{}") for p, d in files.items()}
                return self.reply(200, {"files": out, "commits": len(commits), "log": commits[-10:],
                                        "raw": {p: d.decode() for p, d in files.items()}})
        if u.path == "/__latency":
            state["latency"] = int(parse_qs(u.query).get("ms", ["0"])[0])
            return self.reply(200, state)
        if u.path == "/__down":
            state["down"] = True; return self.reply(200, state)
        if u.path == "/__up":
            state["down"] = False; return self.reply(200, state)
        return self.reply(404, {"message": "unknown control"})

    def api(self, method):
        if state["latency"]:
            time.sleep(state["latency"] / 1000)
        if state["down"]:
            return self.reply(503, {"message": "Service unavailable"})
        path = urlparse(self.path).path
        repo = next((r for r in REPOS if path.startswith("/repos/" + r)), None)
        if repo is None:
            return self.reply(404, {"message": "Not Found"})
        public_read = REPOS[repo] and method == "GET"
        auth = self.headers.get("Authorization")
        if (auth or not public_read) and auth != "Bearer " + KEY:
            return self.reply(401, {"message": "Bad credentials"})
        rest = path[len("/repos/" + repo):]
        if rest == "" and method == "GET":
            return self.reply(200, {"full_name": repo, "private": not REPOS[repo]})
        if not rest.startswith("/contents/"):
            return self.reply(404, {"message": "Not Found"})
        name = rest[len("/contents/"):]
        if repo != REPO:
            name = "accounts/" + name      # kept apart from the ticket files
        with lock:
            if method == "GET":
                if name not in files:
                    return self.reply(404, {"message": "Not Found"})
                data = files[name]
                sha = blob_sha(data)
                etag = 'W/"%s"' % sha
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304); self.cors(); self.send_header("ETag", etag); self.end_headers()
                    return
                b64 = base64.b64encode(data).decode()
                wrapped = "\n".join(b64[i:i + 60] for i in range(0, len(b64), 60)) + "\n"
                return self.reply(200, {"type": "file", "encoding": "base64", "size": len(data), "name": name,
                                        "path": name.split("/")[-1], "sha": sha, "content": wrapped}, {"ETag": etag})
            if method == "PUT":
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                exists = name in files
                if exists and "sha" not in body:
                    return self.reply(422, {"message": "Invalid request.\n\n\"sha\" wasn't supplied."})
                if exists and body["sha"] != blob_sha(files[name]):
                    return self.reply(409, {"message": "%s does not match %s" % (name, body["sha"])})
                data = base64.b64decode(body["content"])
                files[name] = data
                commits.append((name, body.get("message", "")))
                return self.reply(200 if exists else 201, {"content": {"name": name, "path": name, "sha": blob_sha(data)},
                                                           "commit": {"message": body.get("message", "")}})
        return self.reply(405, {"message": "Method not allowed"})

    def do_GET(self):
        return self.control() if self.path.startswith("/__") else self.api("GET")

    def do_PUT(self):
        return self.api("PUT")

    def do_POST(self):
        return self.control() if self.path.startswith("/__") else self.reply(405, {})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8789
    print("mock GitHub API on http://localhost:%d  (repo %s, key %s)" % (port, REPO, KEY), flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
