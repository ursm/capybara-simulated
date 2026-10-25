# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A subresource's request is the engine's plan of it (subresource_plan.rs `plan`): a module script's options carry its
# own `referrerpolicy` alone, so a later `import()` takes its document's policy as it is then (Fetch "main fetch"); and a
# link's request takes its `crossorigin` as its load task runs — one set right after the link is inserted is the one
# its one fetch is made with. That is the driver's model of a link's fetch (a task after insertion), not the platform's:
# HTML begins a sheet's fetch as the link is inserted, and a `crossorigin` change fetches it again — a backlog item.
RSpec.describe 'a subresource request plan' do
  include PollUntil

  let(:seen) { [] }
  let(:session) do
    simulated_session(lambda {|env|
      seen << [env['PATH_INFO'], env['HTTP_REFERER'], env['HTTP_ORIGIN']]
      case env['PATH_INFO']
      when '/m.js' then [200, {'content-type' => 'text/javascript'}, ["window.later = () => import('/d.js');"]]
      when '/d.js', '/p.js' then [200, {'content-type' => 'text/javascript', 'access-control-allow-origin' => '*'}, ['export {};']]
      when '/c.css' then [200, {'content-type' => 'text/css', 'access-control-allow-origin' => '*'}, ['p { color: red }']]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
          <script type="module" src="/m.js"></script>
        HTML
      end
    })
  end

  it "takes a module's document's policy as a later import is made" do
    session.visit '/'
    session.execute_script(<<~JS)
      document.querySelector('meta[name=referrer]').content = 'unsafe-url';
      window.done = false;
      window.later().then(() => { window.done = true; });
    JS
    expect(poll_until { session.evaluate_script('window.done') }).to be(true)
    expect(seen.assoc('/d.js')[1]).to eq('http://www.example.com/m.js')
  end

  it "fetches a link once, with the crossorigin set before its load task ran" do
    session.visit '/'
    session.execute_script(<<~JS)
      for (const [rel, href] of [['preload', '/p.js'], ['stylesheet', '/c.css']]) {
        const link = document.createElement('link');
        link.rel = rel;
        if (rel === 'preload') link.as = 'script';
        link.href = href;
        document.head.append(link);
        link.crossOrigin = 'anonymous';
      }
    JS
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    expect(seen.select {|(path, _, _)| %w[/p.js /c.css].include?(path) }.map(&:first).sort).to eq(%w[/c.css /p.js])
  end
end
