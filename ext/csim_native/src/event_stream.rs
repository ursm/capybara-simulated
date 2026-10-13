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

// A stream as it is read: the line it is in the middle of, whether an LF next only ends the CR before it, the record's
// data and type, the last event ID buffer, and whether its first line (which a BOM may open) is still to come. Each byte
// is read once, whichever chunk brings it.
#[derive(Default)]
pub(crate) struct Parser {
    line: Vec<u8>,
    after_cr: bool,
    data: String,
    kind: String,
    last_id: String,
    later_lines: bool,
}

impl Parser {
    // The events the bytes that came next dispatch.
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        for &b in bytes {
            if std::mem::take(&mut self.after_cr) && b == b'\n' {
                continue;
            }
            match b {
                b'\n' => self.end_line(&mut events),
                b'\r' => {
                    self.end_line(&mut events);
                    self.after_cr = true;
                }
                _ => self.line.push(b),
            }
        }
        events
    }
    fn end_line(&mut self, events: &mut Vec<StreamEvent>) {
        let mut line = std::mem::take(&mut self.line);
        // (…a UTF-8 BOM opening the stream no part of it: its decoding takes it)
        if !std::mem::replace(&mut self.later_lines, true) && line.starts_with(b"\xEF\xBB\xBF") {
            line.drain(..3);
        }
        if line.is_empty() {
            // (…a blank line: the record dispatched, where it has data, and done)
            if !self.data.is_empty() {
                self.data.pop();
                let kind = if self.kind.is_empty() { "message".to_owned() } else { std::mem::take(&mut self.kind) };
                events.push(StreamEvent { kind, data: std::mem::take(&mut self.data), last_event_id: self.last_id.clone() });
            }
            self.data.clear();
            self.kind.clear();
            return;
        }
        if line[0] == b':' {
            return;
        }
        let (field, value) = match line.iter().position(|&b| b == b':') {
            Some(colon) => {
                let value = &line[colon + 1..];
                (&line[..colon], value.strip_prefix(b" ").unwrap_or(value))
            }
            None => (&line[..], &b""[..]),
        };
        let value = String::from_utf8_lossy(value);
        match field {
            b"event" => self.kind = value.into_owned(),
            b"data" => {
                self.data.push_str(&value);
                self.data.push('\n');
            }
            b"id" if !value.contains('\0') => self.last_id = value.into_owned(),
            _ => {}
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "eventStream", event_stream_op, context_id);
}
// __dom.eventStream(text) -> [type, data, lastEventId, …]: the events a whole stream's text dispatches.
fn event_stream_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    // (…the text already decoded, which took its BOM: a second is a character of its first line)
    let events = Parser { later_lines: true, ..Parser::default() }.feed(text.as_bytes());
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(events.len() * 3);
    for e in events {
        for s in [e.kind, e.data, e.last_event_id] {
            items.push(v8::String::new(scope, &s).map_or_else(|| v8::undefined(scope).into(), Into::into));
        }
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// A live stream's parsers, the host's, by the number it reads each by.
static PARSERS: std::sync::LazyLock<std::sync::Mutex<(u64, std::collections::HashMap<u64, Parser>)>> = std::sync::LazyLock::new(Default::default);
fn parsers() -> std::sync::MutexGuard<'static, (u64, std::collections::HashMap<u64, Parser>)> {
    PARSERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
// Capybara::Simulated::Native.event_stream_open -> a new stream's parser's number.
pub(crate) fn open_for_ruby() -> u64 {
    let mut p = parsers();
    p.0 += 1;
    let id = p.0;
    p.1.insert(id, Parser::default());
    id
}
// Capybara::Simulated::Native.event_stream_feed(parser, bytes) -> [[type, data, lastEventId], …]: the events the stream's
// next bytes dispatch.
pub(crate) fn feed_for_ruby(id: u64, bytes: magnus::RString) -> Vec<(String, String, String)> {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    let bytes = unsafe { bytes.as_slice() }.to_vec();
    let events = parsers().1.get_mut(&id).map(|p| p.feed(&bytes)).unwrap_or_default();
    events.into_iter().map(|e| (e.kind, e.data, e.last_event_id)).collect()
}
// Capybara::Simulated::Native.event_stream_close(parser): the stream is done with.
pub(crate) fn close_for_ruby(id: u64) {
    parsers().1.remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(chunks: &[&str]) -> Vec<(String, String, String)> {
        let mut p = Parser::default();
        chunks.iter().flat_map(|c| p.feed(c.as_bytes())).map(|e| (e.kind, e.data, e.last_event_id)).collect()
    }
    fn ev(kind: &str, data: &str, id: &str) -> (String, String, String) {
        (kind.into(), data.into(), id.into())
    }

    #[test]
    fn records_dispatch_as_html_reads_them() {
        // (…any line ending, data lines joined, the id kept for the records after, a type with no data no event)
        assert_eq!(
            read(&["\u{feff}id: 1\rdata: a\r\ndata:b\n\nevent: x\n\ndata: c\n\n: comment\nid: \0\ndata\n\ndata: half"]),
            vec![ev("message", "a\nb", "1"), ev("message", "c", "1"), ev("message", "", "1")]
        );
        // (…a CR ends its line at once, the LF after it — in the next chunk too — ending nothing more)
        assert_eq!(read(&["data: a\r\r"]), vec![ev("message", "a", "")]);
        assert_eq!(read(&["data: a\r", "\ndata: b\r", "\n\r\n"]), vec![ev("message", "a\nb", "")]);
        // (…a BOM split across chunks, a line across chunks)
        let mut p = Parser::default();
        assert!(p.feed(&[0xEF]).is_empty());
        let events = p.feed(b"\xBB\xBFdata: x\n\n");
        assert_eq!(events, vec![StreamEvent { kind: "message".into(), data: "x".into(), last_event_id: String::new() }]);
    }
}
