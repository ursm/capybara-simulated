# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# HTML "submit" builds a form's request — its action, method, entries — before it plans the navigation: what the page
# does to the form after `submit()` returns is no part of what it sends. And a form whose node document is no longer
# fully active cannot navigate at all.
RSpec.describe "a form submission's request" do
  include PollUntil

  html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]] }

  # Chrome: "/r.html?q=orig".
  it 'is what the form was as it was submitted' do
    app = lambda {|env|
      next html.("<body>#{env['PATH_INFO']}?#{env['QUERY_STRING']}") unless env['PATH_INFO'] == '/'

      html.('<body><form id="f" action="/r"><input name="q" value="orig"></form>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.execute_script("f.submit(); f.q.value = 'changed'; f.action = '/other';")
    expect(session).to have_current_path('/r?q=orig')
  end

  # WPT reparent-form-during-planned-navigation-task: a form moved into another document after `submit()` still
  # navigates the frame it was submitted in.
  it 'navigates even where the form is moved to another document after it' do
    app = lambda {|env|
      next html.('<body>blank') if env['PATH_INFO'] == '/b'

      html.(<<~HTML)
        <body><script>var log = [];</script><iframe id="i" src="about:blank"></iframe>
        <script>
          const form = i.contentDocument.createElement('form');
          form.action = '/b';
          i.contentDocument.body.appendChild(form);
          i.onload = () => log.push(i.contentDocument.body.textContent);
          form.submit();
          new Document().prepend(form);
        </script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 1 }
    expect(session.evaluate_script('log')).to eq(['blank'])
  end

  # WPT submission-checks "<form> in a navigated document cannot navigate": a form of a document its frame navigated
  # away from submits nothing — the page stays where it is.
  it 'is none for a form whose document is no longer fully active' do
    app = lambda {|env|
      next html.('<body>frame') if env['PATH_INFO'] == '/f'
      next html.('<body>submitted') if env['PATH_INFO'] == '/s'

      html.(<<~HTML)
        <body><script>var log = [];</script><iframe id="i"></iframe>
        <script>
          const form = i.contentDocument.createElement('form');
          form.action = '/s';
          i.contentDocument.body.appendChild(form);
          i.onload = () => { if (i.contentWindow.location.pathname === '/f') { form.submit(); log.push('submitted'); } };
          i.src = '/f';
        </script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 1 }
    session.evaluate_script('1')
    expect(session).to have_current_path('/')
    expect(session.evaluate_script('i.contentDocument.body.textContent')).to eq('frame')
  end

  # …and is its node document's to plan, whichever realm's code submits it: a form the page made and moved into a frame's
  # document navigates the frame, not the page (Chrome).
  it "navigates the navigable of the form's document" do
    app = lambda {|env|
      next html.("<body>#{env['PATH_INFO']}?#{env['QUERY_STRING']}") unless env['PATH_INFO'] == '/'

      html.('<body><iframe id="i"></iframe>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      const g = document.createElement('form');
      g.action = '/moved';
      g.innerHTML = '<input name="q" value="pv">';
      i.contentDocument.body.appendChild(g);
      g.submit();
    JS
    poll_until { session.evaluate_script('i.contentDocument.body.textContent') == '/moved?q=pv' }
    expect(session).to have_current_path('/')
  end

  # A frame's form targeting `_top` navigates the page, and one targeting `_parent` its parent — the page where that
  # is the frame's parent (Chrome); none where the frame's sandbox keeps it from navigating the page.
  {
    'top'                => ['<iframe srcdoc="<form id=f action=/t target=_top><input name=q value=1></form>"></iframe>', '/t?q=1'],
    'parent'             => ['<iframe srcdoc="<form id=f action=/p target=_parent><input name=q value=2></form>"></iframe>', '/p?q=2'],
    'sandboxed (no top)' => ['<iframe sandbox="allow-scripts allow-forms allow-same-origin" srcdoc="<form id=f action=/s target=_top><input name=q value=3></form>"></iframe>', '/']
  }.each do |name, (frame, path)|
    it "navigates the navigable a frame's form's #{name} target chooses" do
      app = lambda {|env|
        next html.("<body>#{env['PATH_INFO']}") unless env['PATH_INFO'] == '/'

        html.("<body>#{frame}")
      }
      session = simulated_session(app)
      session.visit '/'
      session.within_frame(0) { session.execute_script('f.submit()') }
      expect(session).to have_current_path(path)
    end
  end
end
