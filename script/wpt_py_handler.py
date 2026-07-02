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
import os, json, io, re, base64, hashlib, importlib.util, pickle, posixpath
from email.utils import formatdate
from urllib.parse import urlsplit, parse_qsl


class FileUpload(bytes):
    """A wptserve multipart FILE field (a part with a `filename`). Subclasses bytes so
    it IS the file content, and carries the attributes upload.py reads: `.filename`
    (str), `.headers["Content-Type"]` (str or None), and `.file` (a readable BytesIO).
    A non-file (string) field is just plain `bytes` — it has no `.filename`, which is
    exactly how upload.py tells the two apart (`hasattr(value, "filename")`)."""
    def __new__(cls, content, filename=None, content_type=None):
        return super().__new__(cls, content)

    def __init__(self, content, filename=None, content_type=None):
        dec = lambda v: v.decode('latin-1') if isinstance(v, (bytes, bytearray)) else v
        self.filename = dec(filename)
        self.headers  = {u"Content-Type": dec(content_type)}
        self.file     = io.BytesIO(content)
        self.value    = content   # the file content bytes (file-submission.py reads .value)


def parse_multipart(ctype, body):
    """Parse a multipart/form-data body into [(name_bytes, value)] pairs, preserving raw
    bytes (a leading CRLF after each boundary and the trailing CRLF before the next are
    stripped without touching the part body). A string field's value is plain bytes; a
    file part (one with a filename) becomes a FileUpload. `ctype` MUST keep its original
    case — the boundary token is case-sensitive."""
    m = re.search(rb'boundary=([^;]+)', ctype)
    if not m:
        return []
    boundary = m.group(1).strip().strip(b'"')
    segments = body.split(b'--' + boundary)
    pairs = []
    for seg in segments[1:-1]:   # drop the preamble and the closing "--\r\n"
        if seg.startswith(b'\r\n'):
            seg = seg[2:]
        if seg.endswith(b'\r\n'):
            seg = seg[:-2]
        raw_headers, sep, content = seg.partition(b'\r\n\r\n')
        if not sep:
            continue
        name = filename = part_ctype = None
        for line in raw_headers.split(b'\r\n'):
            low = line.lower()
            if low.startswith(b'content-disposition:'):
                nm = re.search(rb'name="([^"]*)"', line)
                fn = re.search(rb'filename="([^"]*)"', line)
                if nm:
                    name = nm.group(1)
                if fn:
                    filename = fn.group(1)
            elif low.startswith(b'content-type:'):
                part_ctype = line.split(b':', 1)[1].strip()
        if name is None:
            continue
        pairs.append((name, FileUpload(content, filename, part_ctype) if filename is not None else content))
    return pairs


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

    def items(self):
        # wptserve returns (key, [values]) pairs — upload.py reads values[0] and splits
        # fields from files by whether values[0] has a `filename` attribute.
        return [(k, list(v)) for k, v in self._d.items()]


def _b(s):
    if isinstance(s, bytes):
        return s
    if isinstance(s, str):
        return s.encode('utf-8')
    # wptserve coerces a non-str/bytes header value (e.g. an int Access-Control-Max-Age,
    # as header-user-agent.py sets) to its string form before sending.
    return str(s).encode('utf-8')


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

    def update(self, pairs):
        # wptserve response.headers.update: set each (name, value), replacing any prior
        # value for that name (echo-content.h2.py's handle_headers sets Content-Type this way).
        items = pairs.items() if hasattr(pairs, 'items') else pairs
        for name, value in items:
            self.set(name, value)

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

    def __iter__(self):
        # wptserve iterates request.headers as header NAMES (bytes), deduped in
        # first-seen order — inspect-headers.py's `b", ".join(request.headers)` builds
        # Access-Control-Allow-Headers from them (without it, iterating via __getitem__
        # raised KeyError → the cross-origin ?cors handler 500'd).
        seen = []
        for k, _ in self._items:
            if k not in seen:
                seen.append(k)
        return iter(seen)

    def __str__(self):
        # wptserve's raw_headers stringifies to the on-the-wire header block; echo
        # -headers.py returns `str(request.raw_headers)` and the test greps it for
        # `Name: value` lines (with the author's exact casing + combined values).
        return ''.join(u'%s: %s\r\n' % kv for kv in self.raw_items())

    def raw_items(self):
        # wptserve exposes the on-the-wire header pairs as (str, str), preserving
        # order, case, and duplicates (inspect-headers.py re-encodes them with
        # isomorphic_encode). Our pairs are stored isomorphic (latin-1) bytes.
        return [(k.decode('latin-1'), v.decode('latin-1')) for k, v in self._items]


