# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# HTML's shared declarative refresh steps: a `<meta http-equiv=refresh>` inserted into the document's tree, or a
# `Refresh` response header, navigates the document to its URL — its own where it names none — once its delay is up
# after the document has loaded, replacing its session history entry; only the first that says so, none for a
# `javascript:` URL, and none for one in a shadow tree.
RSpec.describe 'a declarative refresh' do
  include PollUntil

  let(:session) do
    simulated_session(lambda {|env|
      html = ->(body, headers = {}) { [200, {'content-type' => 'text/html'}.merge(headers), ["<!DOCTYPE html><meta charset=utf-8>#{body}"]] }
      case env['PATH_INFO']
      when '/meta' then html.(%(<title>meta</title><meta http-equiv=Refresh content="0; URL='/landed?from=meta'"><meta http-equiv=refresh content="0; url=/second">))
      when '/header' then html.('<title>header</title>', {'refresh' => '0;url=/landed?from=header'})
      when '/js' then html.(%(<title>js</title><meta http-equiv=refresh content="0; url=javascript:document.title='ran'">))
      when '/shadow' then html.('<title>shadow</title><div id=h></div><script>h.attachShadow({mode: "open"}).innerHTML = \'<meta http-equiv=refresh content="0; url=/landed">\'</script>')
      when '/landed' then html.("<title>landed #{env['QUERY_STRING']}</title>")
      else html.('')
      end
    })
  end

  it 'navigates to the first one, its entry replaced' do
    session.visit '/'
    session.visit '/meta'
    expect(poll_until { session.title == 'landed from=meta' && session.title }).to eq('landed from=meta')
    session.go_back
    expect(session.current_path).to eq('/')
    session.visit '/header'
    expect(poll_until { session.title == 'landed from=header' && session.title }).to eq('landed from=header')
  end

  it "takes no javascript: URL's and none in a shadow tree" do
    session.visit '/js'
    session.visit '/shadow'
    session.evaluate_script('1')
    expect([session.current_path, session.title]).to eq(['/shadow', 'shadow'])
  end
end
