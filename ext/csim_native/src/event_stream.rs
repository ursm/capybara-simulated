// HTML "interpret an event stream" (§9.2.6): a `text/event-stream` body read a line at a time — each ended by CRLF, LF or
// CR — into records a blank line ends, each record with data an event: its type (`event`, else `message`), its data
// lines joined by LF, and the last event ID as it stands (`id`, one with no NUL in it). A comment line, a `retry` and an
// unknown field set nothing here. One reading for the page (a stream a service worker answers — event-source.js) and the
// host (a live connection's chunks, browser.rb), which each had their own.

// A dispatched event: its type, its data, and the last event ID it carries.
#[derive(Debug, PartialEq)]
pub(crate) struct StreamEvent {
    pub(crate) kind: String,
    pub(crate) data: String,
    pub(crate) last_event_id: String,
}

// The events the complete records of `input` dispatch, and how many of its bytes those records took — what follows is
// an unfinished record the next chunk goes on with. `last_id` is the last event ID buffer, as the records before left it
// and as these leave it. At the stream's `end`, a final CR ends its line (it can be followed by no LF); a record no blank
// line ends is still none.
pub(crate) fn interpret(input: &[u8], last_id: &mut String, end: bool) -> (Vec<StreamEvent>, usize) {
    let mut events = Vec::new();
    let mut consumed = 0;
    // (…the record being read: its data, its type and the last event ID as it would leave it)
    let (mut data, mut kind, mut id) = (String::new(), String::new(), last_id.clone());
    let mut at = 0;
    while at < input.len() {
        let Some(len) = input[at..].iter().position(|&b| b == b'\n' || b == b'\r') else { break };
        let line = &input[at..at + len];
        let mut next = at + len + 1;
        if input[at + len] == b'\r' {
            match input.get(next) {
                Some(b'\n') => next += 1,
                Some(_) => {}
                None if end => {}
                // (…a CR that may yet have its LF in the next chunk)
                None => break,
            }
        }
        at = next;
        if line.is_empty() {
            // (…a blank line: the record dispatched, where it has data, and done)
            *last_id = id.clone();
            if !data.is_empty() {
                data.pop();
                let kind = if kind.is_empty() { "message".to_owned() } else { std::mem::take(&mut kind) };
                events.push(StreamEvent { kind, data: std::mem::take(&mut data), last_event_id: id.clone() });
            }
            data.clear();
            kind.clear();
            consumed = at;
            continue;
        }
        if line[0] == b':' {
            continue;
        }
        let (field, value) = match line.iter().position(|&b| b == b':') {
            Some(colon) => {
                let value = &line[colon + 1..];
                (&line[..colon], value.strip_prefix(b" ").unwrap_or(value))
            }
            None => (line, &b""[..]),
        };
        let value = String::from_utf8_lossy(value);
        match field {
            b"event" => kind = value.into_owned(),
            b"data" => {
                data.push_str(&value);
                data.push('\n');
            }
            b"id" if !value.contains('\0') => id = value.into_owned(),
            _ => {}
        }
    }
    (events, consumed)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "eventStream", event_stream_op, context_id);
}
// __dom.eventStream(text) -> [type, data, lastEventId, …]: the events a whole stream's text dispatches.
fn event_stream_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let (events, _) = interpret(text.as_bytes(), &mut String::new(), true);
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(events.len() * 3);
    for e in events {
        for s in [e.kind, e.data, e.last_event_id] {
            items.push(v8::String::new(scope, &s).map_or_else(|| v8::undefined(scope).into(), Into::into));
        }
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// Capybara::Simulated::Native.event_stream(bytes, last_id) -> [[[type, data, lastEventId], …], bytes taken, last_id]:
// a live stream's chunks so far, read (`interpret`).
pub(crate) fn interpret_for_ruby(input: magnus::RString, last_id: String) -> (Vec<(String, String, String)>, usize, String) {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    let bytes = unsafe { input.as_slice() }.to_vec();
    let mut last_id = last_id;
    let (events, consumed) = interpret(&bytes, &mut last_id, false);
    (events.into_iter().map(|e| (e.kind, e.data, e.last_event_id)).collect(), consumed, last_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(input: &str, end: bool) -> (Vec<(String, String, String)>, usize, String) {
        let mut last = String::new();
        let (events, consumed) = interpret(input.as_bytes(), &mut last, end);
        (events.into_iter().map(|e| (e.kind, e.data, e.last_event_id)).collect(), consumed, last)
    }
    fn ev(kind: &str, data: &str, id: &str) -> (String, String, String) {
        (kind.into(), data.into(), id.into())
    }

    #[test]
    fn records_dispatch_as_html_reads_them() {
        // (…any line ending, data lines joined, the id kept for the records after, a type with no data no event)
        let (events, consumed, last) = read("id: 1\rdata: a\r\ndata:b\n\nevent: x\n\ndata: c\n\n: comment\nid: \0\ndata\n\ndata: half", false);
        assert_eq!(events, vec![ev("message", "a\nb", "1"), ev("message", "c", "1"), ev("message", "", "1")]);
        assert_eq!(last, "1");
        assert_eq!(&"id: 1\rdata: a\r\ndata:b\n\nevent: x\n\ndata: c\n\n: comment\nid: \0\ndata\n\ndata: half"[consumed..], "data: half");
        // (…a CR at a chunk's end waits for its LF; at the stream's end it ends the line)
        assert_eq!(read("data: a\r\r", false).0, Vec::new());
        assert_eq!(read("data: a\r\r\n", false).0, vec![ev("message", "a", "")]);
        assert_eq!(read("data: a\n\r", true).0, vec![ev("message", "a", "")]);
    }
}