class Auth:
    """wptserve request.auth: the decoded HTTP Basic credentials (bytes), or None
    when the request carries no (parseable) Basic Authorization header."""
    def __init__(self, header):
        self.username = None
        self.password = None
        if header and header[:6].lower() == b'basic ':
            try:
                user, _, pw = base64.b64decode(header[6:]).partition(b':')
                self.username, self.password = user, pw
            except Exception:
                pass


class _NullLock:
    def __enter__(self): return self
    def __exit__(self, *exc): return False


class Stash:
    """wptserve request.server.stash: a per-test key→value store. Each .py runs in its
    own subprocess, so persist across them via files in WPT_STASH_DIR (the runner makes
    one dir per test file and clears it between files). take() is a pop (read+remove),
    put() writes. Values are arbitrary Python objects (preflight.py stashes a dict of
    counters, other handlers a bytes flag), so they are pickled — matching wptserve,
    whose stash holds live objects, not just bytes.

    Scoped by request PATH, like wptserve: take()/put() default `path` to the requesting
    handler's URL path, so two handlers using the same token don't collide (a cors-redirect
    hop stashes {count} under redirect.py while preflight.py, reading the same token under
    ITS path, correctly sees nothing and uses its own default state)."""
    def __init__(self, default_path=None):
        self.dir = os.environ.get('WPT_STASH_DIR')
        self.default_path = default_path or ''

    def _file(self, key, path):
        if not self.dir:
            return None
        scope = path if path is not None else self.default_path
        raw = (str(scope) + '\x00').encode('utf-8')
        raw += key if isinstance(key, bytes) else str(key).encode('utf-8')
        return os.path.join(self.dir, hashlib.sha1(raw).hexdigest())

    def take(self, key, path=None):
        p = self._file(key, path)
        if not p or not os.path.exists(p):
            return None
        try:
            with open(p, 'rb') as f:
                data = f.read()
            os.remove(p)
            return pickle.loads(data)
        except (OSError, EOFError, pickle.UnpicklingError):
            return None

    def put(self, key, value, path=None):
        p = self._file(key, path)
        if not p:
            return
        try:
            with open(p, 'wb') as f:
                pickle.dump(value, f)
        except OSError:
            pass

    def lock(self):
        return _NullLock()


class Server:
    def __init__(self, config, stash_path=None):
        self.config = config
        self.stash = Stash(stash_path)


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

    def write_data(self, data, last=False):
        # h2 DATA-frame body write (response.writer.write_data) — same buffer as write().
        self.write(data)

    def write(self, data):
        self.used = True
        self.body += _to_bytes(data)


class _H2Frame:
    """A single buffered HTTP/2 frame handed to an h2 handler's handle_headers /
    handle_data. `data` is the whole request body (we model the upload as one DATA
    frame — no incremental delivery, mid-stream reset, or trailers)."""
    def __init__(self, data):
        self.data = data
        self.headers = []


class CookieValue:
    """wptserve request.cookies value: `.value` is the cookie's bytes."""
    def __init__(self, value):
        self.value = value


class Cookies:
    """wptserve request.cookies: iterates cookie NAMES (bytes); `.get(name).value`
    is the value. Parsed from the request Cookie header."""
    def __init__(self, header):
        self._d = {}
        for part in (header or b'').split(b';'):
            part = part.strip()
            if not part:
                continue
            name, _, value = part.partition(b'=')
            self._d[name.strip()] = CookieValue(value.strip())

    def __iter__(self):
        return iter(self._d)

    def get(self, name, default=None):
        return self._d.get(_b(name), default)

    def __contains__(self, name):
        return _b(name) in self._d


