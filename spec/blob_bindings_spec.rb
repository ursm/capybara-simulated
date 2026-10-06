require 'capybara/simulated'
require_relative 'support/session_teardown'

# Blob and File as their IDL makes them: their state their own — no own property shows it, none a page writes changes
# it — any realm's a blob to the structured clone, to a worker and to a slice, and a picked file read and sliced as one.
RSpec.describe 'Blob and File bindings' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/echo.js'
        [200, {'content-type' => 'text/javascript'}, ['onmessage = async (e) => postMessage([e.data.name, await e.data.text()]);']]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x<iframe srcdoc="y"></iframe>']]
      end
    end
  }
  let(:session) { simulated_session(app) }

  it 'keeps its state its own, and is any realm’s blob' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], f = new File(['héllo'], 'a.txt', { type: 'TEXT/Plain', lastModified: 7 });
      f.name = 'b';
      const shape = [Object.getOwnPropertyNames(f), f.name, f.size, f.type, f.lastModified, Object.prototype.toString.call(f),
                     (() => { try { return Object.create(Blob.prototype).size; } catch (e) { return e.name; } })()];
      const fb = new frames[0].Blob(['frame']);
      const clone = structuredClone(fb);
      const sliced = Blob.prototype.slice.call(fb, 1, 3);
      const w = new Worker('/echo.js');
      w.onmessage = async (e) => done([shape, clone instanceof Blob, await clone.text(), sliced instanceof frames[0].Blob,
                                       await sliced.text(), e.data]);
      w.postMessage(new frames[0].File(['frm'], 'fr.txt'));
    JS
    expect(got).to eq([[[], 'a.txt', 6, 'text/plain', 7, '[object File]', 'TypeError'], true, 'frame', true, 'ra', ['fr.txt', 'frm']])
  end

  it 'takes any realm’s blob wherever one is taken, and refuses what is none' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const F = frames[0], fb = new F.Blob(['fb']), fd = new FormData();
        fd.append('a', fb, 'named');
        fd.append('b', new F.File(['ff'], 'f.txt'));
        const swapped = new F.Blob(['sw']);
        Object.setPrototypeOf(swapped, Blob.prototype);
        const buf = new ArrayBuffer(4), view = new Uint8Array(buf);
        structuredClone(buf, { transfer: [buf] });
        const thrown = (f) => { try { f(); return 'ok'; } catch (e) { return e.name; } };
        return [
          [fd.get('a') instanceof File, fd.get('a').name, fd.get('b').name],
          new File([], 'n', { lastModified: -1 }).lastModified, new File([], 'n', { lastModified: -86400000 }).lastModified,
          Object.prototype.toString.call(structuredClone(Object.create(Blob.prototype))),
          Object.prototype.toString.call(structuredClone({ [Symbol.toStringTag]: 'Blob' })),
          [swapped.slice(0, 1) instanceof F.Blob, swapped.slice(0, 1) instanceof Blob],
          [new Blob([buf]).size, new Blob([view]).size],
          thrown(() => URL.createObjectURL({})), thrown(() => new FileReader().readAsText({}))
        ];
      })()
    JS
    expect(got).to eq([
      [true, 'named', 'f.txt'], -1, -86_400_000, '[object Object]', '[object Object]', [true, false], [0, 0], 'TypeError', 'TypeError'
    ])
  end
end
