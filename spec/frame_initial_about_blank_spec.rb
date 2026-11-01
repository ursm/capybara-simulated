# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame's `src` is a navigation, and HTML navigates in parallel with the document that inserted the frame: until its
# response is in, the frame's document is the initial about:blank one its navigable was created with ("create a new
# child navigable"), which a read of `contentWindow` / `contentDocument` meanwhile answers — and the navigation's
# document then replaces it, its load a task of the frame's own ("the end"), the container's `load` after it. A frame
# with no `src` (or one matching about:blank) loads its about:blank document synchronously on insertion ("process the
# iframe attributes"), so a script writing into it right after finds it there.
RSpec.describe "a frame's initial about:blank document" do
  include PollUntil

  html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]] }

  # Chrome 156 and Firefox 159, measured 2026-11-01: "about:blank complete about:blank", then the child's script, its
  # load, the container's load at its own URL and the same WindowProxy, then the page's load — the initial about:blank's
  # Window kept for the document of its origin (HTML "create and initialize a Document object"): what the parent set on it
  # the child's own, its load listener run.
  it "answers a read of a src frame's window during the parse with its initial about:blank, then loads the src" do
    app = lambda {|env|
      next html.("<body><script>parent.log.push('child script ' + window.foo)</script><script>addEventListener('load', () => parent.log.push('child load'))</script>") if env['PATH_INFO'] == '/child'

      html.(<<~HTML)
        <body><script>var log = [];</script><iframe id="f" src="/child"></iframe>
        <script>
          var w = f.contentWindow;
          log.push([w.location.href, w.document.readyState, f.contentDocument.URL].join(' '));
          w.foo = 1;
          w.addEventListener('load', () => log.push('initial window listener'));
          f.addEventListener('load', () => log.push('container load ' + f.contentWindow.location.pathname + ' ' + (f.contentWindow === w)));
          addEventListener('load', () => log.push('top load'));
        </script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 6 }
    expect(session.evaluate_script('log')).to eq(
      [
        'about:blank complete about:blank',
        'child script 1',
        'initial window listener',
        'child load',
        'container load /child true',
        'top load'
      ]
    )
  end

  # Chrome and Firefox: a srcdoc frame and a src one inserted by script are about:blank right after the insertion; one
  # with no src is about:blank too, its body there to write into.
  it 'is what a frame inserted by script has until its navigation completes' do
    app = lambda {|env|
      next html.('<body>child') if env['PATH_INFO'] == '/child'

      html.(<<~HTML)
        <body><script>
          var log = [];
          var g = document.createElement('iframe'); g.src = '/child'; document.body.append(g);
          log.push('src ' + g.contentWindow.location.href + ' ' + g.contentDocument.readyState);
          var h = document.createElement('iframe'); h.srcdoc = '<p>x'; document.body.append(h);
          log.push('srcdoc ' + h.contentWindow.location.href + ' ' + h.contentDocument.body.innerHTML);
          var k = document.createElement('iframe'); document.body.append(k);
          k.contentDocument.body.innerHTML = 'written';
          log.push('blank ' + k.contentWindow.location.href + ' ' + k.contentDocument.body.textContent);
        </script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    expect(session.evaluate_script('log')).to eq(['src about:blank complete', 'srcdoc about:blank ', 'blank about:blank written'])
    poll_until { session.evaluate_script('g.contentDocument.body.textContent') == 'child' }
    expect(session.evaluate_script('h.contentDocument.body.innerHTML')).to eq('<p>x</p>')
  end

  # The driver waits for the page's load, which waits for its frames' documents: `within_frame` right after `visit`
  # finds the src document's content, never the initial about:blank.
  it "is never what within_frame finds after visit" do
    app = lambda {|env|
      next html.('<body><p id="inner">framed</p>') if env['PATH_INFO'] == '/child'

      html.('<body><iframe id="f" src="/child"></iframe><script>f.contentWindow;</script>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.within_frame('f') do
      expect(session.find(:css, '#inner').text).to eq('framed')
    end
  end
end
