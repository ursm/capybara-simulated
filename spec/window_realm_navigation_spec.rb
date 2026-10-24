# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A window `open()` made navigated to an http(s) URL loads the document its response is: a top-level navigation
# request of the document that navigated it, its document made of the response's bytes in the encoding they declare,
# referred by the Referer it sent and under the policy the response sets — the window the same WindowProxy throughout,
# its new document's from its first script on — and one whose response downloads or makes no document leaves the
# window at the document it is at (HTML "navigate").
RSpec.describe 'a window open() made, navigated' do
  include PollUntil

  let(:session) do
    simulated_session(lambda {|env|
      html = ->(body, headers = {}) { [200, {'content-type' => 'text/html'}.merge(headers), [body]] }
      case env['PATH_INFO']
      when '/' then html.('<!DOCTYPE html><script>window.w = open("", "pop")</script>')
      when '/p2' then html.('<!DOCTYPE html><title>P2</title><script>window.sawSelf = opener.w.document === document</script>')
      when '/p3' then html.('<!DOCTYPE html><title>P3</title><img src="/i.png">', {'referrer-policy' => 'no-referrer'})
      when '/sj' then [200, {'content-type' => 'text/html; charset=shift_jis'}, ["<!DOCTYPE html><title>\x93\xFA\x96\x7B</title>".b]]
      when '/dl' then [200, {'content-type' => 'text/plain', 'content-disposition' => 'attachment; filename=x.txt'}, ['x']]
      when '/i.png' then (seen << env['HTTP_REFERER']) && [200, {'content-type' => 'image/png'}, ['']]
      else html.('')
      end
    })
  end
  let(:seen) { [] }

  it 'loads its response, its WindowProxy kept, referred and decoded as its response says' do
    session.visit '/'
    session.execute_script('w.location.href = "/p2"')
    expect(poll_until { session.evaluate_script('w.document.title') == 'P2' }).to be(true)
    expect(session.evaluate_script('[w === open("", "pop"), w.sawSelf]')).to eq([true, true])
    # (…its own navigation, referred by itself)
    session.execute_script('w.eval(\'location.href = "/p3"\')')
    expect(poll_until { session.evaluate_script('w.document.title') == 'P3' }).to be(true)
    expect(session.evaluate_script('w.document.referrer')).to eq('http://www.example.com/p2')
    expect(poll_until { seen.size == 1 && seen }).to eq([nil])
    session.execute_script('w.location.href = "/sj"')
    expect(poll_until { session.evaluate_script('w.document.characterSet') == 'Shift_JIS' }).to be(true)
    expect(session.evaluate_script('w.document.title')).to eq('日本')
  end

  it 'stays at its document for a download, and navigates no more once closed' do
    session.visit '/'
    session.execute_script('w.location.href = "/dl"')
    session.evaluate_script('1')
    expect(session.evaluate_script('w.location.href')).to eq('about:blank')
    session.execute_script('w.close(); w.location.href = "/p2"')
    session.evaluate_script('1')
    expect(session.evaluate_script('[w.closed, w.location.href]')).to eq([true, 'about:blank'])
  end
end
