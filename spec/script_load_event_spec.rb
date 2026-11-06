# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What a script's `load` event and its document's wait for. HTML "prepare the script element": a dynamically inserted script,
# a module's too, is on a list its document's `load` waits for ("the end"), and "from an external file" is decided as it is
# prepared, not by the `src` it has as it runs ("execute the script element"). Chrome 157 and Firefox 159 agree on every
# shape here (~/.local/share/csim-bench/js/jsu/p2.browsers.txt).
RSpec.describe 'a script element' do
  include PollUntil

  let(:session) {
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/page'      then [200, {'content-type' => 'text/html'}, [page_body]]
      when '/log.js'    then [200, {'content-type' => 'text/javascript'}, ["L.push('run')"]]
      when '/log.mjs'   then [200, {'content-type' => 'text/javascript'}, ["L.push('run')"]]
      when '/gone.js'   then [200, {'content-type' => 'text/javascript'}, ["L.push('run'); document.getElementById('me').removeAttribute('src')"]]
      when '/gone.mjs'  then [200, {'content-type' => 'text/javascript'}, ["L.push('run'); document.getElementById('me').removeAttribute('src')"]]
      when '/moved.js'  then [200, {'content-type' => 'text/javascript'}, ["L.push('run'); document.getElementById('me').setAttribute('src', '/other.js')"]]
      when '/other.js'  then [200, {'content-type' => 'text/javascript'}, ["L.push('other')"]]
      when '/blank'     then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><title>blank</title>']]
      else [404, {'content-type' => 'text/plain'}, ['']]
      end
    })
  }
  let(:recorder) { "<script>window.L = []; addEventListener('load', () => L.push('window load'));</script>" }

  def inserted(setup, after = '')
    <<~HTML
      <script>{
        const s = document.createElement('script');
        s.id = 'me';
        #{setup};
        s.onload = () => L.push('load');
        s.onerror = () => L.push('error');
        document.head.append(s);
        #{after};
        L.push('inserted');
      }</script>
    HTML
  end

  def log_of(body)
    @page_body = "<!DOCTYPE html><meta charset=utf-8><body>#{recorder}#{body}"
    session.visit('/page')
    expect(poll_until { session.evaluate_script("L.includes('window load')") }).to be(true)
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 20))')
    session.evaluate_script('L')
  end
  attr_reader :page_body

  describe "its document's load" do
    it 'waits for a dynamic module script, and the load of it' do
      expect(log_of(inserted("s.type = 'module'; s.src = '/log.mjs'"))).to eq(['inserted', 'run', 'load', 'window load'])
    end

    it 'waits for a dynamic inline module script, which fires none' do
      expect(log_of(inserted(%(s.type = 'module'; s.textContent = "L.push('run')")))).to eq(['inserted', 'run', 'window load'])
    end

    it 'waits for a dynamic classic script, async or not' do
      expect(log_of(inserted("s.src = '/log.js'"))).to eq(['inserted', 'run', 'load', 'window load'])
      expect(log_of(inserted("s.src = '/log.js'; s.async = false"))).to eq(['inserted', 'run', 'load', 'window load'])
    end

    # (…however long the chain: HTML "the end" spins until the lists are empty; both browsers wait for all 14)
    %w[classic module].each do |kind|
      it "waits for a chain of 14 dynamic #{kind} scripts, each its last one's `load`'s" do
        setup = kind == 'module' ? "s.type = 'module'; s.src = '/log.mjs?' + n" : "s.src = '/log.js?' + n"
        log = log_of(<<~HTML)
          <script>
            let n = 0;
            const go = () => { if (n++ < 14) { const s = document.createElement('script'); #{setup}; s.onload = () => { L.push('load'); go(); }; document.head.append(s); } };
            go();
          </script>
        HTML
        expect(log.last).to eq('window load')
        expect(log.count('run')).to eq(14)
      end
    end

    # (…the preparation-time document's load, past already: its parent's waits for none of it. Chrome and Firefox.)
    it "does not wait for a script its frame's load handler put in the frame's document" do
      module_script = "const s = d.createElement('script'); s.type = 'module'; s.src = '/log.mjs'"
      classic_script = "const s = document.createElement('script'); s.src = '/log.js'"
      [module_script, classic_script].each do |made|
        log = log_of(<<~HTML)
          <script>
            const f = document.createElement('iframe');
            f.src = '/blank';
            f.onload = () => {
              L.push('frame load');
              const d = f.contentDocument;
              f.contentWindow.L = L;
              #{made};
              s.onload = () => L.push('load');
              d.head.append(s);
            };
            document.body.append(f);
          </script>
        HTML
        expect(poll_until { session.evaluate_script("L.includes('load')") }).to be(true)
        log = session.evaluate_script('L')
        expect(log).to eq(['frame load', 'window load', 'run', 'load'])
      end
    end
  end

  describe 'from an external file, as it was prepared' do
    it 'fires load though a parser-inserted script took its own src away' do
      body = %(<script id=me src=/gone.js onload="L.push('load')"></script>)
      expect(log_of(body)).to eq(['run', 'load', 'window load'])
    end

    it 'fires load though a dynamic script took its own src away' do
      expect(log_of(inserted("s.src = '/gone.js'"))).to eq(['inserted', 'run', 'load', 'window load'])
    end

    it 'fires load though a parser-inserted module took its own src away' do
      body = %(<script id=me type=module src=/gone.mjs onload="L.push('load')"></script>)
      expect(log_of(body)).to eq(['run', 'load', 'window load'])
    end

    it 'fires load though a dynamic module took its own src away' do
      expect(log_of(inserted("s.type = 'module'; s.src = '/gone.mjs'"))).to eq(['inserted', 'run', 'load', 'window load'])
    end

    it 'runs what it was prepared with though its src was removed before its task' do
      expect(log_of(inserted("s.src = '/log.js'", "s.removeAttribute('src')"))).to eq(['inserted', 'run', 'load', 'window load'])
      expect(log_of(inserted("s.type = 'module'; s.src = '/log.mjs'", "s.removeAttribute('src')"))).to eq(['inserted', 'run', 'load', 'window load'])
    end

    it 'runs what it was prepared with though its src was changed before its task' do
      expect(log_of(inserted("s.type = 'module'; s.src = '/log.mjs'", "s.src = '/other.js'"))).to eq(['inserted', 'run', 'load', 'window load'])
    end

    # (…"Let source text be el's child text content", as it is prepared: both browsers run A)
    it 'runs the text an inline dynamic module had as it was prepared' do
      expect(log_of(inserted(%(s.type = 'module'; s.textContent = "L.push('A')"), %(s.textContent = "L.push('B')")))).to eq(['inserted', 'A', 'window load'])
    end

    # (…"execute the script element" step 2: its preparation-time document no longer its node document, it returns. Chrome no
    # event, Firefox an `error`.)
    %w[classic module].each do |kind|
      it "runs nothing of a dynamic #{kind} script moved to another document before its task, and fires nothing" do
        setup = kind == 'module' ? "s.type = 'module'; s.src = '/log.mjs'" : "s.src = '/log.js'"
        body = "<iframe id=f></iframe>#{inserted(setup, "document.getElementById('f').contentDocument.head.append(s)")}"
        expect(log_of(body)).to eq(['inserted', 'window load'])
      end
    end

    it 'runs nothing again for a src it set as it ran' do
      expect(log_of(inserted("s.src = '/moved.js'"))).to eq(['inserted', 'run', 'load', 'window load'])
    end

    it 'fires none for an inline script given a src as it ran' do
      body = %(<script id=me onload="L.push('load')">L.push('run'); document.getElementById('me').setAttribute('src', '/other.js');</script>)
      expect(log_of(body)).to eq(['run', 'window load'])
    end
  end
end
