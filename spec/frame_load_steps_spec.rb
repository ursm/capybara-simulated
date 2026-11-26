require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame's navigation steps — asking its document, its build, its `load` — are the engine's (frame_navigation.rs
# `LoadRun`), and so is the walk that aborts a document's descendants (unload_walks.rs `abortNext`).
RSpec.describe "a frame's navigation steps" do
  let(:app) {
    lambda do |env|
      body = case env['PATH_INFO']
             when '/' then '<!doctype html><meta charset=utf-8><body><script>var log = [];</script><iframe id=a src="/child"></iframe>'
             when '/child'
               <<~HTML
                 <!doctype html><meta charset=utf-8>
                 <script>addEventListener('beforeunload', () => parent.log.push('bu')); addEventListener('unload', () => parent.log.push('unload'));</script>
               HTML
             else '<!doctype html><meta charset=utf-8>x'
             end
      [200, {'content-type' => 'text/html'}, [body]]
    end
  }
  let(:session) { simulated_session(app) }

  before { session.visit 'http://www.example.com/' }

  # Each navigation's task asks the document while it still is the frame's, however many later ones superseded it (HTML
  # "navigate" asks, and only then looks whether it is still the ongoing one) — not as many as the engine happens to keep.
  it 'asks the document once for each of many navigations begun in one task' do
    session.execute_script(<<~JS)
      for (let i = 0; i < 12; i++) a.src = '/n' + i;
      a.addEventListener('load', () => log.push('load:' + a.contentWindow.location.pathname));
    JS
    expect(poll_until { session.evaluate_script('log').last }).to eq('load:/n11')
    expect(session.evaluate_script('log')).to eq([*['bu'] * 12, 'unload', 'load:/n11'])
  end

  # HTML "abort a document and its descendants": its descendant navigables in tree order, each one's document aborted in
  # that order. Chrome 157 and Firefox 159 abort in the order the frames were made (measured 2026-11-26: `b` inserted
  # before `a` → `abort:a,abort:b`); the spec's explicit list order is kept over them.
  it 'aborts the requests of its frames in tree order' do
    session.execute_script(<<~JS)
      const b = document.createElement('iframe'); b.id = 'b'; b.src = '/c';
      document.body.insertBefore(b, a);
    JS
    poll_until { session.evaluate_script("b.contentDocument && b.contentDocument.URL.endsWith('/c')") }
    session.execute_script(<<~JS)
      for (const id of ['a', 'b']) {
        const x = new (document.getElementById(id).contentWindow.XMLHttpRequest)();
        x.open('GET', '/slow?' + id);
        x.onabort = () => log.push('abort:' + id);
        x.send();
      }
      window.stop();
    JS
    expect(poll_until { session.evaluate_script('log').grep(/abort/).size == 2 && session.evaluate_script('log').grep(/abort/) }).to eq(%w[abort:b abort:a])
  end

  # A navigation of a frame whose navigable a handler of the document it asked destroyed — its beforeunload removing the
  # frame above it — makes no document: HTML "navigate" commits none for a destroyed navigable, and Chrome runs none.
  it 'makes no document for a frame whose beforeunload removed the frame above it' do
    session.execute_script(<<~JS)
      a.srcdoc = `<iframe srcdoc="<script>addEventListener('beforeunload', () => { top.log.push('bu'); top.a.remove(); })<\\/script>"></iframe>`;
    JS
    poll_until { session.evaluate_script("a.contentDocument && a.contentDocument.querySelector('iframe') && a.contentDocument.querySelector('iframe').contentDocument.readyState == 'complete'") }
    session.execute_script("a.contentDocument.querySelector('iframe').srcdoc = '<script>top.log.push(\"ran\")<\\/script>'")
    poll_until { session.evaluate_script('window.length') == 0 }
    sleep 0.2
    # (…`a`'s first document, `/child`, asked and unloaded as the srcdoc replaced it; then the grandchild asked — and
    # nothing of the document it was navigating to)
    expect(session.evaluate_script('[log, window.length]')).to eq([%w[bu unload bu], 0])
  end
end
