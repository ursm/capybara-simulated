// A WebSocket connection's frames (RFC 6455 §5), as the client end writes and reads them: each frame it sends masked
// with a fresh key (§5.3), and the server's read back into messages as the bytes come — a fragmented message's
// fragments joined, a control frame between them answered where it falls — and the connection FAILED (§7.1.7) on any
// frame the protocol forbids: a masked one (§5.1: "a client MUST close a connection if it detects a masked frame"), one
// with a reserved bit set where no extension was negotiated (§5.2), a reserved opcode, a control frame longer than 125
// bytes or fragmented (§5.5), a continuation with no message begun or a new message before the last one ended (§5.4), a
// 64-bit length with its top bit set (§5.2), a text message that is no UTF-8 (§8.1), and a Close frame whose body is a
// lone byte, whose code is no code an endpoint may send (§7.4.1-2) or whose reason is no UTF-8 (§5.5.1). Chrome fails
// each of these; Firefox fails all but the Close frame's (a lone byte and code 1005 close it cleanly there) and hands
// the page a masked frame's message before it fails — measured 2026-11-26. The socket and the handshake are the host's
// (browser.rb `run_websocket_reader`), the events the engine's (ws_state.rs).

use std::sync::Mutex;

use rand_core::RngCore as _;

const CONTINUATION: u8 = 0x0;
const TEXT: u8 = 0x1;
const BINARY: u8 = 0x2;
const CLOSE: u8 = 0x8;
const PING: u8 = 0x9;
const PONG: u8 = 0xA;

// What the server's bytes come to, in order.
#[derive(Debug, PartialEq)]
enum Read {
    Text(String),
    Binary(Vec<u8>),
    // Its status code — None for a Close frame of no body (the page sees 1005) — and its reason.
    Close(Option<u16>, String),
    // A Ping, whose payload the client answers with a Pong at once (§5.5.2).
    Ping(Vec<u8>),
    // A frame the protocol forbids: the connection is failed.
    Fail,
}

#[derive(Default)]
struct Reader {
    buffer: Vec<u8>,
    // The message whose fragments are coming: its opcode and its payload so far.
    message: Option<(u8, Vec<u8>)>,
    // Whether the connection is done reading: closed, or failed.
    done: bool,
}

// A status code a Close frame may carry (§7.4.1-2): 1000-1003, 1007-1014 (1012-1014 IANA's since), and 3000-4999 —
// not one reserved for no code (1005), an abnormal closure (1006) or a TLS failure (1015), which no endpoint sends,
// nor one unassigned.
fn sendable_code(code: u16) -> bool {
    matches!(code, 1000..=1003 | 1007..=1014 | 3000..=4999)
}

impl Reader {
    // The server's next `bytes`: what they complete.
    fn feed(&mut self, bytes: &[u8]) -> Vec<Read> {
        let mut out = Vec::new();
        if self.done {
            return out;
        }
        let mut buffer = std::mem::take(&mut self.buffer);
        buffer.extend_from_slice(bytes);
        let mut at = 0;
        while let Some((read, used)) = self.frame(&buffer[at..]) {
            at += used;
            let Some(read) = read else { continue };
            self.done = matches!(read, Read::Close(..) | Read::Fail);
            out.push(read);
            if self.done {
                return out;
            }
        }
        buffer.drain(..at);
        self.buffer = buffer;
        out
    }

    // The frame `bytes` begin with, where they hold all of it: what it completes (None: a fragment, a Pong) and the
    // bytes it took; None where more must come first.
    fn frame(&mut self, bytes: &[u8]) -> Option<(Option<Read>, usize)> {
        let (&b0, &b1) = (bytes.first()?, bytes.get(1)?);
        let (fin, reserved, opcode) = (b0 & 0x80 != 0, b0 & 0x70, b0 & 0x0f);
        let fail = Some((Some(Read::Fail), bytes.len()));
        if reserved != 0 || b1 & 0x80 != 0 || !matches!(opcode, CONTINUATION | TEXT | BINARY | CLOSE | PING | PONG) {
            return fail;
        }
        let (len, head): (u64, usize) = match b1 & 0x7f {
            126 => (u64::from(u16::from_be_bytes(bytes.get(2..4)?.try_into().ok()?)), 4),
            127 => (u64::from_be_bytes(bytes.get(2..10)?.try_into().ok()?), 10),
            n => (u64::from(n), 2),
        };
        if len >> 63 != 0 || (opcode >= CLOSE && (len > 125 || !fin)) {
            return fail;
        }
        let end = head.checked_add(usize::try_from(len).ok()?)?;
        let payload = bytes.get(head..end)?;
        let read = match opcode {
            CLOSE => Some(close(payload)),
            PING => Some(Read::Ping(payload.to_vec())),
            PONG => None,
            CONTINUATION => match self.message.as_mut() {
                None => Some(Read::Fail),
                Some((_, data)) => {
                    data.extend_from_slice(payload);
                    if fin { self.message.take().map(|(op, data)| message(op, data)) } else { None }
                }
            },
            _ if self.message.is_some() => Some(Read::Fail),
            _ if fin => Some(message(opcode, payload.to_vec())),
            _ => {
                self.message = Some((opcode, payload.to_vec()));
                None
            }
        };
        Some((read, end))
    }
}

