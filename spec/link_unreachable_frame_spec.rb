# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A page link whose target names a frame chooses that frame's navigable (HTML "the rules for choosing a navigable",
# navigation_plan.rs `planNavigation`) — never the page's own, even where the frame is one the driver builds no document
# for (past its nesting limit): the page stays where it is, its plan untouched.
RSpec.describe 'a link naming a frame the driver does not build' do
  let(:app) {
    lambda {|env|
      body = case env['PATH_INFO']
      when '/'
        '<!DOCTYPE html><meta charset="utf-8"><title>main</title><a id="deep" href="/hit">deep</a>' \
          '<iframe src="/nest?d=1"></iframe>'
      when '/planned'
        '<!DOCTYPE html><meta charset="utf-8"><title>planned</title>'
      when '/nest'
        depth = Rack::Request.new(env).params['d'].to_i
        %(<!DOCTYPE html><meta charset="utf-8"><body>d#{depth}<iframe name="n#{depth + 1}" src="/nest?d=#{depth + 1}"></iframe>)
      else
        '<!DOCTYPE html><meta charset="utf-8"><title>hit</title><body>HIT'
      end
      [200, {'content-type' => 'text/html'}, [body]]
    }
  }

  it 'leaves the page where it is' do
    session = simulated_session(app)
    session.visit '/'
    # (…frame n<k> is k deep: the first past the limit the driver builds a document for)
    unbuilt = "n#{Capybara::Simulated::V8Runtime::MAX_FRAME_DEPTH + 1}"
    session.execute_script("document.getElementById('deep').target = #{unbuilt.to_json}")
    session.find(:css, '#deep').click
    expect([session.title, session.windows.size]).to eq(['main', 1])
  end

  it 'leaves what the page planned before planned' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      const link = document.getElementById('deep');
      link.target = #{"n#{Capybara::Simulated::V8Runtime::MAX_FRAME_DEPTH + 1}".to_json};
      link.addEventListener('click', () => { location.href = '/planned'; });
    JS
    session.find(:css, '#deep').click
    expect([session.title, session.windows.size]).to eq(['planned', 1])
  end
end
