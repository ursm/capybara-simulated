require 'capybara/simulated'
require 'rack'

RSpec.describe 'Simulated V2 (Nokogiri + QuickJS) — smoke' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        req = Rack::Request.new(env)
        case req.path_info
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
              <form action="/submit" method="post" id="profile-form">
                <label for="name">Name</label>
                <input type="text" id="name" name="name" value="">
                <label for="bio">Bio</label>
                <textarea id="bio" name="bio"></textarea>
                <fieldset>
                  <legend>Plan</legend>
                  <label><input type="radio" name="plan" value="free"> Free</label>
                  <label><input type="radio" name="plan" value="pro"> Pro</label>
                </fieldset>
                <label><input type="checkbox" name="terms" value="yes"> Accept</label>
                <label for="role">Role</label>
                <select id="role" name="role">
                  <option value="">Pick</option>
                  <option value="dev">Developer</option>
                  <option value="ops">Operator</option>
                </select>
                <button type="submit" id="save">Save</button>
              </form>
            </body></html>
          HTML
        when '/about'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><head><title>About</title></head><body>
              <h1 id="about-h1">About us</h1>
              <p>The about page.</p>
            </body></html>
          HTML
        when '/submit'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><head><title>Saved</title></head><body>
              <h1>Saved</h1>
              <pre id="r-name">#{req.params['name']}</pre>
              <pre id="r-bio">#{req.params['bio']}</pre>
              <pre id="r-plan">#{req.params['plan']}</pre>
              <pre id="r-terms">#{req.params['terms']}</pre>
              <pre id="r-role">#{req.params['role']}</pre>
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

  it 'runs inline <script> and reads DOM via the QuickJS bridge' do
    js_app = Rack::Builder.new {
      run lambda {|env|
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <h1 id="greeting">hello</h1>
            <ul>
              <li>One</li>
              <li>Two</li>
              <li>Three</li>
            </ul>
            <input id="name" value="alice">
            <script>
              globalThis.__title = document.querySelector('#greeting').textContent;
              globalThis.__items = document.querySelectorAll('li').map(li => li.textContent);
              globalThis.__name  = document.querySelector('#name').value;
              globalThis.__matches = document.querySelector('#name').matches('input#name');
            </script>
          </body></html>
        HTML
      }
    }.to_app
    s = Capybara::Session.new(:simulated_v2, js_app)
    s.visit '/'
    expect(s.evaluate_script('globalThis.__title')).to eq('hello')
    expect(s.evaluate_script('globalThis.__items')).to eq(%w[One Two Three])
    expect(s.evaluate_script('globalThis.__name')).to eq('alice')
    expect(s.evaluate_script('globalThis.__matches')).to be true
  end

  it 'fills inputs / textarea, picks radio + checkbox + select, and submits the form' do
    session.visit '/'
    session.fill_in 'Name', with: 'Daisy'
    session.fill_in 'Bio',  with: 'hello world'
    session.choose 'Pro'
    session.check 'Accept'
    session.select 'Operator', from: 'Role'
    session.click_button 'Save'

    expect(session.current_path).to eq('/submit')
    expect(session.find('#r-name').text).to eq('Daisy')
    expect(session.find('#r-bio').text).to  eq('hello world')
    expect(session.find('#r-plan').text).to eq('pro')
    expect(session.find('#r-terms').text).to eq('yes')
    expect(session.find('#r-role').text).to eq('ops')
  end
end
