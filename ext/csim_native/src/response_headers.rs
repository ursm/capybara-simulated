// The fields of a navigation's response a navigation reads (navigation_fetch.rs `response`) and the document it makes is
// made with (`Native.document_params`), read off the host's header map in one pass: a Rack app's — its names in any case
// (a Rack 2 app's may be mixed-case), a value a String or, Rack 3's form, an Array of fields; several fields of a name a
// Rack 2 app joins with newlines — or a service worker's response's, its fields combined already.

use magnus::{prelude::*, r_hash::ForEach, Error, RArray, RHash, RString, Ruby, Value};

use crate::fetch_rules::ruby_bytes;
use crate::http_cache::combine;

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

// A header value as script reads it: its fields combined (http_cache.rs `combine`), each byte the code point it is.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
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
                bytes.split(|&b| b == b'\n').for_each(|f| add(f.to_vec()));
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
            if bytes.is_empty() {
                Vec::new()
            } else {
                bytes.split(|&b| b == b'\n').map(<[u8]>::to_vec).collect()
            }
        }
    })
}

impl ResponseFields {
    pub(crate) fn read(headers: Option<RHash>) -> Result<Self, Error> {
        let mut out = ResponseFields::default();
        let Some(headers) = headers else { return Ok(out) };
        let (mut location, mut policy, mut disposition, mut coop, mut coep, mut content_type, mut refresh, mut cookie) = (false, false, false, false, false, false, false, false);
        let mut csp: Vec<String> = Vec::new();
        headers.foreach(|k: Value, v: Value| {
            let name = ruby_bytes(k.funcall("to_s", ())?);
            let is = |n: &str| name.eq_ignore_ascii_case(n.as_bytes());
            let text = |v: Value| -> Result<Option<String>, Error> { Ok(combine(v)?.map(|b| latin1(&b))) };
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
                    out.refresh = Some(match RArray::from_value(v) {
                        Some(list) => list.into_iter().map(|f| f.funcall::<_, _, RString>("to_s", ()).map(|s| latin1(&ruby_bytes(s)))).collect::<Result<Vec<_>, _>>()?.join(", "),
                        None => latin1(&ruby_bytes(v.funcall("to_s", ())?)),
                    });
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

    // Whether the response downloads (downloads.rs `is_download`: its Content-Disposition).
    pub(crate) fn downloads(&self) -> bool {
        self.content_disposition.as_deref().is_some_and(crate::downloads::is_download)
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
pub(crate) fn document_params(ruby: &Ruby, headers: Option<RHash>) -> Result<RArray, Error> {
    let fields = ResponseFields::read(headers)?;
    let out = ruby.ary_new_capa(5);
    out.push(fields.content_type.clone().filter(|t| !t.is_empty()))?;
    out.push(fields.csp.clone())?;
    out.push(fields.referrer_policy)?;
    out.push(fields.refresh.clone())?;
    out.push(fields.opener_policy().name())?;
    Ok(out)
}
