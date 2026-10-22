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
end
