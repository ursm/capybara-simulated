require_relative 'spec_helper'
require 'capybara/dsl'
require_relative 'support/session_teardown'

RSpec.describe 'Capybara DSL through simulated driver' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        req = Rack::Request.new(env)
        case req.path_info
        when '/'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html>
            <html><body>
              <h1>Welcome</h1>
              <a href="/about" id="about-link">About <em>us</em></a>
              <ul>
                <li>One</li>
                <li>Two</li>
                <li>Three</li>
              </ul>

              <form action="/profile" method="post" id="profile-form">
                <label for="name">Full name</label>
                <input type="text" id="name" name="name" />

                <label for="bio">Bio</label>
                <textarea id="bio" name="bio"></textarea>

                <fieldset>
                  <legend>Plan</legend>
                  <label><input type="radio" name="plan" value="free" id="plan-free"> Free</label>
                  <label><input type="radio" name="plan" value="pro" id="plan-pro"> Pro</label>
                </fieldset>

                <label><input type="checkbox" name="terms" value="yes" id="terms"> Accept</label>

                <label for="role">Role</label>
                <select id="role" name="role">
                  <option value="">Pick…</option>
                  <option value="dev">Developer</option>
                  <option value="ops">Operator</option>
                </select>

                <label for="tags">Tags</label>
                <select id="tags" name="tags[]" multiple>
                  <option value="ruby">Ruby</option>
                  <option value="js">JavaScript</option>
                  <option value="rust">Rust</option>
                </select>

                <button type="submit" id="save">Save</button>
              </form>

              <div id="modal-trigger-area">
                <button type="button" id="show-confirm" onclick="window.__lastConfirm = confirm('Really?')">Confirm</button>
                <button type="button" id="show-prompt"  onclick="window.__lastPrompt  = prompt('Name?')">Prompt</button>
              </div>

              <section id="counter">
                <p>Count: <span id="count">0</span></p>
                <button type="button" id="inc" onclick="
                  const n = document.getElementById('count');
                  n.textContent = String(parseInt(n.textContent, 10) + 1);
                ">+1</button>
              </section>

              <section id="hidden-area" style="display:none">
                <p id="secret">do not show</p>
              </section>
            </body></html>
          HTML
        when '/about'
          [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body><h1 id="about">About</h1></body></html>']]
        when '/profile'
          params = req.params
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><body>
              <h1>Saved</h1>
              <dl>
                <dt>Name</dt><dd id="r-name">#{params['name']}</dd>
                <dt>Bio</dt><dd id="r-bio">#{params['bio']}</dd>
                <dt>Plan</dt><dd id="r-plan">#{params['plan']}</dd>
                <dt>Terms</dt><dd id="r-terms">#{params['terms']}</dd>
                <dt>Role</dt><dd id="r-role">#{params['role']}</dd>
                <dt>Tags</dt><dd id="r-tags">#{Array(params['tags']).join(',')}</dd>
              </dl>
            </body></html>
          HTML
        else
          [404, {}, ['nope']]
        end
      }
    }.to_app
  }

  let(:session) { simulated_session(app) }

  it 'has_text? matches visible text' do
    session.visit('/')
    expect(session).to have_text('Welcome')
    expect(session).to have_no_text('do not show')
  end

  it 'find by id and visible_text' do
    session.visit('/')
    expect(session.find('#about-link').text).to eq('About us')
  end

  it 'click_link follows anchors' do
    session.visit('/')
    session.click_link('About us')
    expect(session).to have_css('h1#about')
    expect(session.current_path).to eq('/about')
  end

  it 'fill_in / click_button submits a form with all input types' do
    session.visit('/')
    session.fill_in('Full name', with: 'Daisy')
    session.fill_in('Bio',       with: 'hello world')
    session.choose('Pro')
    session.check('Accept')
    session.select('Operator', from: 'Role')
    session.select('Ruby',     from: 'Tags')
    session.select('Rust',     from: 'Tags')
    session.click_button('Save')

    expect(session.find('#r-name').text).to eq('Daisy')
    expect(session.find('#r-bio').text).to eq('hello world')
    expect(session.find('#r-plan').text).to eq('pro')
    expect(session.find('#r-terms').text).to eq('yes')
    expect(session.find('#r-role').text).to eq('ops')
    expect(session.find('#r-tags').text).to eq('ruby,rust')
  end

  it 'within scopes finds' do
    session.visit('/')
    session.within('ul') do
      expect(session).to have_css('li', count: 3)
      expect(session.first('li').text).to eq('One')
    end
  end

  it 'click on JS-only button updates the DOM' do
    session.visit('/')
    expect(session.find('#count').text).to eq('0')
    session.click_button('+1')
    expect(session.find('#count').text).to eq('1')
    3.times { session.click_button('+1') }
    expect(session.find('#count').text).to eq('4')
  end

  it 'accept_confirm captures and answers confirm()' do
    session.visit('/')
    msg = session.accept_confirm { session.click_button('Confirm') }
    expect(msg).to eq('Really?')
    expect(session.evaluate_script('window.__lastConfirm')).to eq(true)
  end

  it 'accept_prompt with :with answers prompt()' do
    session.visit('/')
    msg = session.accept_prompt(with: 'Daisy') { session.click_button('Prompt') }
    expect(msg).to eq('Name?')
    expect(session.evaluate_script('window.__lastPrompt')).to eq('Daisy')
  end

  it 'visible? hides display:none elements' do
    session.visit('/')
    expect(session).to have_no_text('do not show')
    expect(session.find('#secret', visible: :all).visible?).to eq(false)
  end

  it 'execute_script and evaluate_script are usable' do
    session.visit('/')
    session.execute_script('document.querySelector("#count").textContent = "42"')
    expect(session.find('#count').text).to eq('42')
    expect(session.evaluate_script('1 + 2')).to eq(3)
  end

  it 'go_back returns to the previous page' do
    session.visit('/')
    session.click_link('About us')
    expect(session.current_path).to eq('/about')
    session.go_back
    expect(session.current_path).to eq('/')
  end

  it 'reset! clears state between examples' do
    session.visit('/')
    session.fill_in('Full name', with: 'Daisy')
    session.driver.reset!
    session.visit('/')
    expect(session.find_field('Full name').value).to eq('')
  end
end
