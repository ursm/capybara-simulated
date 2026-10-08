# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Clipboard, ClipboardItem and ScreenOrientation, generated from their IDL. The figures are headless Chrome's, but where
# the spec decides: a ClipboardItem's key is a MIME type (Chrome takes "bogus"), its options' presentationStyle an
# enumeration ("unspecified" by default; Chrome has no attribute), its types the same frozen array each time; supports()
# knows the optional text/uri-list this clipboard holds (Chrome: false); readText() of a clipboard with no text is a
# NotFoundError; write() refuses a type no page may write.
RSpec.describe 'Clipboard bindings' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const item = new ClipboardItem({'text/plain': 'a', 'image/png': new Blob(['x'])});
        return [
          error(() => new ClipboardItem()),
          error(() => new ClipboardItem({})),
          error(() => new ClipboardItem({'bogus': 'a'})),
          error(() => new ClipboardItem({'text/plain': 'a'}, {presentationStyle: 'x'})),
          [item.types, item.types === item.types, Object.isFrozen(item.types), item.presentationStyle],
          ['text/plain', 'text/html', 'image/png', 'image/jpeg', 'web text/custom', 'web bogus', 'text/uri-list', 'image/svg+xml'].map((t) => ClipboardItem.supports(t)),
          error(() => new Clipboard()),
          [Object.prototype.toString.call(navigator.clipboard), navigator.clipboard === navigator.clipboard, navigator.clipboard instanceof EventTarget],
          error(() => new ScreenOrientation()),
          [screen.orientation.type, screen.orientation.angle, screen.orientation === screen.orientation, Object.getOwnPropertyNames(ScreenOrientation.prototype).sort()]
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'ClipboardItem': 1 argument required, but only 0 present.",
      "TypeError: Failed to construct 'ClipboardItem': Empty dictionary argument",
      "TypeError: Failed to construct 'ClipboardItem': Invalid MIME type 'bogus'.",
      "TypeError: Failed to construct 'ClipboardItem': Failed to read the 'presentationStyle' property from 'ClipboardItemOptions': The provided value 'x' is not a valid enum value of type PresentationStyle.",
      [['text/plain', 'image/png'], true, true, 'unspecified'],
      [true, true, true, false, true, false, true, true],
      "TypeError: Failed to construct 'Clipboard': Illegal constructor",
      ['[object Clipboard]', true, true],
      "TypeError: Failed to construct 'ScreenOrientation': Illegal constructor",
      ['landscape-primary', 0, true, %w[angle constructor lock onchange type unlock]]
    ])
  end

  it 'reads and writes the clipboard as the spec says' do
    session.execute_script(<<~JS)
      window.got = [];
      const settle = (p) => p.then((v) => v, (e) => e.name + ': ' + e.message);
      (async () => {
        const item = new ClipboardItem({'text/plain': 'a'});
        const blob = await item.getType('text/plain');
        got.push([blob instanceof Blob, blob.type, await blob.text()]);
        got.push(await settle(item.getType('text/html')));
        got.push(await settle(new ClipboardItem({'text/plain': new Blob(['a'], {type: 'text/html'})}).getType('text/plain').then((b) => b.type)));
        got.push(await settle(navigator.clipboard.write([{}])));
        got.push(await settle(navigator.clipboard.writeText()));
        got.push(await settle(screen.orientation.lock('x')));
        got.push(await settle(screen.orientation.lock('portrait')));
        await navigator.clipboard.writeText('héllo');
        got.push(await navigator.clipboard.readText());
        const [read] = await navigator.clipboard.read();
        got.push(read.types);
        await navigator.clipboard.write([new ClipboardItem({'text/html': '<b>x</b>', 'text/plain': 'x'})]);
        got.push(await settle(read.getType('text/plain')));
        got.push((await navigator.clipboard.read())[0].types);
        got.push(await settle(navigator.clipboard.write([new ClipboardItem({'application/zip': new Blob(['z'], {type: 'application/zip'})})])));
        await navigator.clipboard.write([new ClipboardItem({'image/png': new Blob(['p'], {type: 'image/png'})})]);
        got.push(await settle(navigator.clipboard.readText()));
        got.push('done');
      })();
    JS
    expect(poll_until { session.evaluate_script("window.got.at(-1) === 'done' && window.got") }).to eq([
      [true, 'text/plain', 'a'],
      "NotFoundError: Failed to execute 'getType' on 'ClipboardItem': The type was not found",
      'text/html',
      "TypeError: Failed to execute 'write' on 'Clipboard': parameter 1 is not of type 'ClipboardItem'.",
      "TypeError: Failed to execute 'writeText' on 'Clipboard': 1 argument required, but only 0 present.",
      "TypeError: Failed to execute 'lock' on 'ScreenOrientation': The provided value 'x' is not a valid enum value of type OrientationLockType.",
      'NotSupportedError: screen.orientation.lock() is not available on this device.',
      'héllo',
      ['text/plain'],
      "InvalidStateError: Failed to execute 'getType' on 'ClipboardItem': The clipboard has changed since it was read.",
      ['text/html', 'text/plain'],
      "NotAllowedError: Failed to execute 'write' on 'Clipboard': Type application/zip not supported on write.",
      "NotFoundError: Failed to execute 'readText' on 'Clipboard': No text in the clipboard.",
      'done'
    ])
  end
end