class Request:
    def __init__(self, method, url, headers, body, doc_root):
        self.method = method
        self.url = url
        self.url_parts = urlsplit(url)
        # wptserve's request_path: the request-target — path plus query string (the
        # fragment never reaches the server), no scheme/host. requri.py echoes it.
        self.request_path = self.url_parts.path + (
            '?' + self.url_parts.query if self.url_parts.query else '')
        self.body = body
        self.raw_input = io.BytesIO(body)
        self.headers = RequestHeaders(headers)
        self.raw_headers = self.headers   # wptserve's raw (str-pair) view; same backing pairs
        self.cookies = Cookies(self.headers.get(b'cookie'))
        # wptserve's request.GET preserves the RAW percent-decoded bytes of each
        # query field (status.py?content=%FF must yield the byte 0xFF, not a UTF-8
        # re-decode of it). parse_qsl with the default UTF-8 decode would turn a
        # non-UTF-8 escape into U+FFFD; parse byte-isomorphically (latin-1) and encode
        # back to the same bytes.
        # encode back with errors='replace' too: a literal codepoint > U+00FF left in
        # the query (un-percent-encoded non-Latin1) isn't latin-1-representable and would
        # otherwise raise — a malformed-input request should degrade, not crash the handler.
        self.GET = MultiDict([
            (k.encode('latin-1', 'replace'), v.encode('latin-1', 'replace'))
            for k, v in parse_qsl(self.url_parts.query, keep_blank_values=True,
                                  encoding='latin-1', errors='replace')])
        ctype_raw = self.headers.get(b'content-type') or b''   # keep case for the boundary
        ctype = ctype_raw.lower()
        post_pairs = []
        if b'application/x-www-form-urlencoded' in ctype:
            try:
                text = body.decode('utf-8', 'replace')
                post_pairs = [(_b(k), _b(v)) for k, v in parse_qsl(text, keep_blank_values=True)]
            except Exception:
                pass
        elif b'multipart/form-data' in ctype:
            try:
                post_pairs = parse_multipart(ctype_raw, body)
            except Exception:
                pass
        self.POST = MultiDict(post_pairs)
        self.doc_root = doc_root
        self.server = Server({
            'doc_root': doc_root,
            'browser_host': self.url_parts.hostname or 'web-platform.test',
            'ports': {'http': [self.url_parts.port or 80], 'https': [443]},
        }, stash_path=posixpath.normpath(self.url_parts.path or '/'))
        self.auth = Auth(self.headers.get(b'authorization'))


class Response:
    def __init__(self):
        self.status = 200
        self.headers = Headers()
        # Default to a str so a handler that BUILDS content incrementally
        # (`response.content += isomorphic_decode(...)`, a str) works; a handler that
        # sets bytes (`response.content = b"..."`) just overwrites it. _to_bytes coerces
        # either form at the end.
        self.content = ''
        self.add_required_headers = True
        self.writer = Writer()

    @property
    def status_code(self):
        return self.status if isinstance(self.status, int) else self.status[0]

    @status_code.setter
    def status_code(self, v):
        self.status = v

    def set_error(self, code, message=''):
        # wptserve response.set_error: put the response into an error state. The handler
        # then returns its (error) body, which main() uses; we just carry the status.
        self.status  = int(code)
        self.content = message.encode('utf-8') if isinstance(message, str) else (message or b'')

    def write_status_headers(self):
        # wptserve: flush the status line + the headers set so far, then let the
        # handler stream the (possibly chunked) body via response.writer.write.
        self.writer.used    = True
        self.writer.status  = self.status_code
        self.writer.headers = [(_b(k), _b(v)) for k, v in self.headers]

    def set_cookie(self, name, value, expires=None, secure=False, path=b'/',
                   domain=None, max_age=None, httponly=False, **kw):
        # Append a Set-Cookie header (the driver's cookie store applies Secure /
        # Expires when deciding what to send on later requests). `expires` may be a
        # datetime.timedelta (relative) — a negative one (get-set-cookie.py?clear=1)
        # yields a past date, i.e. a deletion.
        parts = [_b(name) + b'=' + _b(value)]
        if path:                 parts.append(b'Path=' + _b(path))
        if domain:               parts.append(b'Domain=' + _b(domain))
        if max_age is not None:  parts.append(b'Max-Age=' + _b(str(max_age)))
        if expires is not None:
            import datetime as _dt
            if isinstance(expires, _dt.timedelta):
                exp = _dt.datetime.now(_dt.timezone.utc) + expires
            else:
                exp = expires
                if exp.tzinfo is None:   # a naive datetime is UTC, not the host's local zone
                    exp = exp.replace(tzinfo=_dt.timezone.utc)
            parts.append(b'Expires=' + _b(formatdate(exp.timestamp(), usegmt=True)))
        if secure:               parts.append(b'Secure')
        if httponly:             parts.append(b'HttpOnly')
        self.headers.append(b'Set-Cookie', b'; '.join(parts))


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


