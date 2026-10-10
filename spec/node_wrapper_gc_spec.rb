require 'open3'
require 'rbconfig'

# A node object V8 DROPS young (src/v8_shim.cc, node_handle.rs `csim_node_reset_root`): the droppable reference its handle
# held it by is cleared — a bare `NodeBase` wrapper, held, dropped by a minor collection, and then more of them. The
# handler once cleared the wrong memory and left V8's zapped reference behind, which crashed the next scavenge. Run in a
# process of its own: `--expose-gc` must be set before the first isolate.
RSpec.describe 'Node wrappers dropped young' do
  it 'clears the reference a scavenge dropped, and goes on' do
    script = <<~'RUBY'
      require 'capybara/simulated'
      app = ->(_) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body><p id=p>x</p>']] }
      s = Capybara::Session.new(:simulated, app)
      s.visit '/'
      puts s.evaluate_script(<<~JS)
        (() => {
          for (let round = 0; round < 5; round++) {
            let a = []; for (let i = 0; i < 5000; i++) a.push(new __dom.NodeBase());
            __dom.holdObjects(a); a = null; gc({type: 'minor'});
          }
          gc({type: 'minor'}); gc();
          return document.getElementById('p').textContent;
        })()
      JS
    RUBY
    env = {'CSIM_V8_FLAGS' => 'expose-gc', 'CSIM_SNAPSHOT_CACHE' => 'off'}
    out, status = Open3.capture2e(env, RbConfig.ruby, '-Ilib', '-e', script, chdir: File.expand_path('..', __dir__))
    expect([status.success?, out.lines.last&.chomp]).to eq([true, 'x']), out[-2000..]
  end
end
