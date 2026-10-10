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
    env = {'CSIM_V8_FLAGS' => 'expose-gc', 'CSIM_SNAPSHOT_CACHE' => 'off'}
    out, status = Open3.capture2e(env, RbConfig.ruby, '-rbundler/setup', '-Ilib', '-e', script, chdir: File.expand_path('..', __dir__))
    expect([status.success?, out.lines.last&.chomp]).to eq([true, 'true']), out[-2000..]
  end
end
