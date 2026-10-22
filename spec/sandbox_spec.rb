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

  # A frame's sandboxing is its container's `sandbox` attribute as each navigation of it BEGAN — a form submitted into
  # it, a link targeting it, its `src` set, its document's `location` set — whatever the attribute says by the time the
  # response is in; and a navigation its document makes of itself is sandboxed by its response's CSP too. Chrome's
  # figures, measured (the attribute set before the form / link navigation, after the `location` / `src` one — a blob:
  # URL's too, which the host hands back to the container's realm to navigate).
  let(:navigations) {
    b = '<!DOCTYPE html><meta charset="utf-8"><body><script>document.body.dataset.ran = "yes";' \
        'let ls; try { localStorage; ls = "ok"; } catch (e) { ls = e.name; }' \
        'parent.postMessage([location.search.slice(1), [self.origin, ls]], "*");</script></body>'
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <iframe name=f id=f sandbox="allow-same-origin" src="/plain"></iframe>
      <iframe name=g id=g src="/plain"></iframe>
      <iframe name=h id=h sandbox="allow-same-origin" src="/plain"></iframe>
      <iframe id=l src="/plain"></iframe>
      <iframe id=k src="/plain"></iframe>
      <iframe id=c src="/plain"></iframe>
      <iframe id=bg src="/plain"></iframe>
      <iframe id=bh sandbox="allow-same-origin" src="/plain"></iframe>
      <form id=ff target=f action="/b"><input name=form value=f></form>
      <form id=fg target=g action="/b"><input name=form value=g></form>
      <a id=link target=h href="/b?link">l</a>
      <script>
        window.R = {};
        addEventListener('message', (e) => { R[e.data[0]] = e.data[1]; });
        const [f, g, h, l, k, c, bg, bh] = ['f', 'g', 'h', 'l', 'k', 'c', 'bg', 'bh'].map((id) => document.getElementById(id));
        window.go = () => {
          f.setAttribute('sandbox', 'allow-same-origin allow-scripts');
          g.setAttribute('sandbox', 'allow-same-origin');
          h.setAttribute('sandbox', 'allow-same-origin allow-scripts');
          document.getElementById('ff').submit();
          document.getElementById('fg').submit();
          document.getElementById('link').click();
          l.contentWindow.location.href = '/b?location';
          l.setAttribute('sandbox', 'allow-same-origin');
          k.src = '/b?src';
          k.setAttribute('sandbox', 'allow-same-origin');
          c.contentWindow.location.href = '/b?csp';
          const blob = URL.createObjectURL(new Blob(
            ['<!DOCTYPE html><body><script>document.body.dataset.ran = "yes"<' + '/script></body>'], {type: 'text/html'}
          ));
          bg.contentWindow.location.href = blob;
          bg.setAttribute('sandbox', 'allow-same-origin');
          bh.contentWindow.location.href = blob;
          bh.setAttribute('sandbox', 'allow-same-origin allow-scripts');
        };
        window.ran = (id) => document.getElementById(id).contentDocument?.body?.dataset.ran ?? 'unread';
      </script>
    HTML
    lambda {|env|
      case env['PATH_INFO']
      when '/plain' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>plain</body>']]
      when '/b'
        headers = {'content-type' => 'text/html'}
        headers['content-security-policy'] = 'sandbox allow-scripts' if env['QUERY_STRING'] == 'csp'
        [200, headers, [b]]
      else [200, {'content-type' => 'text/html'}, [page]]
      end
    }
  }

  it 'sandboxes a frame as its container said when each navigation of it began, and by its response' do
    s = simulated_session(navigations)
    s.visit '/'
    s.execute_script('go()')
    got = poll_until { r = s.evaluate_script('R'); r if r.size == 5 }
    expect(%w[f g h l k].map {|id| s.evaluate_script("ran('#{id}')") }).to eq(%w[yes unread yes yes yes])
    blob = ->(id) { s.evaluate_script("document.getElementById('#{id}').contentDocument?.URL.startsWith('blob:')") }
    expect(poll_until { blob.('bg') && blob.('bh') }).to be(true)
    expect(%w[bg bh].map {|id| s.evaluate_script("ran('#{id}')") }).to eq(%w[yes unread])
    expect(got.keys).not_to include('form=g')
    expect(got['csp']).to eq(['null', 'SecurityError'])
  end

  # A fragment's `<noscript>` is markup where scripting is disabled for the context's node document — one with no
  # browsing context, a DOMParser's or a `createHTMLDocument` one's (Chrome, measured).
  it "parses a fragment's noscript as markup where its document has scripting disabled" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><p>x']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const parsed = new DOMParser().parseFromString('', 'text/html');
        parsed.body.innerHTML = '<noscript><b>x</b></noscript>';
        const made = document.implementation.createHTMLDocument('');
        made.body.insertAdjacentHTML('beforeend', '<noscript><b>x</b></noscript>');
        document.body.innerHTML = '<noscript><b>x</b></noscript>';
        return [parsed, made, document].map((d) => d.querySelector('noscript').children.length);
      })()
    JS
    expect(got).to eq([1, 1, 0])
  end

  # `allow-top-navigation-by-user-activation` lets a sandboxed document navigate its top-level traversable only with its
  # window's transient activation (HTML "allowed by sandboxing to navigate"): a script of its at load is refused — its
  # `open()` of the top by name null (Chrome, measured: `_top`'s) — a click is not.
  let(:top_navigation) {
    frame = '<!DOCTYPE html><body><a id=go target=top href="/landed">go</a>' \
            '<script>window.opened = open("/refused", "top") === null;</script></body>'
    lambda {|env|
      case env['PATH_INFO']
      when '/frame' then [200, {'content-type' => 'text/html'}, [frame]]
      when '/landed', '/refused' then [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><p id=at>#{env['PATH_INFO']}"]]
      else
        [200, {'content-type' => 'text/html'}, [
          '<!DOCTYPE html><script>name = "top"</script>' \
          '<iframe id=f sandbox="allow-scripts allow-same-origin allow-top-navigation-by-user-activation" src="/frame"></iframe>'
        ]]
      end
    }
  }

  it 'lets a document sandboxed but for top navigation by user activation navigate its top only once activated' do
    s = simulated_session(top_navigation)
    s.visit '/'
    s.within_frame('f') { expect(s.evaluate_script('window.opened')).to be(true) }
    expect(s.current_path).to eq('/')
    s.within_frame('f') { s.click_link 'go' }
    expect(s).to have_css('#at', text: '/landed')
  end

  # …and a form a frame's document submits, which the host navigates: as the container said when it was submitted —
  # not as it said when a navigation that made no document (a download) began.
  let(:submitting) {
    lambda {|env|
      case env['PATH_INFO']
      when '/form'
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><form id=form action="/b"><button name=btn value=1>send</button></form>']]
      when '/b' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><script>document.body.dataset.ran = "yes"</script>sent</body>']]
      when '/download' then [200, {'content-type' => 'text/plain', 'content-disposition' => 'attachment; filename=x.txt'}, ['x']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><iframe id=s src="/form"></iframe><iframe id=t src="/form"></iframe><iframe id=u src="/form"></iframe>']]
      end
    }
  }

  it 'sandboxes the document a form in a frame submits as its container said then' do
    s = simulated_session(submitting)
    s.visit '/'
    s.execute_script(<<~JS)
      const frame = document.getElementById('s');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.contentDocument.getElementById('form').submit();
      document.getElementById('t').setAttribute('sandbox', 'allow-same-origin');
    JS
    s.within_frame('t') { s.click_button 'send' }
    s.execute_script("document.getElementById('u').contentWindow.location.href = '/download'")
    s.evaluate_script('1')
    s.execute_script(<<~JS)
      const frame = document.getElementById('u');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.contentDocument.getElementById('form').submit();
    JS
    at = ->(id) { s.evaluate_script("new URL(document.getElementById('#{id}').contentDocument.URL).pathname") }
    expect(poll_until { %w[s t u].map(&at) if %w[s t u].all? {|id| at.(id) == '/b' } }).to eq(%w[/b /b /b])
    expect(%w[s t u].map {|id| s.evaluate_script("document.getElementById('#{id}').contentDocument.body.dataset.ran ?? 'no'") }).to eq(%w[no no no])
  end

  # Without `allow-popups` a sandboxed document opens no new window — `open()` returns null, a `_blank` link or form
  # navigates nothing ("the rules for choosing a navigable": none chosen) — and without `allow-forms` it submits no form
  # (HTML "submit" step 4). Chrome's figures, measured.
  let(:popups_and_forms) {
    blocked = '<form id=f action="/landed"><input name=x value=1></form><a id=l target=_blank href="/landed">l</a>' \
              '<script>window.opened = [open("/landed") === null, open("/landed", "other") === null];</script>'
    forms = '<form id=f action="/landed" target=_blank><input name=x value=1></form>' \
            '<form id=g action="/landed"><input name=y value=1></form>'
    lambda {|env|
      case env['PATH_INFO']
      when '/landed' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><p>landed']]
      else
        [200, {'content-type' => 'text/html'}, [
          "<!DOCTYPE html><iframe id=a sandbox='allow-scripts allow-same-origin' srcdoc='#{blocked}'></iframe>" \
          "<iframe id=b sandbox='allow-scripts allow-same-origin allow-forms' srcdoc='#{forms}'></iframe>"
        ]]
      end
    }
  }

  it 'opens no window without allow-popups and submits no form without allow-forms' do
    s = simulated_session(popups_and_forms)
    s.visit '/'
    windows = s.windows.size
    s.execute_script(<<~JS)
      const a = document.getElementById('a').contentDocument, b = document.getElementById('b').contentDocument;
      a.getElementById('l').click();
      a.getElementById('f').submit();
      b.getElementById('f').submit();
    JS
    expect(s.evaluate_script("document.getElementById('a').contentWindow.opened")).to eq([true, true])
    s.execute_script("document.getElementById('b').contentDocument.getElementById('g').submit()")
    path = ->(id) { s.evaluate_script("document.getElementById('#{id}').contentWindow.location.pathname") }
    expect(poll_until { path.('b') == '/landed' }).to be(true)
    expect([path.('a'), s.windows.size]).to eq(['srcdoc', windows])
  end

  # …and without `allow-modals` it shows no simple dialog (HTML "cannot show simple dialogs"): `alert` returns at once,
  # `confirm` false, `prompt` null — no modal handler asked (Chrome's figures, measured).
  it 'shows no dialog without allow-modals' do
    frame = "<script>window.got = [alert('a'), confirm('c'), prompt('p', 'd'), print()];</script>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><iframe sandbox='allow-scripts allow-same-origin' srcdoc=\"#{frame}\"></iframe>"]] })
    s.visit '/'
    expect(s.evaluate_script('frames[0].got')).to eq([nil, false, nil, nil])
  end

  # `open()` chooses an existing navigable before it would make one ("the rules for choosing a navigable"): a frame by
  # name, `_top`, `_parent` — navigated, its window returned — and none where the document's sandbox does not let it
  # navigate it: a sibling frame, the top without `allow-top-navigation` (Chrome's figures, measured). Whether a link or
  # a form may open a new window is its own document's sandbox's, wherever the script that activates it runs.
  let(:choosing) {
    sandboxed = "<iframe name=kid src='/plain'></iframe><script>window.got = [" \
                "open('/landed?sib', 'sib'), open('/landed?top', '_top'), open('/landed?parent', '_parent')" \
                "].map((w) => w === null); window.kid = open('/landed?kid', 'kid') === frames[0];</script>"
    lambda {|env|
      case env['PATH_INFO']
      when '/plain' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><p>plain']]
      when '/landed' then [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><p id=at>#{env['QUERY_STRING']}"]]
      else
        [200, {'content-type' => 'text/html'}, [
          "<!DOCTYPE html><iframe name=sib src='/plain'></iframe><iframe name=open src='/plain'></iframe>" \
          "<iframe id=box sandbox='allow-scripts allow-same-origin' srcdoc=\"#{sandboxed}\"></iframe>"
        ]]
      end
    }
  }

  it "chooses an existing navigable for open() as its sandbox lets it, and a link's popup by the link's document" do
    s = simulated_session(choosing)
    s.visit '/'
    windows = s.windows.size
    box = "document.getElementById('box').contentWindow"
    expect(s.evaluate_script("#{box}.got")).to eq([true, true, true])
    expect(s.evaluate_script("#{box}.kid")).to be(true)
    s.execute_script("open('/landed?open', 'open')")
    at = ->(doc) { s.evaluate_script("#{doc}?.querySelector('#at')?.textContent ?? null") }
    named = ->(name, within = 'document') { "#{within}.querySelector('iframe[name=#{name}]').contentDocument" }
    expect(poll_until { at.(named.('kid', "#{box}.document")) == 'kid' && at.(named.('open')) == 'open' }).to be(true)
    expect([at.(named.('sib')), s.current_path, s.windows.size]).to eq([nil, '/', windows])
    # (…a link the page makes in the sandboxed document opens nothing; one the sandboxed document made, moved into the
    # page, opens its window)
    s.execute_script(<<~JS)
      const frameDoc = document.getElementById('box').contentDocument;
      const into = document.createElement('a');
      into.href = '/landed?into'; into.target = '_blank';
      frameDoc.body.append(into);
      into.click();
      const out = frameDoc.createElement('a');
      out.href = '/landed?out'; out.target = '_blank';
      document.body.append(out);
      out.click();
    JS
    expect(poll_until { s.windows.size if s.windows.size > windows }).to eq(windows + 1)
    s.within_window(s.windows.last) { expect(s).to have_css('#at', text: 'out') }
  end

  # …and the driver's own submission of a form (`Node#submit`, `form.submit()`'s steps) is refused it as the page's is.
  it "refuses the driver's submission of a form in a document sandboxed against forms" do
    s = simulated_session(lambda {|env|
      headers = {'content-type' => 'text/html'}
      headers['content-security-policy'] = 'sandbox allow-scripts' if env['PATH_INFO'] == '/'
      [200, headers, ['<!DOCTYPE html><form action="/landed"><input name=x value=1></form>']]
    })
    s.visit '/'
    s.find('form').base.submit
    expect(s.current_path).to eq('/')
  end
end
