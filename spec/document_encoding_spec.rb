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
      body, type = pages.fetch(env['PATH_INFO'])
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
      '/'      => [parent, 'text/html'],
      '/child' => ["<!DOCTYPE html><p>z\x82\xA0</p>", 'text/html'],
      '/meta'  => ["<!DOCTYPE html><meta charset=euc-jp><p>\xA4\xA2</p>", 'text/html'],
      '/xml'   => ["<?xml version='1.0' encoding='Shift_JIS'?><r>\x82\xA0</r>", 'application/xml']
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
      '/bom'  => ["\xEF\xBB\xBF<!DOCTYPE html><meta charset=euc-jp><p>\xE3\x81\x82</p>", 'text/html; charset=shift_jis'],
      '/http' => ["<!DOCTYPE html><meta charset=euc-jp><p>\x82\xA0</p>", 'text/html; charset=shift_jis'],
      '/none' => ["<!DOCTYPE html><p>\xE9</p>", 'text/html']
    ))
    got = %w[/bom /http /none].map {|path|
      s.visit path
      s.evaluate_script('document.characterSet + ":" + document.body.textContent')
    }
    expect(got).to eq(['UTF-8:あ', 'Shift_JIS:あ', 'windows-1252:é'])
  end
end
