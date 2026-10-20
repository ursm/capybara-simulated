# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An exception an external script throws is reported at its script's URL, resolved — the file an `ErrorEvent` names
# (Chrome: `http://…/js/a.js`) — at the line and column of its own frame, whatever a page named the function it threw
# from; and an asynchronous script that never calls back is a timeout, not a nil answer.
RSpec.describe 'script error locations' do
  let(:app) {
    lambda {|env|
      case env['PATH_INFO']
      when '/js/a.js'
        [200, {'content-type' => 'text/javascript'}, ["var f = { ['a(b']() { throw new Error('x'); } };\nf['a(b']();\n"]]
      else
        page = <<~HTML
          <!DOCTYPE html><meta charset="utf-8">
          <script>window.seen = null; addEventListener('error', (e) => { seen = [e.filename, e.lineno, e.colno]; });</script>
          <script src="js/a.js"></script>
        HTML
        [200, {'content-type' => 'text/html'}, [page]]
      end
    }
  }

  it 'reports an external script’s exception at its resolved URL and its own frame' do
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script('seen')).to eq(['http://www.example.com/js/a.js', 1, 29])
  end

  it 'raises a script timeout where an asynchronous script never calls back' do
    s = simulated_session(app)
    s.visit '/'
    Capybara.using_wait_time(0.2) do
      expect { s.evaluate_async_script('/* no callback */') }.to raise_error(Capybara::Simulated::ScriptTimeoutError)
    end
  end
end
