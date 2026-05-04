require_relative 'spec_helper'

RSpec.describe 'importmap + ES modules' do
  let(:app) {
    lambda do |env|
      case env['PATH_INFO']
      when '/'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head>
            <script type="importmap">
            {
              "imports": {
                "greeter": "/js/greeter.js",
                "utils/": "/js/utils/"
              }
            }
            </script>
          </head><body>
            <div id="out"></div>
            <script type="module">
              import { greet } from "greeter";
              import { upper } from "utils/string.js";
              document.getElementById('out').textContent = upper(greet('Daisy'));
            </script>
          </body></html>
        HTML
      when '/js/greeter.js'
        [200, {'content-type' => 'application/javascript'}, [<<~JS]]
          import { exclaim } from "./helpers.js"
          export function greet(name) { return exclaim('Hello, ' + name) }
        JS
      when '/js/helpers.js'
        [200, {'content-type' => 'application/javascript'}, [<<~JS]]
          export function exclaim(s) { return s + '!' }
        JS
      when '/js/utils/string.js'
        [200, {'content-type' => 'application/javascript'}, [<<~JS]]
          export const upper = (s) => s.toUpperCase()
        JS
      else
        [404, {}, ['nope']]
      end
    end
  }

  let(:driver) { Capybara::Simulated::Driver.new(app) }

  it 'resolves bare specifiers via the importmap and runs module entries' do
    driver.visit('/')
    expect(driver.find_css('#out').first.all_text).to eq('HELLO, DAISY!')
  end

  it 'follows trailing-slash importmap entries' do
    driver.visit('/')
    expect(driver.evaluate_script('document.getElementById("out").textContent')).to eq('HELLO, DAISY!')
  end
end
