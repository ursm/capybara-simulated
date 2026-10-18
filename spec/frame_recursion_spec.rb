# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame whose `src` names a document a navigable above it has — its own document's or an ancestor's, their fragments
# aside — navigates nowhere as its attributes are processed (HTML "shared attribute processing steps for iframe and frame
# elements" step 3, frame_navigation.rs `src_nested`): it keeps the document it has, fires no `load`, and leaves a
# navigation under way to go on. A page that framed itself had built a realm for each frame down to the nesting limit,
# eighteen requests a visit. (Chrome 154 and Firefox allow one level of a document framing itself; HTML none.) A reload
# or a navigation from within is no attribute processing, and an `src` that matches about:blank is not asked: an iframe
# in an about:blank document would never load.
RSpec.describe 'a frame of a document above it' do
  let(:requests) { [] }
  let(:session) {
    simulated_session(lambda {|env|
      requests << env['PATH_INFO']
      body = case env['PATH_INFO']
      when '/other', '/other2' then '<!DOCTYPE html><meta charset=utf-8><p>other'
      when '/self' then <<~HTML
        <!DOCTYPE html><meta charset=utf-8><body><script>window.loads = []</script>
        <iframe id=self src="/self#x" onload="loads.push('self')"></iframe>
        <iframe id=other src="/other" onload="loads.push('other')"></iframe>
      HTML
      else '<!DOCTYPE html><meta charset=utf-8><body><script>window.loads = []</script>'
      end
      [200, {'content-type' => 'text/html'}, [body]]
    })
  }

  it 'navigates nowhere, and fires no load' do
    session.visit '/self'
    got = session.evaluate_script('[loads, document.getElementById("self").contentDocument.URL, document.getElementById("other").contentDocument.URL]')
    expect(got).to eq([['other'], 'about:blank', 'http://www.example.com/other'])
    expect(requests).to eq(['/self', '/other'])
  end

  it 'leaves the document it has, or the navigation under way, as they are' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.add = (id, src) => { const f = document.createElement('iframe'); f.id = id; f.src = src; f.onload = () => loads.push(id + ' ' + f.contentDocument.URL.slice(-6)); document.body.append(f); return f; };
      const pending = add('pending', '/other');
      pending.src = '/';
      const loaded = add('loaded', '/other');
      loaded.onload = () => {
        loads.push('loaded');
        loaded.onload = () => loads.push('reloaded');
        loaded.contentWindow.onbeforeunload = () => loads.push(window.reloading ? 'beforeunload' : 'beforeunload of src');
        loaded.src = '/#y';
        setTimeout(() => { window.reloading = true; loaded.contentWindow.location.reload(); }, 50);
      };
      const blank = document.body.appendChild(document.createElement('iframe'));
      const inner = blank.contentDocument.createElement('iframe');
      inner.src = 'about:blank#x';
      inner.onload = () => loads.push('about:blank#x');
      blank.contentDocument.body.append(inner);
    JS
    got = poll_until { v = session.evaluate_script('loads'); v.include?('reloaded') ? v : nil }
    expect(got).to contain_exactly('pending /other', 'about:blank#x', 'loaded', 'beforeunload', 'reloaded')
  end
end
