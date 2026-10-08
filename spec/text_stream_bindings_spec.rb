# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# TextDecoderStream and TextEncoderStream, generated from their IDL: their state in internal slots, a TransformStream
# among it, and the Encoding Standard's chunk steps.
RSpec.describe 'Text stream bindings' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']] })
    s.visit('/')
    s
  }

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const getter = (iface, name) => Object.getOwnPropertyDescriptor(iface.prototype, name).get;
        const decoder = new TextDecoderStream('Latin1', {fatal: true});
        return [
          [decoder.encoding, decoder.fatal, decoder.ignoreBOM, new TextEncoderStream().encoding],
          [Object.prototype.toString.call(decoder), Object.prototype.toString.call(new TextEncoderStream())],
          decoder.readable === decoder.readable && decoder.readable instanceof ReadableStream,
          Object.keys(decoder),
          error(() => new TextDecoderStream('replacement')),
          error(() => getter(TextDecoderStream, 'readable').call({})),
          error(() => getter(TextEncoderStream, 'writable').call(decoder)),
          error(() => TextDecoderStream())
        ];
      })()
    JS
    expect(got).to eq([
      ['windows-1252', true, false, 'utf-8'],
      ['[object TextDecoderStream]', '[object TextEncoderStream]'],
      true,
      [],
      'RangeError',
      'TypeError',
      'TypeError',
      'TypeError'
    ])
  end

  it 'encodes a surrogate pair split across chunks as one code point, a lone one as U+FFFD' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      (async () => {
        const encode = async (chunks) => {
          const stream = new TextEncoderStream(), writer = stream.writable.getWriter(), reader = stream.readable.getReader();
          chunks.forEach((c) => writer.write(c));
          writer.close();
          const out = [];
          for (let r = await reader.read(); !r.done; r = await reader.read()) out.push([...r.value]);
          return out;
        };
        // (…a write the transform takes only as the readable side is read: the backpressure of its empty queue)
        const reject = (chunk) => {
          const stream = new TextEncoderStream();
          stream.readable.getReader().read().catch(() => {});
          return stream.writable.getWriter().write(chunk).then(() => 'none', (e) => e.name);
        };
        return [await encode(['\\uD83D', '\\uDE00']), await encode(['a\\uD83D']), await encode(['\\uDE00', '']), await reject(Symbol())];
      })().then(done);
    JS
    expect(got).to eq([
      [[0xF0, 0x9F, 0x98, 0x80]],
      [[0x61], [0xEF, 0xBF, 0xBD]],
      [[0xEF, 0xBF, 0xBD]],
      'TypeError'
    ])
  end

  # The decoder across chunks: a BOM split between two stripped (a second one kept), a fatal error mid-chunk erroring the
  # stream with none of that chunk's text enqueued, one at the flush after the text before it, a non-fatal one U+FFFD at
  # the flush, a chunk that is no AllowSharedBufferSource refused.
  it 'decodes across chunks as TextDecoder does' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      (async () => {
        const decode = async (chunks, options) => {
          const stream = new TextDecoderStream('utf-8', options), writer = stream.writable.getWriter();
          const reader = stream.readable.getReader();
          chunks.forEach((c) => writer.write(c).catch(() => {}));
          writer.close().catch(() => {});
          let text = '';
          try {
            for (let r = await reader.read(); !r.done; r = await reader.read()) text += r.value;
          } catch (e) { return text + '|' + e.name; }
          return text;
        };
        const bytes = (...b) => new Uint8Array(b);
        return [
          await decode([bytes(0xEF, 0xBB), bytes(0xBF, 0x41, 0xEF, 0xBB, 0xBF)]),
          await decode([bytes(0x41, 0xFF)], {fatal: true}),
          await decode([bytes(0x41, 0xE2, 0x82)], {fatal: true}),
          await decode([bytes(0x41, 0xE2, 0x82)]),
          await decode([undefined]),
          await decode([new Uint8Array(new ArrayBuffer(2, {maxByteLength: 4}))])
        ];
      })().then(done);
    JS
    expect(got).to eq(["A\uFEFF", '|TypeError', 'A|TypeError', "A\uFFFD", '|TypeError', '|TypeError'])
  end

  # The TransformStream they set up has a transformer and strategies of the platform's own: a page's accessors on
  # Object.prototype reach neither constructor (Chrome: both construct).
  it "is set up whatever a page puts on Object.prototype" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const names = ['transform', 'start', 'cancel', 'readableType', 'writableType', 'highWaterMark', 'size'];
        for (const name of names) Object.defineProperty(Object.prototype, name, {get() { throw new Error(name); }, configurable: true});
        try {
          return [typeof new TextDecoderStream().readable, typeof new TextEncoderStream().writable];
        } catch (e) { return e.message; }
        finally { for (const name of names) delete Object.prototype[name]; }
      })()
    JS
    expect(got).to eq(%w[object object])
  end
end
