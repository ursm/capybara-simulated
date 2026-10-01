# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's encoding is decided from its BYTES as it loads (HTML's encoding sniffing): a BOM, else the Content-Type's
# charset, else what the document declares (`<meta charset>`, an XML declaration), else — a document in a frame — its
# same-origin parent's, else windows-1252 (UTF-8 for XML). A document made of a string is UTF-8. The frame figures are
# Chrome's and Firefox's, measured on a Shift_JIS parent: `srcdoc` and an empty frame are UTF-8 in both, a fetched child
# inherits Shift_JIS in both; a `javascript:` URL's document is UTF-8 in Chrome (Firefox: windows-1252) and in the spec,
# whose response for it says `text/html;charset=utf-8`.
RSpec.describe 'Document encoding' do
  def app(pages)
    lambda {|env|
      type, body = pages.fetch(env['PATH_INFO'])
      [200, {'content-type' => type}, [body.b]]
    }
  end

  it 'gives a frame its parent encoding, unless it is a string or declares its own' do
    parent = '<!DOCTYPE html><meta charset="shift_jis"><body>' \
             '<iframe id="srcdoc" srcdoc="<p>x</p>"></iframe>' \
             '<iframe id="blank"></iframe>' \
             "<iframe id=\"js\" src=\"javascript:'<p>y</p>'\"></iframe>" \
             '<iframe id="child" src="/child"></iframe>' \
             '<iframe id="meta" src="/meta"></iframe>' \
             '<iframe id="xml" src="/xml"></iframe>'
    s = simulated_session(app(
      '/'      => ['text/html', parent],
      '/child' => ['text/html', "<!DOCTYPE html><p>z\x82\xA0</p>"],
      '/meta'  => ['text/html', "<!DOCTYPE html><meta charset=euc-jp><p>\xA4\xA2</p>"],
      '/xml'   => ['application/xml', "<?xml version=\"1.0\" encoding=\"Shift_JIS\"?><r>\x82\xA0</r>"]
    ))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      ['srcdoc', 'blank', 'js', 'child', 'meta', 'xml'].map((id) => {
        const doc = document.getElementById(id).contentDocument;
        return id + ':' + doc.characterSet + ':' + doc.documentElement.textContent;
      })
    JS
    expect(got).to eq([
      'srcdoc:UTF-8:x',
      'blank:UTF-8:',
      'js:UTF-8:y',
      'child:Shift_JIS:zあ',
      'meta:EUC-JP:あ',
      'xml:Shift_JIS:あ'
    ])
  end

  it 'reads a BOM over the Content-Type, and the Content-Type over a meta' do
    s = simulated_session(app(
      '/bom'  => ['text/html; charset=shift_jis', "\xEF\xBB\xBF<!DOCTYPE html><meta charset=euc-jp><p>\xE3\x81\x82</p>"],
      '/http' => ['text/html; charset=shift_jis', "<!DOCTYPE html><meta charset=euc-jp><p>\x82\xA0</p>"],
      '/none' => ['text/html', "<!DOCTYPE html><p>\xE9</p>"]
    ))
    got = %w[/bom /http /none].map {|path|
      s.visit path
      s.evaluate_script('document.characterSet + ":" + document.body.textContent')
    }
    expect(got).to eq(['UTF-8:あ', 'Shift_JIS:あ', 'windows-1252:é'])
  end

  # Measured 2026-10-02: Chrome honors both; Firefox only the one in <head> — the spec's "change the encoding" is for a
  # `<meta>` the parser meets anywhere (in body it is processed by the in-head rules).
  it 'changes the encoding for a meta past the first 1024 bytes, but not for one in a script' do
    pad = 'x' * 1100
    s = simulated_session(app(
      '/head'   => ['text/html', "<!DOCTYPE html><style>/*#{pad}*/</style><meta charset=shift_jis><p>\x82\xA0</p>"],
      '/body'   => ['text/html', "<!DOCTYPE html><p>#{pad}</p><meta charset=shift_jis><p>\x82\xA0</p>"],
      '/script' => ['text/html', "<!DOCTYPE html><p>#{pad}</p><script>'<meta charset=big5>'</script>"]
    ))
    got = %w[/head /body /script].map {|path|
      s.visit path
      s.evaluate_script('document.characterSet')
    }
    expect(got).to eq(%w[Shift_JIS Shift_JIS windows-1252])
  end

  it "gives an XHR document response the encoding it was decoded in, UTF-8 where nothing says" do
    s = simulated_session(app(
      '/'     => ['text/html; charset=utf-8', '<!DOCTYPE html><p>x</p>'],
      '/sjis' => ['text/html; charset=shift_jis', "<p>\x82\xA0</p>"],
      '/meta' => ['text/html', "<meta charset=euc-jp><p>\xA4\xA2</p>"],
      '/none' => ['text/html', '<p>x</p>']
    ))
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      Promise.all(['/sjis', '/meta', '/none'].map((url) => new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.responseType = 'document';
        xhr.onload = () => resolve(xhr.response.characterSet + ':' + xhr.response.body.textContent);
        xhr.send();
      }))).then(done);
    JS
    expect(got).to eq(['Shift_JIS:あ', 'EUC-JP:あ', 'UTF-8:x'])
  end

  it 'decodes a document a link inside a frame navigates to' do
    s = simulated_session(app(
      '/'   => ['text/html; charset=utf-8', '<!DOCTYPE html><iframe name="f" src="/a"></iframe>'],
      '/a'  => ['text/html; charset=utf-8', '<!DOCTYPE html><a href="/sj">go</a>'],
      '/sj' => ['text/html; charset=shift_jis', "<!DOCTYPE html><p>\x82\xA0</p>"]
    ))
    s.visit '/'
    got = s.within_frame('f') {
      s.click_link 'go'
      s.evaluate_script('document.characterSet + ":" + document.body.textContent')
    }
    expect(got).to eq('Shift_JIS:あ')
  end
end
