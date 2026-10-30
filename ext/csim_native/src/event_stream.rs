// HTML "interpret an event stream" (§9.2.6): a `text/event-stream` body read a line at a time — each ended by CRLF, LF or
// CR — into records a blank line ends, each record with data an event: its type (`event`, else `message`), its data
// lines joined by LF, and the last event ID as it stands (`id`, one with no NUL in it). A `retry` of ASCII digits sets
// the reconnection time; a comment line and an unknown field set nothing. What a reconnection asks with — the last event
// ID string as the last blank line set it, and the reconnection time — is kept beside the records (`reconnection`).
// A reconnection's stream starts from the last event ID its source had (`resumed`): HTML associates the buffer with "a
// stream" and leaves open whether a reconnection starts another; WPT's format-field-id, Chrome and Firefox keep it,
// so a message the new stream gives no id is of the old one's. One reading for the page (a stream a service worker answers — event-source.js) and the
// host (a live connection's chunks, browser.rb), which each had their own.

// A dispatched event: its type, its data, and the last event ID it carries.
#[derive(Debug, PartialEq)]
pub(crate) struct StreamEvent {
    pub(crate) kind: String,
    pub(crate) data: String,
    pub(crate) last_event_id: String,
}

// A stream as it is read: the line it is in the middle of, whether an LF next only ends the CR before it, the record's
// data and type, the last event ID buffer, whether its first line (which a BOM may open) is still to come, and what a
// reconnection asks with — the source's last event ID string, which each blank line sets from the buffer, and the
// reconnection time a `retry` field set. Each byte is read once, whichever chunk brings it.
#[derive(Default)]
pub(crate) struct Parser {
    line: Vec<u8>,
    after_cr: bool,
    data: String,
    kind: String,
    last_id: String,
    later_lines: bool,
    dispatched_id: String,
    retry: Option<u64>,
}

impl Parser {
    // A stream of a source whose last event ID string is `last_event_id` — a reconnection's (none for the first).
    pub(crate) fn resumed(last_event_id: String) -> Self {
        Parser { dispatched_id: last_event_id.clone(), last_id: last_event_id, ..Parser::default() }
    }
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
            // (…a blank line: the source's last event ID string set from the buffer — whether or not the record has
            // data — and the record dispatched, where it has, and done)
            self.dispatched_id.clone_from(&self.last_id);
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
            // (…a value of ASCII digits alone, in base ten — one too large for any clock the longest)
            b"retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => self.retry = Some(value.parse().unwrap_or(u64::MAX)),
            _ => {}
        }
    }
    // What the stream leaves a reconnection to ask with: the source's last event ID string, and the reconnection time
    // its `retry` set, if any.
    pub(crate) fn reconnection(&self) -> (String, Option<u64>) {
        (self.dispatched_id.clone(), self.retry)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "eventStream", event_stream_op, context_id);
}
// __dom.eventStream(text, lastEventId) -> [type, data, lastEventId, …, lastEventIdString, retry]: the events a whole
// stream's text dispatches, of a source whose last event ID string is `lastEventId` (`resumed`), and what a
// reconnection after it asks with (`reconnection`; the retry -1 where none set one).
fn event_stream_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let last_event_id = if args.get(1).is_string() { args.get(1).to_rust_string_lossy(scope) } else { String::new() };
    // (…the text already decoded, which took its BOM: a second is a character of its first line)
    let mut parser = Parser { later_lines: true, ..Parser::resumed(last_event_id) };
    let events = parser.feed(text.as_bytes());
    let (last_id, retry) = parser.reconnection();
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(events.len() * 3 + 2);
    for s in events.into_iter().flat_map(|e| [e.kind, e.data, e.last_event_id]).chain([last_id]) {
        items.push(v8::String::new(scope, &s).map_or_else(|| v8::undefined(scope).into(), Into::into));
    }
    items.push(v8::Number::new(scope, retry.map_or(-1.0, |r| r as f64)).into());
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// A live stream's parsers, the host's, by the number it reads each by.
static PARSERS: std::sync::LazyLock<std::sync::Mutex<(u64, std::collections::HashMap<u64, Parser>)>> = std::sync::LazyLock::new(Default::default);
fn parsers() -> std::sync::MutexGuard<'static, (u64, std::collections::HashMap<u64, Parser>)> {
    PARSERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
// Capybara::Simulated::Native.event_stream_open(last_event_id) -> a new stream's parser's number, of a source whose last
// event ID string is `last_event_id` (`resumed`).
pub(crate) fn open_for_ruby(last_event_id: String) -> u64 {
    let mut p = parsers();
    p.0 += 1;
    let id = p.0;
    p.1.insert(id, Parser::resumed(last_event_id));
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
// Capybara::Simulated::Native.event_stream_reconnection(parser) -> [lastEventIdString, retry or nil]: what a reconnection
// after the stream asks with (`reconnection`).
pub(crate) fn reconnection_for_ruby(id: u64) -> (String, Option<u64>) {
    parsers().1.get(&id).map(Parser::reconnection).unwrap_or_default()
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

    #[test]
    fn a_reconnection_asks_with_what_the_blank_lines_and_retry_left() {
        // (…an id a blank line has not yet dispatched not the source's; a blank line with no data dispatches it; a bogus
        // or empty retry ignored, a digits one kept)
        let mut p = Parser::default();
        p.feed(b"id: 1\ndata: a\n\nretry: 3000\nretry: 10x\nretry\nid: 2\n");
        assert_eq!(p.reconnection(), ("1".to_owned(), Some(3000)));
        p.feed(b"\n");
        assert_eq!(p.reconnection(), ("2".to_owned(), Some(3000)));
        p.feed(b"retry: 99999999999999999999999\n");
        assert_eq!(p.reconnection(), ("2".to_owned(), Some(u64::MAX)));
        // (…a reconnection's stream of its source's last event ID, until an id of its own replaces it)
        let mut p = Parser::resumed("2".to_owned());
        let ids: Vec<String> = p.feed(b"data: a\n\nid\ndata: b\n\n").into_iter().map(|e| e.last_event_id).collect();
        assert_eq!(ids, ["2", ""]);
    }
}
