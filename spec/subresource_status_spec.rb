require 'capybara/simulated'
require_relative 'support/session_teardown'

# A script's or a `<link>`'s resource loads with an ok status alone — 200 to 299 (HTML "fetch a classic script":
# "response's status is not an ok status" → null; "fetch and process the linked resource": success false). A 3xx that
# is no redirect (a 300 with no Location) fails the load: `error`, the script not run, the sheet not applied. Chrome 155
# runs and applies both (it fails only a status of 400 or more); where the spec is explicit it wins over Blink.
RSpec.describe 'a subresource status' do
  def session_for(status)
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>window.log = [];</script>
      <script src="/s.js" onload="log.push('script load ' + !!window.ran)" onerror="log.push('script error ' + !!window.ran)"></script>
      <link rel="stylesheet" href="/c.css" onload="log.push('css load')" onerror="log.push('css error')"><p>x</p>
    HTML
    simulated_session(->(env) {
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, [page]]
      when '/s.js' then [status, {'content-type' => 'text/javascript'}, ['window.ran = true']]
      else [status, {'content-type' => 'text/css'}, ['p { color: rgb(1, 2, 3) }']]
      end
    }).tap {|s| s.visit '/' }
  end

  # (…the events sorted: which of the two loads answers first is no part of it)
  def outcome(s)
    s.evaluate_async_script(<<~JS)
      setTimeout(() => arguments[0]([log.sort(), getComputedStyle(document.querySelector('p')).color]), 10);
    JS
  end

  it 'fails a 300 with no Location' do
    expect(outcome(session_for(300))).to eq([['css error', 'script error false'], 'rgb(0, 0, 0)'])
  end

  it 'loads a 299' do
    expect(outcome(session_for(299))).to eq([['css load', 'script load true'], 'rgb(1, 2, 3)'])
  end
end
