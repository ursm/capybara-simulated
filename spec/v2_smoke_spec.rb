require 'capybara/simulated'
require 'rack'

RSpec.describe 'Simulated V2 (Nokogiri + QuickJS) — Phase 1 smoke' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        case env['PATH_INFO']
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

  let(:session) { Capybara::Session.new(:simulated_v2, app) }

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
