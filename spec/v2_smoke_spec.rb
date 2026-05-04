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

  it 'mutates the DOM from inline JS and the changes show up via Capybara' do
    mut_app = Rack::Builder.new {
      run lambda {|env|
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <h1 id="title">old</h1>
            <ul id="list"><li id="first">One</li></ul>
            <input id="name" value="">
            <input id="terms" type="checkbox">
            <button id="add" class="btn">Add</button>
            <div id="rich"></div>
            <script>
              document.querySelector('#title').textContent = 'new';

              const ul = document.querySelector('#list');
              const li = document.createElement('li');
              li.textContent = 'Two';
              ul.appendChild(li);

              const li3 = document.createElement('li');
              li3.id = 'third';
              li3.textContent = 'Three';
              ul.insertBefore(li3, document.querySelector('#first'));

              document.querySelector('#name').value   = 'alice';
              document.querySelector('#terms').checked = true;

              const btn = document.querySelector('#add');
              btn.setAttribute('data-count', '5');
              btn.classList.add('primary', 'big');
              btn.classList.remove('big');
              btn.classList.toggle('on');

              document.querySelector('#rich').innerHTML = '<span class="tag">hi</span>';
            </script>
          </body></html>
        HTML
      }
    }.to_app
    s = Capybara::Session.new(:simulated_v2, mut_app)
    s.visit '/'
    expect(s.find('#title').text).to eq('new')
    expect(s.all('#list li').map(&:text)).to eq(%w[Three One Two])
    expect(s.find('#name').value).to eq('alice')
    expect(s.evaluate_script("document.querySelector('#terms').checked")).to be true
    expect(s.find('#add')['data-count']).to eq('5')
    expect(s.find('#add')['class'].split.sort).to eq(%w[btn on primary])
    expect(s.find('#rich .tag').text).to eq('hi')
  end

  it 'dispatches click / submit / change events with bubbling and preventDefault' do
    ev_app = Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><body>
              <div id="log"></div>
              <a id="go" href="/about">Go</a>
              <a id="stay" href="/about">Stay</a>
              <form id="f" action="/submit" method="get">
                <input id="name" name="name" value="">
                <button id="save" type="submit">Save</button>
              </form>
              <script>
                const log = document.querySelector('#log');
                function append(t) { log.textContent = (log.textContent + ' ' + t).trim(); }
                document.body.addEventListener('click', () => append('body-click'));
                document.querySelector('#go').addEventListener('click', () => append('go-click'));
                document.querySelector('#stay').addEventListener('click', e => {
                  e.preventDefault();
                  append('stay-click');
                });
                document.querySelector('#name').addEventListener('input',  () => append('input'));
                document.querySelector('#name').addEventListener('change', () => append('change'));
                document.querySelector('#f').addEventListener('submit', e => {
                  e.preventDefault();
                  append('submit-prevented');
                });
              </script>
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
    s = Capybara::Session.new(:simulated_v2, ev_app)

    s.visit '/'
    s.click_link 'Stay'
    expect(s.current_path).to eq('/')
    expect(s.find('#log').text).to eq('stay-click body-click')

    s.fill_in 'name', with: 'alice'
    expect(s.find('#log').text).to eq('stay-click body-click input change')

    s.click_button 'Save'
    expect(s.current_path).to eq('/')
    expect(s.find('#log').text).to include('submit-prevented')

    s.click_link 'Go'
    expect(s.current_path).to eq('/about')
    expect(s.title).to eq('About')
  end

  it 'drains setTimeout / setInterval / requestAnimationFrame on the virtual clock' do
    timer_app = Rack::Builder.new {
      run lambda {|env|
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <button id="b">Go</button>
            <div id="out">init</div>
            <div id="ticks">0</div>
            <script>
              const out   = document.querySelector('#out');
              const ticks = document.querySelector('#ticks');
              // Initial setTimeout(0) — must run after page load drain.
              setTimeout(() => { out.textContent = 'ready'; }, 0);

              document.querySelector('#b').addEventListener('click', () => {
                out.textContent = 'A';
                setTimeout(() => { out.textContent += 'B'; }, 50);
                setTimeout(() => { out.textContent += 'C'; }, 100);
                requestAnimationFrame(() => { out.textContent += 'R'; });

                let n = 0;
                const id = setInterval(() => {
                  n++;
                  ticks.textContent = String(n);
                  if (n >= 3) clearInterval(id);
                }, 30);
              });
            </script>
          </body></html>
        HTML
      }
    }.to_app
    s = Capybara::Session.new(:simulated_v2, timer_app)
    s.visit '/'
    expect(s.find('#out').text).to eq('ready')

    s.click_button 'Go'
    # Virtual clock order from t=0 click:
    #   t=16  raf  → 'AR'
    #   t=30  int  → ticks=1
    #   t=50  to50 → 'ARB'
    #   t=60  int  → ticks=2
    #   t=90  int  → ticks=3 (clears)
    #   t=100 to100→ 'ARBC'
    expect(s.find('#out').text).to eq('ARBC')
    expect(s.find('#ticks').text).to eq('3')
  end

  it 'delivers MutationObserver records for childList and attribute changes' do
    mo_app = Rack::Builder.new {
      run lambda {|env|
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <div id="root">
              <span id="badge" class="off"></span>
            </div>
            <button id="add">Add</button>
            <button id="flip">Flip</button>
            <div id="audit"></div>
            <script>
              const audit = document.querySelector('#audit');
              new MutationObserver(records => {
                for (const r of records) {
                  if (r.type === 'childList' && r.addedNodes.length) {
                    audit.textContent += '+child(' + r.addedNodes[0].id + ')';
                  } else if (r.type === 'attributes') {
                    audit.textContent += '+attr(' + r.attributeName + ':' + r.oldValue + ')';
                  }
                }
              }).observe(document.querySelector('#root'), {
                childList: true, subtree: true,
                attributes: true, attributeOldValue: true
              });

              document.querySelector('#add').addEventListener('click', () => {
                const el = document.createElement('span');
                el.id = 'leaf';
                document.querySelector('#root').appendChild(el);
              });
              document.querySelector('#flip').addEventListener('click', () => {
                document.querySelector('#badge').setAttribute('class', 'on');
              });
            </script>
          </body></html>
        HTML
      }
    }.to_app
    s = Capybara::Session.new(:simulated_v2, mo_app)
    s.visit '/'

    s.click_button 'Add'
    # `id:null` reflects real DOM semantics: oldValue is null when the
    # attribute didn't exist before — JS string-concat coerces it to 'null'.
    expect(s.find('#audit').text).to eq('+attr(id:null)+child(leaf)')

    s.click_button 'Flip'
    expect(s.find('#audit').text).to eq('+attr(id:null)+child(leaf)+attr(class:off)')
  end

  it 'upgrades custom elements on define and on later insertion' do
    ce_app = Rack::Builder.new {
      run lambda {|env|
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <my-card id="a"></my-card>
            <button id="add">Add</button>
            <button id="rm">Remove</button>
            <div id="dock"></div>
            <div id="log"></div>
            <script>
              const log = document.querySelector('#log');
              function append(t) { log.textContent = (log.textContent + ' ' + t).trim(); }

              class MyCard extends HTMLElement {
                connectedCallback()    { this.textContent = 'card'; append('connect:' + (this.id || '?')); }
                disconnectedCallback() { append('disconnect:' + (this.id || '?')); }
              }
              customElements.define('my-card', MyCard);

              document.querySelector('#add').addEventListener('click', () => {
                const el = document.createElement('my-card');
                el.id = 'b';
                document.querySelector('#dock').appendChild(el);
              });
              document.querySelector('#rm').addEventListener('click', () => {
                const el = document.querySelector('my-card#a');
                el.parentNode.removeChild(el);
              });
            </script>
          </body></html>
        HTML
      }
    }.to_app
    s = Capybara::Session.new(:simulated_v2, ce_app)
    s.visit '/'

    expect(s.find('#a').text).to eq('card')
    expect(s.find('#log').text).to eq('connect:a')

    s.click_button 'Add'
    expect(s.find('#b').text).to eq('card')
    expect(s.find('#log').text).to eq('connect:a connect:b')

    s.click_button 'Remove'
    expect(s.find('#log').text).to eq('connect:a connect:b disconnect:a')
  end

  it 'loads external <script src=...> through the same Rack app' do
    src_app = Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><body>
              <h1 id="t">init</h1>
              <script src="/lib.js"></script>
              <script>
                window.__cap_loaded = (typeof window.__libExports === 'object');
                if (window.__libExports) document.querySelector('#t').textContent = window.__libExports.greet('alice');
              </script>
            </body></html>
          HTML
        when '/lib.js'
          [200, {'content-type' => 'application/javascript'}, [<<~JS]]
            window.__libExports = {
              greet: function(name) { return 'hello ' + name; }
            };
          JS
        else
          [404, {}, ['nope']]
        end
      }
    }.to_app
    s = Capybara::Session.new(:simulated_v2, src_app)
    s.visit '/'
    expect(s.evaluate_script('window.__cap_loaded')).to be true
    expect(s.find('#t').text).to eq('hello alice')
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
