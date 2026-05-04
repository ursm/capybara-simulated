require_relative 'spec_helper'

RSpec.describe 'capybara-simulated smoke', type: :feature do
  let(:app) {
    lambda do |env|
      req = Rack::Request.new(env)
      case req.path_info
      when '/'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html>
          <html>
            <body>
              <h1 id="greeting">Hello</h1>
              <form action="/echo" method="post">
                <input name="msg" id="msg" />
                <button type="submit" id="go">Go</button>
              </form>
              <div id="js-target"></div>
              <script>
                document.getElementById('js-target').textContent = 'set-by-script';
                document.getElementById('msg').addEventListener('input', (e) => {
                  document.getElementById('greeting').textContent = 'Hello, ' + e.target.value;
                });
              </script>
            </body>
          </html>
        HTML
      when '/echo'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html>
          <html><body>
            <p id="echo">You sent: #{req.params['msg']}</p>
          </body></html>
        HTML
      else
        [404, {}, ['nope']]
      end
    end
  }

  let(:driver) { Capybara::Simulated::Driver.new(app) }

  it 'visits the page and exposes the static HTML' do
    driver.visit('/')
    expect(driver.find_css('#greeting').first.all_text).to eq('Hello')
  end

  it 'runs inline <script> against the linkedom DOM' do
    driver.visit('/')
    expect(driver.find_css('#js-target').first.all_text).to eq('set-by-script')
  end

  it 'reflects input events from JS handlers when set is used' do
    driver.visit('/')
    driver.find_css('#msg').first.set('Daisy')
    expect(driver.find_css('#greeting').first.all_text).to eq('Hello, Daisy')
  end

  it 'submits a form and follows the response' do
    driver.visit('/')
    driver.find_css('#msg').first.set('simulated')
    driver.find_css('#go').first.click
    expect(driver.find_css('#echo').first.all_text).to eq('You sent: simulated')
  end

  it 'evaluates user JS in the same realm' do
    driver.visit('/')
    expect(driver.evaluate_script('document.getElementById("greeting").tagName')).to eq('H1')
  end
end

RSpec.describe 'XPath via wgxpath' do
  let(:app) {
    lambda {|env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <a href="/x" id="link1">Click <em>me</em></a>
          <button>Save</button>
          <input type="text" id="name" placeholder="Your name">
        </body></html>
      HTML
    }
  }
  let(:driver) { Capybara::Simulated::Driver.new(app) }

  it 'matches by normalize-space text' do
    driver.visit('/')
    nodes = driver.find_xpath(".//a[normalize-space(.)='Click me']")
    expect(nodes.size).to eq(1)
    expect(nodes.first.tag_name).to eq('a')
  end

  it 'matches by contains()' do
    driver.visit('/')
    nodes = driver.find_xpath(".//button[contains(., 'Sav')]")
    expect(nodes.size).to eq(1)
    expect(nodes.first.all_text).to eq('Save')
  end

  it 'evaluates an attribute-based XPath' do
    driver.visit('/')
    nodes = driver.find_xpath(".//input[@placeholder='Your name']")
    expect(nodes.size).to eq(1)
    expect(nodes.first[:id]).to eq('name')
  end
end
