# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame's WindowProxy is one object however its navigable's active document changes (HTML "browsing context"): the
# `contentWindow` a script kept is the frame's next document's window too, from that document's first script on — in
# its parent, and in a sibling frame holding it through `parent.frames` — and, the frame removed, one whose browsing
# context is gone: closed, with no `parent`, `top`, `frameElement` or `opener`.
RSpec.describe "a frame's WindowProxy across its navigations" do
  include PollUntil

  let(:session) do
    simulated_session(lambda {|env|
      html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html>#{body}"]] }
      case env['PATH_INFO']
      when '/' then html.('<iframe src="/a"></iframe><iframe src="/s"></iframe>')
      when '/a' then html.('<title>A</title>')
      when '/b' then html.('<title>B</title><script>window.sawSelf = parent.fw.document === document</script>')
      when '/s' then html.('<script>window.held = () => parent.frames[0]</script>')
      else html.('')
      end
    })
  end

  it 'stays the one object, over the new document from its first script on' do
    session.visit '/'
    expect(poll_until { session.evaluate_script('frames[0].document.title') == 'A' }).to be(true)
    session.execute_script('window.fw = frames[0]; window.kept = frames[1].held(); fw.location.href = "/b"')
    expect(poll_until { session.evaluate_script('fw.document.title') == 'B' }).to be(true)
    expect(session.evaluate_script('[fw === frames[0], fw === document.querySelector("iframe").contentWindow, fw.sawSelf]')).to eq([true, true, true])
    expect(session.evaluate_script('[frames[1].held() === kept, kept.document.title]')).to eq([true, 'B'])
  end

  it 'leaves a removed frame inert' do
    session.visit '/'
    expect(poll_until { session.evaluate_script('frames[0].document.title') == 'A' }).to be(true)
    session.execute_script('window.fw = frames[0]; document.querySelector("iframe").remove()')
    expect(session.evaluate_script('[fw.closed, fw.parent, fw.top, fw.frameElement, fw.opener]')).to eq([true, nil, nil, nil, nil])
  end
end
