require 'capybara/simulated'
require_relative 'support/session_teardown'

# FileReader as the File API reads: no loadend for a read a handler of load replaced by another, progress events of the
# bytes read of the blob's, readAsText's encoding the label's — else the blob type's charset, else UTF-8 — a BOM
# overriding it; and the request bodies an object merely claiming a class is none of.
RSpec.describe 'FileReader' do
  let(:app) {
    lambda do |env|
      if env['REQUEST_METHOD'] == 'POST'
        [200, {'content-type' => 'text/plain'}, ["#{env['CONTENT_TYPE'].to_s.split(';').first}|#{env['rack.input'].read}"]]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x']]
      end
    end
  }
  let(:session) { simulated_session(app) }

  it 'reads as the File API says' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], log = [], r = new FileReader();
      let again = true;
      for (const t of ['loadstart', 'progress', 'load', 'loadend']) {
        r.addEventListener(t, (e) => {
          log.push(`${t}:${e.loaded}/${e.total}:${e.lengthComputable}`);
          if (t === 'load' && again) { again = false; r.readAsText(new Blob(['xy'])); }
        });
      }
      r.readAsText(new Blob(['abc']));
      const text = (blob, label) => new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsText(blob, label); });
      setTimeout(async () => {
        const decoded = [
          await text(new Blob([new Uint8Array([0xEF, 0xBB, 0xBF, 0x61])]), 'utf-16le'),
          await text(new Blob([new Uint8Array([0x82, 0xA0])], { type: 'text/plain;charset=shift_jis' }), 'bogus'),
          await text(new Blob(['ab']), 'iso-2022-kr')
        ];
        const post = (body) => new Promise((res) => { const x = new XMLHttpRequest(); x.open('POST', '/'); x.onload = () => res(x.responseText); x.send(body); });
        const bodies = [await post({ [Symbol.toStringTag]: 'ArrayBuffer' }),
                        (await fetch('/', { method: 'POST', body: document }).then((x) => x.text())).split(' ')[0]];
        done([log, decoded, bodies]);
      }, 50);
    JS
    expect(got).to eq([
      ['loadstart:0/3:true', 'progress:3/3:true', 'load:3/3:true', 'loadstart:0/2:true', 'progress:2/2:true', 'load:2/2:true', 'loadend:2/2:true'],
      ['a', 'あ', "�"],
      ['text/plain|[object ArrayBuffer]', 'text/plain|[object']
    ])
  end
end
