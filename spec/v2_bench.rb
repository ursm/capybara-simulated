require 'capybara/simulated'
require 'rack'

def time
  s = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  yield
  Process.clock_gettime(Process::CLOCK_MONOTONIC) - s
end

def app_for(html_body)
  Rack::Builder.new {
    run lambda {|env|
      case Rack::Request.new(env).path_info
      when '/'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>Index</title></head><body>
            #{html_body}
          </body></html>
        HTML
      when '/about'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>About</title></head><body><h1>About</h1></body></html>
        HTML
      else
        [404, {}, ['nope']]
      end
    }
  }.to_app
end

ITER = (ARGV[0] || 200).to_i

scenarios = {
  'no-script + visit/find' => [
    app_for(<<~HTML),
      <h1>Welcome</h1>
      <a id="about" href="/about">About</a>
    HTML
    ->(s) {
      s.visit '/'
      s.find('h1')
      s.click_link 'About'
      s.find('h1')
    }
  ],
  'script + visit/find (no events fired)' => [
    app_for(<<~HTML),
      <h1>Welcome</h1>
      <script> globalThis.x = 1; </script>
    HTML
    ->(s) {
      s.visit '/'
      s.find('h1')
    }
  ],
  'fill_in + click_button (events on)' => [
    app_for(<<~HTML),
      <form action="/about" method="get">
        <label for="name">Name</label>
        <input type="text" id="name" name="name" value="">
        <button type="submit" id="save">Save</button>
      </form>
      <script>
        document.querySelector('#name').addEventListener('input', e => {
          document.querySelector('#save').textContent = 'Save (' + e.target.value.length + ')';
        });
      </script>
    HTML
    ->(s) {
      s.visit '/'
      s.fill_in 'Name', with: 'Alice'
      s.click_button 'Save'
    }
  ]
}

scenarios.each do |label, (app, workflow)|
  puts "── #{label} ─────────────────"
  [%i[v1 simulated], %i[v2 simulated_v2]].each do |name, driver|
    s = Capybara::Session.new(driver, app)
    workflow.call(s)  # warm
    t = time { ITER.times { workflow.call(s) } }
    per = (t / ITER) * 1000
    puts "  %-3s %4d iters in %5.2fs  (%6.2f ms/iter)" % [name, ITER, t, per]
  end
end
