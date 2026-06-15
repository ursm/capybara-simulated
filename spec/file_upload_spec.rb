require_relative 'spec_helper'
require 'capybara/dsl'
require 'tempfile'
require 'rack/multipart'

# Programmatic file-upload chain. The kamalog `attach-images` Stimulus controller
# (and many drag-drop upload widgets) take an `attach_file`d input, move each File
# onto a freshly-cloned, differently-named input via
# `input.files = dataTransfer.files`, then submit the form through Turbo (fetch +
# FormData). This exercises every link csim has to provide:
#   - `input.files` is settable (CSSOM/HTML lets you assign a FileList)
#   - `DataTransfer.files` reflects `items.add(file)`
#   - `new FormData(form)` includes file inputs
#   - the multipart serializer is UTF-8 safe (non-ASCII field values / labels)
#   - upload bytes resolve even when the File was moved to another input
RSpec.describe 'programmatic file upload' do
  include Capybara::DSL

  let(:png) {
    f = Tempfile.new(['shot', '.png'])
    f.binmode
    f.write("\x89PNG\r\n\x1a\n".b + ("\xDE\xAD\xBE\xEF".b * 64))   # bytes >= 0x80
    f.flush
    f
  }

  let(:app) {
    lambda do |env|
      if env['REQUEST_METHOD'] == 'POST'
        req  = Rack::Request.new(env)
        up   = req.params['photo']
        memo = req.params['memo'].to_s
        bytes = up && up[:tempfile] ? up[:tempfile].read.bytesize : 0
        name  = up ? up[:filename] : '(none)'
        [200, {'content-type' => 'text/html; charset=utf-8'},
         ["<!doctype html><body><div id='result'>ok name=#{name} bytes=#{bytes} memo=#{memo}</div></body>"]]
      else
        [200, {'content-type' => 'text/html; charset=utf-8'}, [<<~HTML]]
          <!doctype html><html><body>
            <form id="f" action="/" method="post" enctype="multipart/form-data">
              <label class="btn">画像を追加<input id="picker" type="file" hidden></label>
              <input type="text" name="memo">
              <div id="container"></div>
              <template id="tpl"><input class="cloned" type="file" name="photo" hidden></template>
              <button type="submit">送信する</button>
            </form>
            <script>
              // Move the picked file onto a cloned, differently-named input —
              // exactly what a clone-on-attach upload controller does.
              document.getElementById('picker').addEventListener('change', e => {
                const tpl = document.getElementById('tpl');
                const container = document.getElementById('container');
                for (const file of e.target.files) {
                  const node = tpl.content.cloneNode(true);
                  const dt = new DataTransfer();
                  dt.items.add(file);
                  node.querySelector('input').files = dt.files;
                  container.appendChild(node);
                }
              });
              // Submit through fetch + FormData (the Turbo path).
              document.getElementById('f').addEventListener('submit', e => {
                e.preventDefault();
                fetch('/', { method: 'POST', body: new FormData(e.target) })
                  .then(r => r.text())
                  .then(html => { document.body.innerHTML = html; });
              });
            </script>
          </body></html>
        HTML
      end
    end
  }

  before do
    Capybara.app = app
    Capybara.default_driver = :simulated
    visit '/'
  end

  it 'sets input.files from a DataTransfer and reflects items.add' do
    result = page.evaluate_script(<<~JS)
      (() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['abc'], 'x.txt', { type: 'text/plain' }));
        const inp = document.querySelector('input.cloned') ||
                    document.getElementById('tpl').content.querySelector('input');
        inp.files = dt.files;
        return { dt: dt.files.length, input: inp.files.length, name: inp.files[0] && inp.files[0].name };
      })()
    JS
    expect(result).to eq('dt' => 1, 'input' => 1, 'name' => 'x.txt')
  end

  it 'includes file inputs in new FormData(form)' do
    attach_file 'picker', png.path, make_visible: true
    keys = page.evaluate_script(<<~JS)
      (() => {
        const fd = new FormData(document.getElementById('f'));
        const out = [];
        for (const [k, v] of fd.entries()) out.push(k + '=' + (v && v.name !== undefined ? 'FILE:' + v.name : v));
        return out;
      })()
    JS
    expect(keys).to include(a_string_matching(%r{\Aphoto=FILE:shot}))
  end

  it 'uploads the moved file bytes with a non-ASCII field through fetch + FormData' do
    fill_in 'memo', with: '日本語メモ'
    attach_file 'picker', png.path, make_visible: true
    expected_bytes = File.size(png.path)
    click_button '送信する'
    # The fetch response replaces the body; assert the server saw the file bytes
    # (resolved via the original attach even though the File moved to #photo) and
    # the UTF-8 field value (the multipart serializer must not mangle it).
    expect(page).to have_css('#result', text: "bytes=#{expected_bytes}")
    expect(page).to have_css('#result', text: 'memo=日本語メモ')
    expect(page).to have_css('#result', text: 'name=shot')
  end
end
