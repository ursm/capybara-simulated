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

  let(:seen) { Hash.new(0) }
  let(:session) do
    simulated_session(lambda {|env|
      seen[env['PATH_INFO']] += 1
      html = ->(body, headers = {}) { [200, {'content-type' => 'text/html'}.merge(headers), ["<!DOCTYPE html><meta charset=utf-8>#{body}"]] }
      case env['PATH_INFO']
      when '/meta' then html.(%(<title>meta</title><meta http-equiv=Refresh content="0; URL='/landed?from=meta'"><meta http-equiv=refresh content="0; url=/second">))
      when '/header' then html.('<title>header</title>', {'refresh' => '0;url=/landed?from=header'})
      when '/js' then html.(%(<title>js</title><meta http-equiv=refresh content="0; url=javascript:document.title='ran'">))
      when '/shadow' then html.('<title>shadow</title><div id=h></div><script>h.attachShadow({mode: "open"}).innerHTML = \'<meta http-equiv=refresh content="0; url=/landed">\'</script>')
      when '/base' then html.(seen['/base'] > 2 ? '<title>base</title>' : '<title>base</title><base href="/other/"><meta http-equiv=refresh content="0">')
      when '/both' then html.('<title>both</title><meta http-equiv=refresh content="0; url=/landed?from=meta">', {'refresh' => '0;url=/landed?from=header'})
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

  it "takes no javascript: URL's" do
    session.visit '/js'
    session.evaluate_script('1')
    expect([session.current_path, session.title]).to eq(['/js', 'js'])
  end

  it 'takes none in a shadow tree' do
    session.visit '/shadow'
    session.evaluate_script('1')
    expect([session.current_path, session.title]).to eq(['/shadow', 'shadow'])
  end

  # (…none named the document's URL, not its base URL — one with a fragment kept, its navigation a fragment one — and a
  # header the first to say one, before a `<meta>` its document has)
  it "takes the document's own URL where none is named, and a header's before a meta's" do
    session.visit '/base'
    expect(poll_until { seen['/base'].to_i >= 2 && seen['/base'] }).to be >= 2
    expect(seen.key?('/other/')).to be(false)
    session.visit '/both'
    expect(poll_until { session.title.start_with?('landed') && session.title }).to eq('landed from=header')
  end
end
