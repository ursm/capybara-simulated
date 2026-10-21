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

  # A document sandboxed against scripts has scripting disabled (HTML "scripting is disabled"): its scripts do not run,
  # its event handler content attributes compile to nothing, a `javascript:` URL of its evaluates nothing, and its
  # `<noscript>` content is markup — the frame's container's attribute as its navigation began, not as it is when the
  # response comes in. Chrome's figures, measured, with the unsandboxed frame beside it.
  let(:scripts) {
    frame = <<~HTML.gsub("\n", '')
      <body><script>document.body.dataset.ran = 'yes'</script>
      <p id=p onclick="document.body.dataset.clicked = 'yes'">p</p>
      <noscript><b>no</b></noscript>
      <a id=a href="javascript:document.body.dataset.js = 'yes'">a</a></body>
    HTML
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8">
        <script>
          for (const [id, sandbox] of [['sandboxed', 'allow-same-origin'], ['scripted', null], ['switched', 'allow-same-origin']]) {
            const f = document.createElement('iframe');
            f.id = id;
            if (sandbox !== null) f.setAttribute('sandbox', sandbox);
            f.srcdoc = #{frame.to_json.gsub('</', '<\\/')};
            document.documentElement.appendChild(f);
            if (id === 'switched') f.setAttribute('sandbox', 'allow-same-origin allow-scripts');
          }
          window.report = (id) => {
            const d = document.getElementById(id).contentDocument;
            const onclick = d.getElementById('p').onclick === null;
            d.getElementById('p').click();
            d.getElementById('a').click();
            return [d.body.dataset.ran, onclick, d.body.dataset.clicked, d.querySelector('noscript').children.length];
          };
        </script>
      HTML
    }
  }

  it 'disables scripting in a document sandboxed against scripts, as its navigation began' do
    s = simulated_session(scripts)
    s.visit '/'
    expect(s.evaluate_script("report('sandboxed')")).to eq([nil, true, nil, 1])
    expect(s.evaluate_script("report('scripted')")).to eq(['yes', false, 'yes', 0])
    expect(s.evaluate_script("document.getElementById('scripted').contentDocument.body.dataset.js")).to eq('yes')
    expect(s.evaluate_script("document.getElementById('sandboxed').contentDocument.body.dataset.js")).to be_nil
    expect(s.evaluate_script("report('switched')")).to eq([nil, true, nil, 1])
  end
end
