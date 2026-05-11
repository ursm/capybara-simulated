# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'

# v3 smoke: subset of `spec/smoke_spec.rb` that doesn't require `<script>`
# execution. Mirrors the first four smoke tests but registered against
# `:simulated_v3`, the all-in-V8 PoC driver. As milestones 3-5 land
# (event dispatch, virtual clock, custom elements, …) the remaining
# smoke tests get added back.

RSpec.describe 'Simulated v3 (V8-resident DOM) — smoke' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><head><title>Index</title></head><body>
              <h1>Welcome</h1>
              <p>Lorem ipsum.</p>
              <a id="about-link" href="/about">About</a>
              <ul>
                <li>One</li>
                <li>Two</li>
                <li>Three</li>
              </ul>
            </body></html>
          HTML
        when '/about'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><head><title>About</title></head><body>
              <h1 id="about-h1">About us</h1>
              <p>The about page.</p>
            </body></html>
          HTML
        else
          [404, {}, ['nope']]
        end
      }
    }.to_app
  }

  let(:session) { Capybara::Session.new(:simulated_v3, app) }

  it 'visits a page and finds elements via Capybara DSL' do
    session.visit '/'
    expect(session).to have_text('Welcome')
    expect(session).to have_css('h1', text: 'Welcome')
    expect(session).to have_no_text('not present')
    expect(session.title).to eq('Index')
  end

  it 'reads attributes and lists' do
    session.visit '/'
    expect(session.find('#about-link')[:href]).to eq('/about')
    expect(session.all('li').map(&:text)).to eq(%w[One Two Three])
  end

  it 'follows a link click and navigates' do
    session.visit '/'
    session.click_link 'About'
    expect(session.current_path).to eq('/about')
    expect(session).to have_css('#about-h1', text: 'About us')
  end

  it 'resets between sessions' do
    session.visit '/'
    expect(session).to have_text('Welcome')
    session.reset!
    expect(session.title).to eq('')
    session.visit '/about'
    expect(session.title).to eq('About')
  end
end
