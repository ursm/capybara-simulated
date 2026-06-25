#!/usr/bin/env python3
"""Execute a WPT `.py` request handler under a minimal wptserve-compatible shim.

The in-process Rack test harness (spec/support/wpt_runner.rb) shells out to this
script for any vendored `.py` handler it doesn't special-case. We are NOT wptserve;
this provides just enough of the request/response API the vendored handlers use
(request.GET/POST/headers/body/raw_input/method/url/url_parts/server; response
.status/headers/content/writer) to run the common "echo / set headers / return
(headers, body)" handlers faithfully.

Protocol: the handler path is argv[1]; the request comes via env (WPT_METHOD,
WPT_URL, WPT_HEADERS as JSON) + the raw body on stdin. We print one JSON metadata
line ({"status", "headers", "body_len"}) then the raw body bytes on stdout. A
handler exception → status 500 with the traceback as the body (the harness logs it).

Out of scope (best-effort stubs, won't pass but won't crash): request.server.stash
(cross-request state — each call is a fresh subprocess) and deep server config.
"""
import sys
sys.dont_write_bytecode = True   # never litter __pycache__ into the vendored WPT tree
import os, json, io, importlib.util
from urllib.parse import urlsplit, parse_qsl


class MultiDict:
    """wptserve request.GET / POST: bytes keys → list of bytes values."""
    def __init__(self, pairs):
        self._d = {}
        for k, v in pairs:
            self._d.setdefault(k, []).append(v)

    def first(self, key, default=None):
        v = self._d.get(_b(key))
        return v[0] if v else default

    def get(self, key, default=None):
        return self.first(key, default)

    def __getitem__(self, key):
        v = self._d.get(_b(key))
        if not v:
            raise KeyError(key)
        return v[0]

    def __contains__(self, key):
        return _b(key) in self._d

    def keys(self):
        return self._d.keys()


def _b(s):
    return s.encode('utf-8') if isinstance(s, str) else s


class Headers:
    """wptserve response.headers: case-insensitive, ordered, set/append/get."""
    def __init__(self):
        self._items = []

    def set(self, name, value):
        n = _b(name)
        self._items = [(k, v) for (k, v) in self._items if k.lower() != n.lower()]
        self._items.append((n, _b(value)))

    def append(self, name, value):
        self._items.append((_b(name), _b(value)))

    def get(self, name, default=None):
        n = _b(name).lower()
        for k, v in self._items:
            if k.lower() == n:
                return v
        return default

    def __setitem__(self, name, value):
        self.set(name, value)

    def __iter__(self):
        return iter(self._items)


class RequestHeaders:
    def __init__(self, pairs):
        self._items = [(_b(k), _b(v)) for k, v in pairs]

    def get(self, name, default=None):
        n = _b(name).lower()
        for k, v in self._items:
            if k.lower() == n:
                return v
        return default

    def __getitem__(self, name):
        v = self.get(name)
        if v is None:
            raise KeyError(name)
        return v

    def __contains__(self, name):
        return self.get(name) is not None


class Stash:
    """No-op stub: cross-request stash can't persist across one-shot subprocesses."""
    def take(self, key, path=None):
        return None

    def put(self, key, value, path=None):
        return None

    def lock(self):
        return None


class Server:
    def __init__(self, config):
        self.config = config
        self.stash = Stash()


class Writer:
    """wptserve response.writer: handlers that stream status/headers/body directly."""
    def __init__(self):
        self.used = False
        self.status = None
        self.headers = []
        self.body = bytearray()

    def write_status(self, code):
        self.used = True
        self.status = int(code)

    def write_header(self, name, value):
        self.used = True
        self.headers.append((_b(name), _b(value)))

    def end_headers(self):
        self.used = True

    def write_content(self, data):
        self.write(data)

    def write(self, data):
        self.used = True
        self.body += _to_bytes(data)


class Request:
    def __init__(self, method, url, headers, body, doc_root):
        self.method = method
        self.url = url
        self.url_parts = urlsplit(url)
        self.body = body
        self.raw_input = io.BytesIO(body)
        self.headers = RequestHeaders(headers)
        self.GET = MultiDict([(_b(k), _b(v)) for k, v in parse_qsl(self.url_parts.query, keep_blank_values=True)])
        ctype = (self.headers.get(b'content-type') or b'').lower()
        post_pairs = []
        if b'application/x-www-form-urlencoded' in ctype:
            try:
                text = body.decode('utf-8', 'replace')
                post_pairs = [(_b(k), _b(v)) for k, v in parse_qsl(text, keep_blank_values=True)]
            except Exception:
                pass
        self.POST = MultiDict(post_pairs)
        self.doc_root = doc_root
        self.server = Server({
            'doc_root': doc_root,
            'browser_host': self.url_parts.hostname or 'web-platform.test',
            'ports': {'http': [self.url_parts.port or 80], 'https': [443]},
        })


class Response:
    def __init__(self):
        self.status = 200
        self.headers = Headers()
        self.content = b''
        self.add_required_headers = True
        self.writer = Writer()

    @property
    def status_code(self):
        return self.status if isinstance(self.status, int) else self.status[0]

    @status_code.setter
    def status_code(self, v):
        self.status = v


def _to_bytes(v):
    if v is None:
        return b''
    if isinstance(v, bytes):
        return v
    if isinstance(v, str):
        return v.encode('utf-8')
    if isinstance(v, (list, tuple)):
        return b''.join(_to_bytes(x) for x in v)
    return str(v).encode('utf-8')


def _status_code(status):
    if isinstance(status, int):
        return status
    if isinstance(status, (list, tuple)) and status:
        return int(status[0])
    return 200


def main():
    handler_path = sys.argv[1]
    method = os.environ.get('WPT_METHOD', 'GET')
    url = os.environ.get('WPT_URL', 'http://web-platform.test/')
    doc_root = os.environ.get('WPT_DOC_ROOT', '')
    headers = json.loads(os.environ.get('WPT_HEADERS', '[]'))
    body = sys.stdin.buffer.read()

    request = Request(method, url, headers, body, doc_root)
    response = Response()

    spec = importlib.util.spec_from_file_location('wpt_handler', handler_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = module.main(request, response)

    # Resolve the final (status, headers, body) from however the handler answered.
    if response.writer.used:
        status = response.writer.status if response.writer.status is not None else _status_code(response.status)
        hdrs = response.writer.headers
        out_body = bytes(response.writer.body)
    elif isinstance(result, tuple):
        if len(result) == 3:
            status, hdrs, content = result
            status = _status_code(status)
        else:
            hdrs, content = result
            status = _status_code(response.status)
        hdrs = [(_b(k), _b(v)) for k, v in hdrs]
        out_body = _to_bytes(content)
    else:
        status = _status_code(response.status)
        hdrs = [(_b(k), _b(v)) for k, v in response.headers]
        out_body = _to_bytes(response.content if response.content else result)

    meta = {
        'status': status,
        'headers': [[k.decode('latin-1'), v.decode('latin-1')] for k, v in hdrs],
        'body_len': len(out_body),
    }
    sys.stdout.write(json.dumps(meta) + '\n')
    sys.stdout.flush()
    sys.stdout.buffer.write(out_body)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        tb = traceback.format_exc().encode('utf-8')
        meta = {'status': 500, 'headers': [['content-type', 'text/plain']], 'body_len': len(tb)}
        sys.stdout.write(json.dumps(meta) + '\n')
        sys.stdout.flush()
        sys.stdout.buffer.write(tb)
        sys.stdout.buffer.flush()
