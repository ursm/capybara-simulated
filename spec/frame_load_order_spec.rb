# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An iframe delays its document's load event until its own load event steps have run (HTML "iframe load event steps",
# from its document's "completely finish loading"): a frame's `load` at its element comes before the window's that
# contains it, however deep — each document's after its frames', each container's after its document's.
RSpec.describe 'the load of a document with frames' do
  include PollUntil

  html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]] }

  # Chrome and Firefox: "fload,wload".
  it "fires a frame's load before its window's" do
    app = lambda {|env|
      next html.('<body>x') if env['PATH_INFO'] == '/f'

      html.(<<~HTML)
        <body><script>var log = [];</script><iframe id="f" src="/f"></iframe>
        <script>
          f.addEventListener('load', () => log.push('fload'));
          addEventListener('load', () => log.push('wload'));
        </script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 2 }
    expect(session.evaluate_script('log')).to eq(%w[fload wload])
  end

  # Chrome: "inner1,inner0,cload,fload,wload".
  it "fires a nested frame's loads before its document's, and that before its container's and the page's" do
    app = lambda {|env|
      case env['PATH_INFO']
      when '/g' then html.('<body>g')
      when '/c'
        html.(<<~HTML)
          <body><iframe id="a" src="/g"></iframe><iframe id="b" src="/g"></iframe>
          <script>
            let n = 2;
            const done = () => top.log.push('inner' + (--n));
            a.onload = done;
            b.onload = done;
            addEventListener('load', () => top.log.push('cload'));
          </script>
        HTML
      else
        html.(<<~HTML)
          <body><script>var log = [];</script><iframe id="f" src="/c"></iframe>
          <script>
            f.addEventListener('load', () => log.push('fload'));
            addEventListener('load', () => log.push('wload'));
          </script>
        HTML
      end
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 5 }
    expect(session.evaluate_script('log')).to eq(%w[inner1 inner0 cload fload wload])
  end
end
