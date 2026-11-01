// The fields of a navigation's response a navigation reads (navigation_fetch.rs `response`) and the document it makes is
// made with (`Native.document_params`), read off the host's header map in one pass: a Rack app's — its names in any case
// (a Rack 2 app's may be mixed-case), a value a String or, Rack 3's form, an Array of fields; several fields of a name a
// Rack 2 app joins with newlines — or a service worker's response's, its fields combined already.

use magnus::{prelude::*, r_hash::ForEach, Error, RArray, RHash, RString, Ruby, Value};

use crate::fetch_rules::ruby_bytes;
use crate::http_cache::combine;
// (…a header value as script reads it: each byte the code point it is)
use crate::isomorphic::decode as isomorphic_decode;

#[derive(Default)]
pub(crate) struct ResponseFields {
    // The first Location header's fields as they came, distinct — none for no header (an empty Array too).
    pub(crate) locations: Vec<Vec<u8>>,
    pub(crate) referrer_policy: Option<&'static str>,
    pub(crate) content_disposition: Option<Vec<u8>>,
    pub(crate) coop: Option<String>,
    pub(crate) coep: Option<String>,
    // Every Content-Security-Policy header's value, joined by ",": as script reads the policy.
    pub(crate) csp: Option<String>,
    pub(crate) content_type: Option<String>,
    // The Refresh header's fields joined by ", ", as Fetch's "get a header" combines them — each as it came.
    pub(crate) refresh: Option<String>,
    // The first Set-Cookie header's set-cookie-strings as they came: Rack 3's Array of them, Rack 2's one String of them
    // joined by newlines — none for an empty one.
    pub(crate) set_cookie: Vec<Vec<u8>>,
}


// A Rack 2 value's fields: its String split at newlines as Ruby's `String#split` splits it — the empty fields it ends in
// dropped.
fn lines(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = bytes.split(|&b| b == b'\n').map(<[u8]>::to_vec).collect();
    while out.last().is_some_and(Vec::is_empty) {
        out.pop();
    }
    out
}

// …and Location's fields as a navigation reads them: Rack 3's Array of them, or Rack 2's one String of them joined by
// newlines — an empty one a field all the same — each as it came, distinct.
fn location_fields(value: Value) -> Result<Vec<Vec<u8>>, Error> {
    let mut out: Vec<Vec<u8>> = Vec::new();
    let mut add = |field: Vec<u8>| {
        if !out.contains(&field) {
            out.push(field);
        }
    };
    match RArray::from_value(value) {
        Some(list) => {
            for field in list {
                add(ruby_bytes(field.funcall::<_, _, RString>("to_s", ())?));
            }
        }
        None => {
            let bytes = ruby_bytes(value.funcall::<_, _, RString>("to_s", ())?);
            if bytes.is_empty() {
                add(bytes);
            } else {
                lines(&bytes).into_iter().for_each(add);
            }
        }
    }
    Ok(out)
}

// …and Set-Cookie's, each set-cookie-string as it came.
fn set_cookie_lines(value: Value) -> Result<Vec<Vec<u8>>, Error> {
    if value.is_nil() {
        return Ok(Vec::new());
    }
    Ok(match RArray::from_value(value) {
        Some(list) => list.into_iter().map(|line| line.funcall::<_, _, RString>("to_s", ()).map(ruby_bytes)).collect::<Result<_, _>>()?,
        None => {
            let bytes = ruby_bytes(value.funcall::<_, _, RString>("to_s", ())?);
            lines(&bytes)
        }
    })
}