def _status_reason(status):
    # A handler may return status as `(code, b"reason phrase")` (wptserve) — surface
    # the reason so the client can expose it as XHR statusText.
    if isinstance(status, (list, tuple)) and len(status) >= 2:
        s = status[1]
        return s.decode('latin-1') if isinstance(s, (bytes, bytearray)) else str(s)
    return None


def _parse_raw_http(raw):
    """Parse a complete raw HTTP response (status line + headers + blank line + body)
    a handler streamed via response.writer.write. Bare-LF separators occur in the
    corpus, so accept either. Returns (code, reason, [(name,value)bytes], body)."""
    idx, sep = raw.find(b'\r\n\r\n'), 4
    if idx == -1:
        idx, sep = raw.find(b'\n\n'), 2
    head = raw[:idx] if idx != -1 else raw
    body = raw[idx + sep:] if idx != -1 else b''
    lines = head.replace(b'\r\n', b'\n').split(b'\n')
    m = re.match(rb'HTTP/\d\.\d\s+(\d{3})(?:\s+(.*))?', lines[0] if lines else b'')
    code = int(m.group(1)) if m else 200
    # For a raw response the status line IS the wire, so statusText is exactly its reason
    # phrase — EMPTY when the phrase is empty ("HTTP/1.1 200 ") or entirely absent
    # ("HTTP/1.1 200"), NEVER synthesized to the standard reason (h1-parsing/status-code
    # expects ""). Only a status line that doesn't parse at all leaves reason None so the
    # client falls back to the standard reason.
    if m:
        reason = m.group(2).decode('latin-1') if m.group(2) is not None else ''
    else:
        reason = None
    hdrs = []
    for line in lines[1:]:
        if b':' in line:
            name, _, value = line.partition(b':')
            hdrs.append((name.strip(), value.strip()))
    return code, reason, hdrs, body


def _dechunk(body):
    """Decode an HTTP chunked-transfer body: `<hex-size>[;ext]\\r\\n<data>\\r\\n` repeated,
    ending at a `0\\r\\n` last-chunk (any trailers after it are discarded). Bytes after a
    malformed size line are left as-is rather than raising."""
    out = bytearray()
    i = 0
    while i < len(body):
        eol = body.find(b'\r\n', i)
        if eol == -1:
            break
        size_field = body[i:eol].split(b';', 1)[0].strip()   # drop any chunk-extension
        try:
            size = int(size_field, 16)
        except ValueError:
            break
        i = eol + 2
        if size == 0:
            break
        out += body[i:i + size]
        i += size
        if body[i:i + 2] == b'\r\n':   # CRLF terminating the chunk data
            i += 2
    return bytes(out)


def register_wptserve_stub():
    """Vendored handlers commonly do `from wptserve.utils import isomorphic_decode
    / isomorphic_encode` or `from wptserve.handlers import json_handler`. We aren't
    wptserve; register minimal `wptserve.utils` / `wptserve.handlers` so those imports
    resolve (latin-1 byte<->codepoint round-trips + the JSON-response decorator)."""
    import types
    if 'wptserve.utils' in sys.modules:
        return
    utils = types.ModuleType('wptserve.utils')
    utils.isomorphic_decode = lambda s: s.decode('latin-1') if isinstance(s, (bytes, bytearray)) else s
    utils.isomorphic_encode = lambda s: s.encode('latin-1') if isinstance(s, str) else s
    # wptserve's @json_handler: run the handler, JSON-serialize its return value, and answer
    # as application/json (stash-take.py and many others use it).
    handlers = types.ModuleType('wptserve.handlers')
    def json_handler(func):
        def handler(request, response):
            rv = func(request, response)
            response.headers.set(b'Content-Type', b'application/json')
            return json.dumps(rv)
        return handler
    handlers.json_handler = json_handler
    pkg = types.ModuleType('wptserve')
    pkg.utils = utils
    pkg.handlers = handlers
    sys.modules['wptserve'] = pkg
    sys.modules['wptserve.utils'] = utils
    sys.modules['wptserve.handlers'] = handlers


