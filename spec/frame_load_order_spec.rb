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

  # A frame's `load` handler navigating it again owes the new navigation's `load`, which the page's waits for too —
  # Chrome: "fload:/g,fload:/h,wload".
  it 'waits for the load a frame navigated from its load handler owes' do
    app = lambda {|env|
      next html.("<body>#{env['PATH_INFO']}") unless env['PATH_INFO'] == '/'

      html.(<<~HTML)
        <body><script>var log = []; addEventListener('load', () => log.push('wload'));</script>
        <iframe id="f" src="/g" onload="log.push('fload:' + this.src.slice(-2)); if (!window.again) { window.again = true; this.src = '/h' }"></iframe>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 3 }
    expect(session.evaluate_script('log')).to eq(%w[fload:/g fload:/h wload])
  end

  # A frame its attributes navigate to about:blank fires its `load` as it is inserted (HTML "process the iframe
  # attributes": at once, not on a task), and a navigation that follows — `srcdoc` set as the page is parsed — owes its
  # own, which the page's waits for. Chrome: "fload,fload,wload".
  it "fires a blank frame's load as it is inserted, and waits for the load of the navigation after it" do
    app = lambda {|_env|
      html.(<<~HTML)
        <body><script>var log = []; addEventListener('load', () => log.push('wload'));</script>
        <iframe id="f" onload="log.push('fload')"></iframe>
        <script>f.srcdoc = '<p>s';</script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log').include?('wload') }
    expect(session.evaluate_script('log')).to eq(%w[fload fload wload])
  end

  # …inside the call that inserted it, so a listener added after that call misses it. Chrome and Firefox:
  # "before,load-in-append,after,micro,wload".
  it "fires a blank frame's load inside the insertion" do
    app = lambda {|_env|
      html.(<<~HTML)
        <body><script>
          var log = [];
          addEventListener('load', () => log.push('wload'));
          const i = document.createElement('iframe');
          i.onload = () => log.push('load-in-append');
          log.push('before');
          document.body.appendChild(i);
          log.push('after');
          const j = document.createElement('iframe');
          document.body.appendChild(j);
          j.onload = () => log.push('late-listener');
          Promise.resolve().then(() => log.push('micro'));
        </script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log').include?('wload') }
    expect(session.evaluate_script('log')).to eq(%w[before load-in-append after micro wload])
  end
end