// A header map of `headers`: a Hash as it is, else — anything whose `to_a` gives [name, value] pairs: a Rack 2 app's
// Array of them, a service worker's response's header list — a new Hash of them, a name given more than once a new Array
// of all its fields, as Rack 3 gives them (a value that is an Array of fields itself spread into it, never changed): so a
// header list's two Location, Set-Cookie or Content-Security-Policy fields stay two, end to end.
pub(crate) fn header_map(ruby: &Ruby, headers: Value) -> Result<RHash, Error> {
    if let Some(hash) = RHash::from_value(headers) {
        return Ok(hash);
    }
    // (…a name's fields grouped by the name ASCII-lowercased, as header names compare (Fetch "header list"), under the
    // first spelling it came in — every lookup of the host's is ASCII case-insensitive)
    let mut names: Vec<(Vec<u8>, Value, Vec<Value>)> = Vec::new();
    for pair in headers.funcall::<_, _, RArray>("to_a", ())? {
        let pair = RArray::try_convert(pair)?;
        let (k, v): (Value, Value) = (pair.entry(0)?, pair.entry(1)?);
        let fields: Vec<Value> = RArray::from_value(v).map_or_else(|| vec![v], |list| list.into_iter().collect());
        let key = ruby_bytes(k.funcall("to_s", ())?).to_ascii_lowercase();
        match names.iter_mut().find(|(name, ..)| *name == key) {
            Some((.., seen)) => seen.extend(fields),
            None => names.push((key, k, fields)),
        }
    }
    let hash = ruby.hash_new();
    for (_, k, fields) in names {
        match fields.as_slice() {
            [one] => hash.aset(k, *one)?,
            _ => hash.aset(k, ruby.ary_from_iter(fields))?,
        }
    }
    Ok(hash)
}
// Native.header_map(headers) -> `header_map`'s, nil for nil.
pub(crate) fn header_map_for_ruby(ruby: &Ruby, headers: Option<Value>) -> Result<Option<RHash>, Error> {
    headers.map(|h| header_map(ruby, h)).transpose()
}

impl ResponseFields {
    // (…`headers` a Hash, or anything else whose `to_a` gives [name, value] pairs: a Rack 2 app's Array of them, a
    // service worker's response's header list)
    pub(crate) fn read(headers: Option<Value>) -> Result<Self, Error> {
        let mut out = ResponseFields::default();
        let Some(headers) = headers else { return Ok(out) };
        let headers = header_map(&Ruby::get_with(headers), headers)?;
        let (mut location, mut policy, mut disposition, mut coop, mut coep, mut content_type, mut refresh, mut cookie) = (false, false, false, false, false, false, false, false);
        let mut csp: Vec<String> = Vec::new();
        headers.foreach(|k: Value, v: Value| {
            let name = ruby_bytes(k.funcall("to_s", ())?);
            let is = |n: &str| name.eq_ignore_ascii_case(n.as_bytes());
            let text = |v: Value| -> Result<Option<String>, Error> { Ok(combine(v)?.map(|b| isomorphic_decode(&b))) };
            // (…the first header of a name, as the host's `header_field` reads one — but every Content-Security-Policy)
            if is("location") && !location {
                location = true;
                if !v.is_nil() {
                    out.locations = location_fields(v)?;
                }
            } else if is("referrer-policy") && !policy {
                policy = true;
                out.referrer_policy = text(v)?.as_deref().and_then(crate::url_ops::policy_of_header);
            } else if is("content-disposition") && !disposition {
                disposition = true;
                out.content_disposition = combine(v)?;
            } else if is("cross-origin-opener-policy") && !coop {
                coop = true;
                out.coop = text(v)?;
            } else if is("cross-origin-embedder-policy") && !coep {
                coep = true;
                out.coep = text(v)?;
            } else if is("content-type") && !content_type {
                content_type = true;
                out.content_type = text(v)?;
            } else if is("refresh") && !refresh {
                refresh = true;
                if !v.is_nil() {
                    let bytes = match RArray::from_value(v) {
                        Some(list) => list.into_iter().map(|f| f.funcall::<_, _, RString>("to_s", ()).map(ruby_bytes)).collect::<Result<Vec<_>, _>>()?.join(&b", "[..]),
                        None => ruby_bytes(v.funcall("to_s", ())?),
                    };
                    // (…as the app gave it, a UTF-8 one's text: a URL in it is parsed as the document's)
                    out.refresh = Some(String::from_utf8(bytes).unwrap_or_else(|e| isomorphic_decode(e.as_bytes())));
                }
            } else if is("set-cookie") && !cookie {
                cookie = true;
                out.set_cookie = set_cookie_lines(v)?;
            } else if is("content-security-policy") {
                if let Some(value) = text(v)? {
                    csp.push(value);
                }
            }
            Ok(ForEach::Continue)
        })?;
        out.csp = (!csp.is_empty()).then(|| csp.join(","));
        Ok(out)
    }

