# frozen_string_literal: true

# A small Hotwire-shaped Rack app the bench drives. Designed to surface
# the same operations a real Rails+Turbo+Stimulus suite hits — POST→
# redirect→render, Turbo Frame fetch+swap, Turbo Stream append/replace/
# remove, Stimulus action wiring — without depending on Rails or a DB.
#
# State is per-process, reset at the start of each example via /__reset.

require 'json'

module Capybara
  module Simulated
    class BenchApp
      STIMULUS_UMD = File.expand_path('../spec/fixtures/hotwire/stimulus.umd.js', __dir__).freeze
      TURBO_UMD    = File.expand_path('../spec/fixtures/hotwire/turbo.umd.js',    __dir__).freeze

      def self.fixtures_present?
        File.exist?(STIMULUS_UMD) && File.exist?(TURBO_UMD)
      end

      def initialize
        reset!
      end

      def call(env)
        path   = env['PATH_INFO']
        method = env['REQUEST_METHOD']

        case [method, path]
        in ['GET',  '/__reset']                then [reset! && 200, html, ['ok']]
        in ['GET',  '/js/stimulus.umd.js']     then asset(STIMULUS_UMD)
        in ['GET',  '/js/turbo.umd.js']        then asset(TURBO_UMD)
        in ['GET',  '/']                       then page_index
        in ['GET',  '/items']                  then page_items
        in ['POST', '/items']                  then create_item(env)
        in ['POST', %r{\A/items/(\d+)/inc\z}]  then increment_item(::Regexp.last_match(1))
        in ['POST', %r{\A/items/(\d+)/del\z}]  then delete_item(::Regexp.last_match(1))
        in ['GET',  %r{\A/items/(\d+)/edit\z}] then frame_edit(::Regexp.last_match(1))
        in ['PATCH', %r{\A/items/(\d+)\z}]     then frame_update(env, ::Regexp.last_match(1))
        in ['GET',  '/profile']                then page_profile
        in ['POST', '/profile']                then save_profile(env)
        in ['GET',  '/widgets']                then page_widgets
        else [404, {'content-type' => 'text/plain'}, ['not found']]
        end
      end

      private

      def reset!
        @items = [{id: 1, label: 'apple',  count: 0},
                  {id: 2, label: 'banana', count: 0},
                  {id: 3, label: 'cherry', count: 0}]
        @next_id = 4
        @profile = {name: '', email: '', plan: 'free', terms: false}
        true
      end

      def asset(path)
        [200, {'content-type' => 'application/javascript'}, [File.read(path)]]
      end

      def html(extra = {}) = {'content-type' => 'text/html; charset=utf-8'}.merge(extra)
      def stream           = {'content-type' => 'text/vnd.turbo-stream.html; charset=utf-8'}

      def layout(body)
        <<~HTML
          <!doctype html><html><head>
            <meta name="csrf-token" content="x">
            <script src="/js/turbo.umd.js"></script>
            <script src="/js/stimulus.umd.js"></script>
          </head><body>
            <nav>
              <a href="/" id="nav-home">home</a>
              <a href="/items" id="nav-items">items</a>
              <a href="/profile" id="nav-profile">profile</a>
              <a href="/widgets" id="nav-widgets">widgets</a>
            </nav>
            #{body}
            <script>
              const { Application, Controller } = window.Stimulus;
              const app = window.__app || Application.start();
              window.__app = app;

              if (!app.controllers.find(c => c.identifier === 'counter')) {
                app.register('counter', class extends Controller {
                  static targets = ['out'];
                  connect() { this.n = 0; this.render(); }
                  inc()     { this.n += 1; this.render(); }
                  dec()     { this.n -= 1; this.render(); }
                  render()  { this.outTarget.textContent = String(this.n); }
                });
                app.register('toggle', class extends Controller {
                  static targets = ['panel'];
                  connect() { this.update(); }
                  flip()    { this.open = !this.open; this.update(); }
                  update()  { this.panelTarget.hidden = !this.open; }
                });
                app.register('echo', class extends Controller {
                  static targets = ['source', 'sink'];
                  copy() { this.sinkTarget.textContent = this.sourceTarget.value; }
                });
              }
            </script>
          </body></html>
        HTML
      end

      def page_index
        [200, html, [layout(<<~HTML)]]
          <h1 id="home">home</h1>
          <div data-controller="counter">
            <span data-counter-target="out" id="counter-out"></span>
            <button data-action="click->counter#inc" id="counter-inc">+</button>
            <button data-action="click->counter#dec" id="counter-dec">-</button>
          </div>
          <div data-controller="toggle">
            <button data-action="click->toggle#flip" id="toggle-btn">flip</button>
            <p data-toggle-target="panel" id="toggle-panel">hidden by default</p>
          </div>
          <div data-controller="echo">
            <input data-echo-target="source" id="echo-src">
            <button data-action="click->echo#copy" id="echo-btn">copy</button>
            <span data-echo-target="sink" id="echo-sink"></span>
          </div>
        HTML
      end

      def page_items
        rows = @items.map { item_row(it) }.join
        [200, html, [layout(<<~HTML)]]
          <h1 id="items-heading">items</h1>
          <form action="/items" method="post" id="new-item">
            <input name="label" id="new-label">
            <button type="submit" id="new-submit">add</button>
          </form>
          <ul id="items">
            #{rows}
          </ul>
        HTML
      end

      def item_row(item)
        <<~HTML
          <li id="item_#{item[:id]}" data-label="#{item[:label]}">
            <span class="label">#{item[:label]}</span>
            <span class="count" id="count_#{item[:id]}">#{item[:count]}</span>
            <a href="/items/#{item[:id]}/edit" data-turbo-frame="edit_#{item[:id]}" id="edit_link_#{item[:id]}">edit</a>
            <turbo-frame id="edit_#{item[:id]}"></turbo-frame>
            <form action="/items/#{item[:id]}/inc" method="post" data-turbo-stream>
              <button type="submit" id="inc_#{item[:id]}">+1</button>
            </form>
            <form action="/items/#{item[:id]}/del" method="post" data-turbo-stream>
              <button type="submit" id="del_#{item[:id]}">×</button>
            </form>
          </li>
        HTML
      end

      def create_item(env)
        params = parse(env)
        label  = params['label'].to_s
        return [302, {'location' => '/items'}, []] if label.empty?
        @items << {id: @next_id, label: label, count: 0}
        @next_id += 1
        if turbo_stream?(env)
          [200, stream, [<<~HTML]]
            <turbo-stream action="append" target="items">
              <template>#{item_row(@items.last)}</template>
            </turbo-stream>
            <turbo-stream action="update" target="new-label">
              <template></template>
            </turbo-stream>
          HTML
        else
          [302, {'location' => '/items'}, []]
        end
      end

      def increment_item(id)
        i = @items.find { it[:id] == id.to_i } or return [404, html, ['nope']]
        i[:count] += 1
        [200, stream, [<<~HTML]]
          <turbo-stream action="replace" target="count_#{i[:id]}">
            <template><span class="count" id="count_#{i[:id]}">#{i[:count]}</span></template>
          </turbo-stream>
        HTML
      end

      def delete_item(id)
        @items.reject! { it[:id] == id.to_i }
        [200, stream, [<<~HTML]]
          <turbo-stream action="remove" target="item_#{id}"></turbo-stream>
        HTML
      end

      def frame_edit(id)
        i = @items.find { it[:id] == id.to_i } or return [404, html, ['nope']]
        [200, html, [<<~HTML]]
          <turbo-frame id="edit_#{i[:id]}">
            <form action="/items/#{i[:id]}" method="post" id="edit_form_#{i[:id]}">
              <input type="hidden" name="_method" value="patch">
              <input name="label" value="#{i[:label]}" id="edit_label_#{i[:id]}">
              <button type="submit" id="edit_submit_#{i[:id]}">save</button>
            </form>
          </turbo-frame>
        HTML
      end

      def frame_update(env, id)
        params = parse(env)
        i = @items.find { it[:id] == id.to_i } or return [404, html, ['nope']]
        i[:label] = params['label'].to_s
        [200, html, [<<~HTML]]
          <turbo-frame id="edit_#{i[:id]}">
            <span class="label" id="edited_label_#{i[:id]}">#{i[:label]}</span>
          </turbo-frame>
        HTML
      end

      def page_profile
        [200, html, [layout(<<~HTML)]]
          <h1 id="profile-heading">profile</h1>
          <form action="/profile" method="post" id="profile-form">
            <input name="name"  id="p-name"  value="#{@profile[:name]}">
            <input name="email" id="p-email" value="#{@profile[:email]}">
            <select name="plan" id="p-plan">
              <option value="free" #{'selected' if @profile[:plan] == 'free'}>free</option>
              <option value="pro"  #{'selected' if @profile[:plan] == 'pro'}>pro</option>
              <option value="biz"  #{'selected' if @profile[:plan] == 'biz'}>biz</option>
            </select>
            <label><input type="checkbox" name="terms" id="p-terms" #{'checked' if @profile[:terms]}> accept</label>
            <button type="submit" id="p-save">save</button>
          </form>
          <pre id="saved">#{JSON.dump(@profile)}</pre>
        HTML
      end

      def save_profile(env)
        params = parse(env)
        @profile[:name]  = params['name'].to_s
        @profile[:email] = params['email'].to_s
        @profile[:plan]  = params['plan'].to_s if %w[free pro biz].include?(params['plan'])
        @profile[:terms] = params['terms'] == 'on'
        [302, {'location' => '/profile'}, []]
      end

      def page_widgets
        [200, html, [layout(<<~HTML)]]
          <h1 id="widgets-heading">widgets</h1>
          <details id="d1"><summary>more</summary><p id="d1-body">opened</p></details>
          <ul id="planets">
            <li>mercury</li><li>venus</li><li>earth</li><li>mars</li>
          </ul>
          <table id="grid">
            <tr><td>1</td><td>2</td></tr>
            <tr><td>3</td><td>4</td></tr>
          </table>
        HTML
      end

      def parse(env)
        body = env['rack.input'].read
        env['rack.input'].rewind if env['rack.input'].respond_to?(:rewind)
        URI.decode_www_form(body).to_h
      end

      def turbo_stream?(env)
        accept = env['HTTP_ACCEPT'].to_s
        accept.include?('text/vnd.turbo-stream.html')
      end
    end
  end
end
