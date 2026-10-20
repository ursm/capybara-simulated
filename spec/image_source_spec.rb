# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Which image an <img> fetches (image_source.rs): a <picture>'s selected <source>, a srcset's candidates over src —
# held to what Chrome fetched for the same images.
RSpec.describe 'image source selection' do
  it 'fetches the candidates Chrome does' do
    png = File.binread(Dir.glob('spec/wpt/resource-timing/resources/blue.png').first)
    doc = <<~HTML
      <!DOCTYPE html><html><body>
        <picture><source srcset=", /i.png?b1"><img src="/i.png?a1"></picture>
        <picture><source srcset="/i.png?b2 2x, /i.png?c2 1x"><img src="/i.png?a2"></picture>
        <img src="/i.png?a3" srcset="/i.png?b3 2x">
        <img src="/i.png?a4" srcset="/i.png?b4 100w, /i.png?c4 200w" sizes="50px">
        <picture><source type="" srcset="/i.png?b5"><img src="/i.png?a5"></picture>
      </body></html>
    HTML
    app = ->(env) { env['PATH_INFO'] == '/i.png' ? [200, {'content-type' => 'image/png'}, [png]] : [200, {'content-type' => 'text/html'}, [doc]] }
    s = simulated_session(app)
    s.visit 'http://www.example.com/'
    got = poll_until do
      names = s.evaluate_script("performance.getEntriesByType('resource').map(function (e) { return e.name.split('?').pop(); })")
      names.length >= 5 ? names.sort : nil
    end
    # A source whose srcset's first comma-piece is empty still has a candidate (b1); a density list picks 1x (c2);
    # src joins a density-only srcset as its 1x (a3); a width list's first, for one at 50px (b4); a source with an empty
    # `type` names no format to refuse (b5).
    expect(got).to eq(%w[a3 b1 b4 b5 c2])
  end

  # A `<picture>`'s `<source>` whose `media` stops matching, or whose `srcset` goes, is no longer the one selected: its
  # image is selected again (HTML's relevant mutations of a source: set, changed or removed).
  it "selects a picture's image again as its source's media or srcset change" do
    png = File.binread(Dir.glob('spec/wpt/resource-timing/resources/blue.png').first)
    doc = '<!DOCTYPE html><picture><source id=s srcset="/i.png?one" media="(min-width: 1px)"><img id=i src="/i.png?fallback"></picture>'
    app = ->(env) { env['PATH_INFO'] == '/i.png' ? [200, {'content-type' => 'image/png'}, [png]] : [200, {'content-type' => 'text/html'}, [doc]] }
    s = simulated_session(app)
    s.visit 'http://www.example.com/'
    src = -> { poll_until { (u = s.evaluate_script('i.currentSrc')).empty? ? nil : u.split('?').last } }
    expect(src.call).to eq('one')
    s.execute_script("s.media = '(max-width: 1px)'")
    expect(poll_until { (v = src.call) == 'fallback' ? v : nil }).to eq('fallback')
    s.execute_script("s.media = '(min-width: 1px)'; s.removeAttribute('srcset')")
    expect(poll_until { (v = src.call) == 'fallback' ? v : nil }).to eq('fallback')
    # (…and a source inserted before the image, or removed: a relevant mutation as its attributes' are)
    s.execute_script("s.setAttribute('srcset', '/i.png?one')")
    expect(poll_until { (v = src.call) == 'one' ? v : nil }).to eq('one')
    s.execute_script('s.remove()')
    expect(poll_until { (v = src.call) == 'fallback' ? v : nil }).to eq('fallback')
    s.execute_script("i.before(Object.assign(document.createElement('source'), {srcset: '/i.png?two'}))")
    expect(poll_until { (v = src.call) == 'two' ? v : nil }).to eq('two')
  end
end
