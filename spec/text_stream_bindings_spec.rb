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
end