    // A navigation's redirect, where `status` is a redirect status: its Location fields — more than one a network error
    // as the redirect is followed (fetch_chain.rs `follow`: "extract header list values"; Chrome's
    // ERR_RESPONSE_HEADERS_MULTIPLE_LOCATION) — none where it has none or one empty one, the response then made a
    // document as it is (an empty Location parses back to the URL it came from).
    pub(crate) fn redirect_locations(&self, status: u32) -> Option<&[Vec<u8>]> {
        if !crate::fetch_rules::redirect_status(status) {
            return None;
        }
        match self.locations.as_slice() {
            [] => None,
            [one] if one.is_empty() => None,
            all => Some(all),
        }
    }

    // Whether the response downloads: its Content-Disposition says so (downloads.rs `is_download`), or its Content-Type is
    // of no document (mime.rs `load`) — where that needs no body (`sniffs`).
    pub(crate) fn downloads(&self) -> bool {
        self.content_disposition.as_deref().is_some_and(crate::downloads::is_download) || self.loads(crate::mime::Load::Download)
    }
    // …whether it is a PDF viewer's inline content (mime.rs `Load::Inline`).
    pub(crate) fn inline(&self) -> bool {
        self.loads(crate::mime::Load::Inline)
    }
    fn loads(&self, what: crate::mime::Load) -> bool {
        let ct = self.content_type.as_deref();
        !crate::mime::needs_body(ct) && crate::mime::load(ct, b"") == what
    }
    // …whether it does — and the type of the document it makes — is for its body to say: MIME Sniffing's computed
    // MIME type of one of no type to go by, or of an Apache-bug `text/plain` (mime.rs `needs_body`).
    pub(crate) fn sniffs(&self) -> bool {
        crate::mime::needs_body(self.content_type.as_deref())
    }

    // The document's opener policy (coop.rs `obtain`).
    pub(crate) fn opener_policy(&self) -> crate::coop::Value {
        crate::coop::obtain(self.coop.as_deref(), self.coep.as_deref())
    }
}

// Native.document_params(headers) -> [content type, Content-Security-Policy, referrer policy, Refresh, opener policy]:
// what the document a response of header map `headers` (nil none) makes is made with (HTML "create and initialize a
// Document object": its MIME type and charset, its policy container's CSP list and referrer policy, its declarative
// refresh; and "obtain an opener policy") — nil each it has none of (a content type none where it is empty), the opener
// policy by its name (coop.rs).
pub(crate) fn document_params(ruby: &Ruby, headers: Option<Value>) -> Result<RArray, Error> {
    let fields = ResponseFields::read(headers)?;
    let out = ruby.ary_new_capa(5);
    out.push(fields.content_type.clone().filter(|t| !t.is_empty()))?;
    out.push(fields.csp.clone())?;
    out.push(fields.referrer_policy)?;
    out.push(fields.refresh.clone())?;
    out.push(fields.opener_policy().name())?;
    Ok(out)
}

// Native.location_fields(headers) -> a response's distinct Location fields as they came (`ResponseFields::locations`) —
// none for no header; more than one a network error as a redirect is followed (fetch_chain.rs `follow`).
pub(crate) fn location_fields_for_ruby(ruby: &Ruby, headers: Option<Value>) -> Result<RArray, Error> {
    let out = ruby.ary_new();
    for field in ResponseFields::read(headers)?.locations {
        out.push(field_text(ruby, &field))?;
    }
    Ok(out)
}
// Native.redirect_locations(status, headers) -> the Location fields a navigation follows a response of status `status`
// to (`ResponseFields::redirect_locations`), nil where it follows none.
pub(crate) fn redirect_locations_for_ruby(ruby: &Ruby, status: u32, headers: Option<Value>) -> Result<Option<RArray>, Error> {
    let fields = ResponseFields::read(headers)?;
    let Some(locations) = fields.redirect_locations(status) else { return Ok(None) };
    let out = ruby.ary_new();
    for field in locations {
        out.push(field_text(ruby, field))?;
    }
    Ok(Some(out))
}
// (…a field as the host's Strings have it: a UTF-8 one where its bytes are UTF-8 — a binary String crosses into V8 as
// bytes, not text — else its bytes as they came, a binary String, which the URL parser percent-encodes byte by byte as a
// redirect is followed (Chrome: `/x\xFF` → `/x%FF`); a host that hands such a field to script decodes it first)
fn field_text(ruby: &Ruby, field: &[u8]) -> RString {
    std::str::from_utf8(field).map_or_else(|_| ruby.str_from_slice(field), |s| ruby.str_new(s))
}
