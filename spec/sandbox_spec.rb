# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A document's sandboxing flag set (HTML §7.6.5): its container's `sandbox` attribute, its response's CSP `sandbox` and
# its parent document's flags, which an about:blank popup it opens takes on unless it grants
# `allow-popups-to-escape-sandbox` (sandbox.rs, realm_location.rs `popup_origins`). Chrome's figures, measured.
RSpec.describe 'Sandboxing' do
  include PollUntil

  let(:popups) {
    child = <<~JS.gsub("\n", ' ')
      const r = [];
      const w = open();
      try { r.push(typeof w.document.title); } catch (e) { r.push(e.name); }
      if (r[0] === 'string') {
        r.push(w.eval('self.origin'));
        r.push(w.eval('(() => { try { return typeof localStorage; } catch (e) { return e.message; } })()'));
        r.push(w.eval('(() => { try { return typeof navigator.serviceWorker; } catch (e) { return e.message; } })()'));
      }
      w.close();
      parent.postMessage([LABEL, r], '*');
    JS
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8">
        <script>
          window.R = {};
          addEventListener('message', (e) => { R[e.data[0]] = e.data[1]; });
          const child = '<script>' + #{child.to_json} + '<\\/script>';
          const sandboxes = {
            '#propagated': 'allow-scripts allow-popups',
            '#escaped': 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
            '#same-origin': 'allow-scripts allow-popups allow-same-origin'
          };
          for (const [label, sandbox] of Object.entries(sandboxes)) {
            const f = document.createElement('iframe');
            f.setAttribute('sandbox', sandbox);
            f.srcdoc = child.replace('LABEL', JSON.stringify(label));
            document.documentElement.appendChild(f);
          }
        </script>
      HTML
    }
  }

  it "sandboxes a popup as its opener is unless it escapes, an escaped one's origin its opener's" do
    s = simulated_session(popups)
    s.visit '/'
    got = poll_until { r = s.evaluate_script('R'); r if r.size == 3 }
    expect(got['#propagated']).to eq(['SecurityError'])
    expect(got['#escaped']).to eq([
      'string',
      'null',
      "Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
      "Failed to read the 'serviceWorker' property from 'Navigator': Access to service workers is denied in this document origin."
    ])
    expect(got['#same-origin']).to eq(['string', 'http://www.example.com', 'object', 'object'])
  end
end
