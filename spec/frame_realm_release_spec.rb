require 'open3'
require 'rbconfig'

# A frame navigated away from takes its realm with it: what the engine keeps of a realm for the others to ask through —
# its arena object, which holds its `__dom` and so its whole global (`Dom.arenas`) — is held weakly, so nothing of the
# engine's keeps a realm a page left alive (a strong one kept every navigated frame's global and its document: ~4.7 MB
# a navigation, and all of a page's data). (A node of it a script keeps keeps it, as its prototypes are its.) Run in a process of its own: `--expose-gc` must be set before the first
# isolate.
RSpec.describe 'A frame realm navigated away from' do
  it 'is collected once the page is left' do
    script = <<~'RUBY'
      require 'capybara/simulated'
      app = ->(env) {
        body = env['PATH_INFO'] == '/' ? '<!doctype html><meta charset=utf-8><body><iframe id=f src="/f/0"></iframe>' : '<!doctype html><meta charset=utf-8><body><p>frame</p>'
        [200, {'content-type' => 'text/html'}, [body]]
      }
      s = Capybara::Session.new(:simulated, app)
      s.visit '/'
      s.within_frame('f') { s.has_text?('frame') }
      first = s.evaluate_script("document.getElementById('f').contentWindow.__dom.realmId")
      s.execute_script("document.getElementById('f').src = '/f/1'")
      s.within_frame('f') { s.has_text?('frame') }
      s.visit '/'
      puts s.evaluate_script("(() => { gc(); gc(); return __dom.arenaOf(#{first}) === undefined; })()")
    RUBY
    expect(run_collected(script)).to eq([true, 'true'])
  end

  # …with a timer pending — a far-future analytics one, an interval — whose handler the engine's timer list holds
  # (timers.rs): the list goes as its context is disposed (`discardRealm`), and the realm with it.
  it 'is collected once the page is left, though it had timers pending' do
    script = <<~'RUBY'
      require 'capybara/simulated'
      app = ->(env) {
        body = env['PATH_INFO'] == '/' ? '<!doctype html><meta charset=utf-8><body><iframe id=f src="/f/0"></iframe>' :
          '<!doctype html><meta charset=utf-8><body><p>frame</p><script>setTimeout(() => {}, 1e9); setInterval(() => {}, 1000)</script>'
        [200, {'content-type' => 'text/html'}, [body]]
      }
      s = Capybara::Session.new(:simulated, app)
      s.visit '/'
      s.within_frame('f') { s.has_text?('frame') }
      first = s.evaluate_script("document.getElementById('f').contentWindow.__dom.realmId")
      s.execute_script("document.getElementById('f').remove()")
      s.visit '/'
      puts s.evaluate_script("(() => { gc(); gc(); return __dom.arenaOf(#{first}) === undefined; })()")
    RUBY
    expect(run_collected(script)).to eq([true, 'true'])
  end

  # …and one its code, still called after its iframe is gone, gave a timer then — through a `setTimeout` it kept: a
  # disposed realm takes no timer outside a step of its own still running (timers.rs `takes_timers`).
  it 'is collected though its code added a timer after its iframe was removed' do
    script = <<~'RUBY'
      require 'capybara/simulated'
      app = ->(env) {
        body = env['PATH_INFO'] == '/' ? '<!doctype html><meta charset=utf-8><body><iframe id=f src="/f/0"></iframe>' :
          '<!doctype html><meta charset=utf-8><body><p>frame</p><script>const kept = setTimeout; ' \
          'window.go = () => { frameElement.remove(); try { kept(() => {}, 1e9); } catch (_) {} };</script>'
        [200, {'content-type' => 'text/html'}, [body]]
      }
      s = Capybara::Session.new(:simulated, app)
      s.visit '/'
      s.within_frame('f') { s.has_text?('frame') }
      first = s.evaluate_script("document.getElementById('f').contentWindow.__dom.realmId")
      s.execute_script("document.getElementById('f').contentWindow.go()")
      s.visit '/'
      puts s.evaluate_script("(() => { gc(); gc(); return __dom.arenaOf(#{first}) === undefined; })()")
    RUBY
    expect(run_collected(script)).to eq([true, 'true'])
  end

  def run_collected(script)
    env = {'CSIM_V8_FLAGS' => 'expose-gc', 'CSIM_SNAPSHOT_CACHE' => 'off'}
    out, status = Open3.capture2e(env, RbConfig.ruby, '-rbundler/setup', '-Ilib', '-e', script, chdir: File.expand_path('..', __dir__))
    [status.success?, out.lines.last&.chomp]
  end
end