// A whole message of `opcode`: a text one's UTF-8 (none fails the connection), a binary one's bytes.
fn message(opcode: u8, data: Vec<u8>) -> Read {
    match opcode {
        TEXT => String::from_utf8(data).map_or(Read::Fail, Read::Text),
        _ => Read::Binary(data),
    }
}
// A Close frame's body: none, or a sendable code and a UTF-8 reason.
fn close(body: &[u8]) -> Read {
    match body {
        [] => Read::Close(None, String::new()),
        [_] => Read::Fail,
        [hi, lo, reason @ ..] => {
            let code = u16::from_be_bytes([*hi, *lo]);
            match std::str::from_utf8(reason) {
                Ok(reason) if sendable_code(code) => Read::Close(Some(code), reason.to_owned()),
                _ => Read::Fail,
            }
        }
    }
}

// A frame the client sends: final, of `opcode`, its payload masked with a key of its own (§5.3).
fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(0x80 | opcode);
    match payload.len() {
        n @ 0..=125 => out.push(0x80 | n as u8),
        n @ 126..=0xffff => {
            out.push(0x80 | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(0x80 | 127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    let mut key = [0u8; 4];
    rand_core::OsRng.fill_bytes(&mut key);
    out.extend_from_slice(&key);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i & 3]));
    out
}

// Capybara::Simulated::Native.ws_frame(opcode, payload) -> the bytes of the frame the client sends (`frame`).
pub(crate) fn frame_for_ruby(ruby: &magnus::Ruby, opcode: u8, payload: magnus::RString) -> magnus::RString {
    // SAFETY: read at once, before anything could run Ruby code that moves or frees it.
    let bytes = frame(opcode, unsafe { payload.as_slice() });
    ruby.str_from_slice(&bytes)
}

// Capybara::Simulated::Native::WsReader: a connection's `Reader`, fed from its reader thread.
#[magnus::wrap(class = "Capybara::Simulated::Native::WsReader", free_immediately)]
struct WsReader(Mutex<Reader>);

// The kinds `#feed` answers with.
const KIND_TEXT: i64 = 1;
const KIND_BINARY: i64 = 2;
const KIND_CLOSE: i64 = 8;
const KIND_PING: i64 = 9;
const KIND_FAIL: i64 = -1;

impl WsReader {
    fn new() -> Self {
        WsReader(Mutex::new(Reader::default()))
    }
    // #feed(bytes) -> [[kind, payload, code], …]: what the server's next bytes complete (`Reader::feed`) — a text
    // message's text (UTF-8), a binary one's or a Ping's bytes, a Close's reason (UTF-8) and code (nil for none), or a
    // failure — none past a Close or a failure.
    fn feed(ruby: &magnus::Ruby, rb_self: &Self, bytes: magnus::RString) -> Result<magnus::RArray, magnus::Error> {
        // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
        let bytes = unsafe { bytes.as_slice() }.to_vec();
        let reads = rb_self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).feed(&bytes);
        let out = ruby.ary_new_capa(reads.len());
        for read in reads {
            let (kind, payload, code) = match read {
                Read::Text(text) => (KIND_TEXT, ruby.str_new(&text), None),
                Read::Binary(data) => (KIND_BINARY, ruby.str_from_slice(&data), None),
                Read::Close(code, reason) => (KIND_CLOSE, ruby.str_new(&reason), code),
                Read::Ping(data) => (KIND_PING, ruby.str_from_slice(&data), None),
                Read::Fail => (KIND_FAIL, ruby.str_new(""), None),
            };
            out.push((kind, payload, code))?;
        }
        Ok(out)
    }
}