def main():
    handler_path = sys.argv[1]
    method = os.environ.get('WPT_METHOD', 'GET')
    url = os.environ.get('WPT_URL', 'http://web-platform.test/')
    doc_root = os.environ.get('WPT_DOC_ROOT', '')
    headers = json.loads(os.environ.get('WPT_HEADERS', '[]'))
    body = sys.stdin.buffer.read()

    request = Request(method, url, headers, body, doc_root)
    response = Response()

    register_wptserve_stub()
    spec = importlib.util.spec_from_file_location('wpt_handler', handler_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if callable(getattr(module, 'main', None)):
        result = module.main(request, response)
    elif hasattr(module, 'handle_data') or hasattr(module, 'handle_headers'):
        # HTTP/2 frame handler (e.g. echo-content.h2.py): emulate a single-frame buffered
        # request — deliver the headers, then the whole body as one DATA frame. True
        # incremental h2 framing (mid-stream abort / 401 / trailers) is not modeled.
        frame = _H2Frame(request.body)
        if hasattr(module, 'handle_headers'):
            module.handle_headers(frame, request, response)
        if hasattr(module, 'handle_data'):
            module.handle_data(frame, request, response)
        result = None
    else:
        raise AttributeError(
            "handler module defines neither main(request, response) nor an h2 "
            "handle_headers/handle_data pair")

    # Resolve the final (status, headers, body) from however the handler answered.
    status_reason = None   # a custom HTTP reason phrase, when the handler set status = (code, "text")
    if response.writer.used:
        raw = bytes(response.writer.body)
        if (response.writer.status is None and not response.writer.headers
                and raw[:5] == b'HTTP/'):
            # A handler that wrote a COMPLETE raw HTTP response via writer.write
            # (echo-method.py) — status line + headers + blank line + body, bypassing
            # wptserve's framing. Parse it the way serve_asis parses a `.asis` file.
            status, status_reason, hdrs, out_body = _parse_raw_http(raw)
        else:
            status = response.writer.status if response.writer.status is not None else _status_code(response.status)
            hdrs = response.writer.headers
            out_body = raw
    elif isinstance(result, tuple):
        if len(result) == 3:
            raw_status, hdrs, content = result
        else:
            hdrs, content = result
            raw_status = response.status
        status = _status_code(raw_status)
        status_reason = _status_reason(raw_status)
        hdrs = [(_b(k), _b(v)) for k, v in hdrs]
        out_body = _to_bytes(content)
    else:
        status = _status_code(response.status)
        status_reason = _status_reason(response.status)
        hdrs = [(_b(k), _b(v)) for k, v in response.headers]
        out_body = _to_bytes(response.content if response.content else result)

    # A handler that STREAMED a `Transfer-Encoding: chunked` body via the writer
    # (chunked.py) wrote the chunk framing + any trailers by hand. A real client
    # dechunks transparently: the XHR sees the decoded body, the hop-by-hop
    # Transfer-Encoding header is stripped, and trailers are dropped (only the
    # `Trailer` header that announced them survives — getresponseheader-chunked-trailer).
    # Gated on writer.used: only a hand-framed writer body carries the chunk framing;
    # a tuple/content handler that merely sets the header returns an already-decoded
    # body that must not be re-decoded. (A malformed/truncated stream — bad-chunk
    # -encoding.py — is decoded leniently; surfacing it as a network error is the
    # separate response-body-errors backlog item.)
    if response.writer.used and any(k.lower() == b'transfer-encoding' and b'chunked' in v.lower() for k, v in hdrs):
        out_body = _dechunk(out_body)
        hdrs = [(k, v) for k, v in hdrs if k.lower() != b'transfer-encoding']

    # wptserve injects Server + Date on every non-writer response (its
    # `add_required_headers` default) — the getResponseHeader server-and-date test
    # asserts both are present even though the handler set neither.
    if response.add_required_headers and not response.writer.used:
        have = {k.lower() for k, _ in hdrs}
        if b'date' not in have:
            hdrs.append((b'Date', _b(formatdate(usegmt=True))))
        if b'server' not in have:
            hdrs.append((b'Server', b'capybara-simulated-wpt-shim'))
        # A real server frames the response with Content-Length when the handler didn't
        # (cors-safelisted-response-headers asserts getResponseHeader('content-length')).
        if b'content-length' not in have:
            hdrs.append((b'Content-Length', str(len(out_body)).encode('latin-1')))

    meta = {
        'status': status,
        'status_text': status_reason,
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
