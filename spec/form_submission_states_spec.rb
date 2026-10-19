# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# How a form submits is the engine's (form_entries.rs `formSubmission`): its `method` and `enctype` are enumerated
# attributes — ASCII case-insensitive, an invalid value GET and urlencoded — a submitter's `formmethod` / `formenctype`
# over the form's, and with no `target` the document's `<base target>` names the navigable it submits into.
RSpec.describe 'Form submission states' do
  def app(received, body)
    lambda {|env|
      req = Rack::Request.new(env)
      if req.path == '/'
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]]
      else
        received << [req.request_method, req.path, env['CONTENT_TYPE'], env['QUERY_STRING']]
        [200, {'content-type' => 'text/html'}, ['<p>ok</p>']]
      end
    }
  end

  forms = {
    'an invalid method'       => ['<form method=posted action=/a><input name=q value=1><button>go</button></form>', ['GET', '/a', nil, 'q=1']],
    'an invalid enctype'      => [
      '<form method=POST enctype=bogus action=/b><input name=q value=1><button>go</button></form>',
      ['POST', '/b', 'application/x-www-form-urlencoded', '']
    ],
    'an enctype in uppercase' => [
      '<form method=post enctype=TEXT/PLAIN action=/c><input name=q value=1><button>go</button></form>',
      ['POST', '/c', 'text/plain', '']
    ],
    'a formmethod'            => ['<form method=post action=/d><input name=q value=1><button formmethod=get>go</button></form>', ['GET', '/d', nil, 'q=1']]
  }
  forms.each do |what, (form, request)|
    it "submits #{what} as its state says" do
      received = []
      s = simulated_session(app(received, form))
      s.visit '/'
      s.click_on 'go'
      expect(received.first).to eq(request)
    end
  end

  it 'submits into the frame its document’s <base target> names' do
    received = []
    s = simulated_session(app(received, '<base target=f><form action=/e><button>go</button></form><iframe name=f></iframe>'))
    s.visit '/'
    s.click_on 'go'
    s.within_frame('f') { expect(s).to have_text('ok') }
    expect([received.first&.first(2), s.current_path]).to eq([%w[GET /e], '/'])
  end

  # …keeping the action URL's fragment across: the response's URL has none to give (Fetch serializes it without), and
  # the navigation is to the action URL — its query the entry list (HTML "mutate action URL"), its fragment its own — as
  # a top-level submission's is.
  it 'keeps the action’s fragment in the frame it submits into' do
    received = []
    s = simulated_session(app(received, '<form action="/e#x?y" target=f><input name=q value=1><button>go</button></form><iframe name=f></iframe>'))
    s.visit '/'
    s.click_on 'go'
    s.within_frame('f') { expect(s).to have_text('ok') }
    expect(s.within_frame('f') { s.evaluate_script('location.href') }).to eq('http://www.example.com/e?q=1#x?y')
  end

  # A script the driver runs is a task like any other: the navigation a form it submits plans is taken as it ends, on a
  # page with nothing else pending as on one with a timer to step.
  {'submit()' => 'document.forms[0].submit()', 'requestSubmit()' => 'document.forms[0].requestSubmit()'}.each do |what, js|
    it "navigates for a #{what} in a script the driver runs" do
      received = []
      s = simulated_session(app(received, '<form action=/g><input name=q value=1></form>'))
      s.visit '/'
      s.execute_script(js)
      expect([received.first, s.current_path]).to eq([['GET', '/g', nil, 'q=1'], '/g'])
      s.visit '/'
      s.evaluate_script("(#{js}, 1)")
      expect(s.current_path).to eq('/g')
      s.visit '/'
      s.evaluate_async_script("#{js}; arguments[0](1)")
      expect(s.current_path).to eq('/g')
    end
  end

  # …the page's own document's form, whichever frame the driver has entered.
  it "navigates the page for its own form a frame's script submits" do
    received = []
    s = simulated_session(app(received, '<form id=a action=/g><input name=q value=1></form><iframe name=f srcdoc="<p>f"></iframe>'))
    s.visit '/'
    s.within_frame('f') { s.execute_script('parent.document.getElementById("a").submit()') }
    expect([received.first, s.current_path]).to eq([['GET', '/g', nil, 'q=1'], '/g'])
  end

  # A form submission and a location navigation planned in one task: the later is the one taken (Chrome: `/g?q=1` for
  # the location first, `/b` for the form first).
  it 'takes the later of a location navigation and a form submission' do
    received = []
    s = simulated_session(app(received, '<form id=a action=/g><input name=q value=1></form>'))
    s.visit '/'
    s.execute_script('location.href = "/b"; document.getElementById("a").submit()')
    expect(s.current_path).to eq('/g')
    s.visit '/'
    s.execute_script('document.getElementById("a").submit(); location.href = "/b"')
    expect(s.current_path).to eq('/b')
  end

  # …and of a hyperlink a script follows (Chrome: `/l` for the form first, `/g?q=1` for the link first), which a script
  # the driver runs and a timer's task each take as they end.
  it 'follows a hyperlink a script activates, the later of it and a form submission taken' do
    received = []
    s = simulated_session(app(received, '<form id=a action=/g><input name=q value=1></form><a id=l href=/l>l</a>'))
    s.visit '/'
    s.execute_script('document.getElementById("l").click()')
    expect(s.current_path).to eq('/l')
    s.visit '/'
    s.execute_script('setTimeout(() => document.getElementById("l").click(), 5)')
    expect(s).to have_current_path('/l')
    s.visit '/'
    s.execute_script('document.getElementById("a").submit(); document.getElementById("l").click()')
    expect(s.current_path).to eq('/l')
    s.visit '/'
    s.execute_script('document.getElementById("l").click(); document.getElementById("a").submit()')
    expect(s.current_path).to eq('/g')
  end

  # The page's hyperlink resolves against the page whichever frame the driver entered (Chrome: `/dir/rel`), and one a
  # timer a click started follows is taken as the click's drain ends.
  it "resolves the page's hyperlink against the page, and follows one a click's timer activates" do
    s = simulated_session(lambda {|env|
      body = env['PATH_INFO'] == '/dir/page' ? '<a id=l href="rel">l</a><button onclick="setTimeout(() => l.click(), 10)">go</button><iframe name=f src="/sub/fr"></iframe>' : '<p>x'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]]
    })
    s.visit '/dir/page'
    s.within_frame('f') { s.execute_script("parent.document.getElementById('l').click()") }
    expect(s.current_path).to eq('/dir/rel')
    s.visit '/dir/page'
    s.click_on 'go'
    expect(s).to have_current_path('/dir/rel', wait: 1)
  end

  # A planned submission holds its form and its submitter as the page's objects (navigation_plan.rs): a form submitted,
  # removed and dropped before the host takes the plan — a collection between the task and its drain — submits all the
  # same, its submitter's value with it.
  it 'submits a form the page dropped before the plan was taken' do
    received = []
    s = simulated_session(app(received, '<p>x</p>'))
    s.visit '/'
    runtime = s.driver.browser.instance_variable_get(:@runtime)
    runtime.eval_void(<<~JS)
      (() => {
        const f = document.createElement('form');
        f.method = 'post';
        f.action = '/gc';
        f.innerHTML = '<input name=k value=v><button name=b value=1>go</button>';
        document.body.append(f);
        f.requestSubmit(f.querySelector('button'));
        f.remove();
      })();
    JS
    3.times { runtime.ctx.low_memory_notification }
    runtime.eval_void('for (let i = 0; i < 100; i++) document.createElement("span");')
    s.evaluate_script('1')
    expect(received.map {|r| r.first(2) }).to eq([%w[POST /gc]])
    expect(s).to have_current_path('/gc', wait: 1)
  end
end