pub(crate) fn define(native: magnus::RModule, ruby: &magnus::Ruby) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    native.define_module_function("ws_frame", function!(frame_for_ruby, 2))?;
    let class = native.define_class("WsReader", ruby.class_object())?;
    class.const_set("TEXT", KIND_TEXT)?;
    class.const_set("BINARY", KIND_BINARY)?;
    class.const_set("CLOSE", KIND_CLOSE)?;
    class.const_set("PING", KIND_PING)?;
    class.const_set("FAIL", KIND_FAIL)?;
    class.define_singleton_method("new", function!(WsReader::new, 0))?;
    class.define_method("feed", method!(WsReader::feed, 1))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A server's frame: unmasked unless `mask`.
    fn server(b0: u8, payload: &[u8], mask: Option<[u8; 4]>) -> Vec<u8> {
        let mut out = vec![b0];
        let m = if mask.is_some() { 0x80 } else { 0 };
        match payload.len() {
            n @ 0..=125 => out.push(m | n as u8),
            n @ 126..=0xffff => {
                out.push(m | 126);
                out.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                out.push(m | 127);
                out.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        match mask {
            Some(key) => {
                out.extend_from_slice(&key);
                out.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i & 3]));
            }
            None => out.extend_from_slice(payload),
        }
        out
    }
    fn read(bytes: &[u8]) -> Vec<Read> {
        Reader::default().feed(bytes)
    }

    #[test]
    fn a_frame_the_client_sends_is_masked_and_reads_back() {
        for len in [0usize, 5, 125, 126, 65535, 65536] {
            let payload: Vec<u8> = (0..len).map(|i| i as u8).collect();
            let f = frame(BINARY, &payload);
            assert_eq!(f[0], 0x80 | BINARY);
            assert_ne!(f[1] & 0x80, 0);
            let head = match len { 0..=125 => 2, 126..=0xffff => 4, _ => 10 };
            let key: [u8; 4] = f[head..head + 4].try_into().unwrap();
            let unmasked: Vec<u8> = f[head + 4..].iter().enumerate().map(|(i, b)| b ^ key[i & 3]).collect();
            assert_eq!(unmasked, payload);
        }
    }

    #[test]
    fn messages_come_whole_whatever_the_bytes_are_split_into() {
        let mut bytes = server(0x01, b"he", None);
        bytes.extend(server(0x89, b"p", None));
        bytes.extend(server(0x80, "llo é".as_bytes(), None));
        bytes.extend(server(0x82, &[0, 255], None));
        bytes.extend(server(0x8A, b"", None));
        bytes.extend(server(0x88, &[3, 232, b'b', b'y', b'e'], None));
        let mut reader = Reader::default();
        let reads: Vec<Read> = bytes.chunks(3).flat_map(|c| reader.feed(c)).collect();
        assert_eq!(
            reads,
            vec![Read::Ping(b"p".to_vec()), Read::Text("hello é".into()), Read::Binary(vec![0, 255]), Read::Close(Some(1000), "bye".into())]
        );
        // (…nothing read past a Close)
        assert_eq!(reader.feed(&server(0x81, b"x", None)), vec![]);
    }

    #[test]
    fn a_long_message_reads_by_its_extended_length() {
        let text = "x".repeat(70_000);
        assert_eq!(read(&server(0x81, text.as_bytes(), None)), vec![Read::Text(text)]);
        assert_eq!(read(&server(0x82, &[7; 300], None)), vec![Read::Binary(vec![7; 300])]);
    }

    #[test]
    fn a_frame_the_protocol_forbids_fails_the_connection() {
        assert_eq!(read(&server(0x81, b"hi", Some(*b"abcd"))), vec![Read::Fail]);
        assert_eq!(read(&server(0xC1, b"hi", None)), vec![Read::Fail]);
        assert_eq!(read(&server(0x83, b"", None)), vec![Read::Fail]);
        assert_eq!(read(&server(0x89, &[b'x'; 126], None)), vec![Read::Fail]);
        assert_eq!(read(&server(0x09, b"p", None)), vec![Read::Fail]);
        assert_eq!(read(&server(0x80, b"x", None)), vec![Read::Fail]);
        let mut midway = server(0x01, b"a", None);
        midway.extend(server(0x81, b"b", None));
        assert_eq!(read(&midway), vec![Read::Fail]);
        assert_eq!(read(&server(0x81, b"a\xffb", None)), vec![Read::Fail]);
        assert_eq!(read(&[0x82, 127, 0x80, 0, 0, 0, 0, 0, 0, 1]), vec![Read::Fail]);
    }

    #[test]
    fn a_close_frame_carries_a_sendable_code_and_a_utf8_reason() {
        assert_eq!(read(&server(0x88, b"", None)), vec![Read::Close(None, String::new())]);
        assert_eq!(read(&server(0x88, &[0x0f, 0xa0], None)), vec![Read::Close(Some(4000), String::new())]);
        assert_eq!(read(&server(0x88, b"x", None)), vec![Read::Fail]);
        for code in [999u16, 1004, 1005, 1006, 1015, 2999, 5000] {
            assert_eq!(read(&server(0x88, &code.to_be_bytes(), None)), vec![Read::Fail], "{code}");
        }
        assert_eq!(read(&server(0x88, &[3, 232, 0xff], None)), vec![Read::Fail]);
    }
}
