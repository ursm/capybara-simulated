# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A hyperlink followed in a document that is not fully active — its frame removed, its realm's code still running —
# navigates nothing (HTML "follow the hyperlink" step 1: an `<a>` that "cannot navigate"): not the top page, which a
# discarded realm's lookup of its own id took it for. Nor does its window's `open()`, nor its location: it has no
# browsing context any more — a frame navigated away keeps its old window's script running too.
RSpec.describe 'a hyperlink in a discarded frame' do
  it 'navigates nothing' do
    s = simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/f' then '<a id=a href="/next">x</a>'
             when '/next' then '<title>next</title>'
             else '<title>top</title><iframe src=/f></iframe>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]]
    })
    s.visit '/'
    s.execute_script(<<~JS)
      const f = document.querySelector('iframe'), d = f.contentDocument;
      f.remove();
      d.getElementById('a').click();
    JS
    expect([s.title, URI(s.current_url).path]).to eq(['top', '/'])
  end

  it "opens and navigates nothing from a frame's window it navigated away from" do
    requests = []
    s = simulated_session(lambda {|env|
      requests << env['PATH_INFO']
      body = case env['PATH_INFO']
             when '/f', '/g' then 'frame'
             when '/next' then '<title>next</title>'
             else '<title>top</title><iframe src=/f></iframe>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]]
    })
    s.visit '/'
    s.execute_script(<<~JS)
      const f = document.querySelector('iframe');
      // (…the old window's own `open`, unbound: its WindowProxy is the new window's after the navigation)
      window.oldOpen = f.contentWindow.open;
      window.oldLocation = f.contentWindow.location;
      f.src = '/g';
    JS
    got = s.evaluate_script("[oldOpen('/next', '_top'), (() => { try { oldLocation.href = '/next'; } catch (e) {} return 1; })()]")
    s.evaluate_script('1')
    expect([got.first, s.title, requests.include?('/next')]).to eq([nil, 'top', false])
  end
end
