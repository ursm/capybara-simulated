require 'capybara/simulated'
require 'digest'
require 'base64'
require 'cgi'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# A classic script's response is refused before it runs — its `error` event, no run — where Fetch's main fetch makes it
# a network error (script.rs `script_response_refused`): a MIME type no script is (`image/*` and the like), one that is
# no JavaScript MIME type under `X-Content-Type-Options: nosniff`, or a body its `integrity` metadata does not match.
# A plain text/plain one without nosniff runs. The same whether the parser or a script inserted the element.
RSpec.describe 'script response checks' do
  BODY = 'window.ran.push(document.currentScript.id)'.freeze

  def session
    sha = "sha256-#{Base64.strict_encode64(Digest::SHA256.digest(BODY))}"
    scripts = {
      'good'   => ['text/javascript', {}, sha],
      'bad'    => ['text/javascript', {}, 'sha256-AAAA'],
      'image'  => ['image/png', {}, nil],
      'sniff'  => ['text/plain', {'x-content-type-options' => 'nosniff'}, nil],
      'plain'  => ['text/plain', {}, nil]
    }
    tags = ->(prefix) { scripts.map {|name, (_, _, integrity)| %(<script id="#{prefix}#{name}" src="/#{name}.js"#{integrity ? %( integrity="#{integrity}") : ''} onerror="window.failed.push(this.id)"></script>) }.join }
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8>
      <script>window.ran = []; window.failed = [];</script>
      #{tags.call('p-')}
      <template id="dyn">#{tags.call('d-')}</template>
    HTML
    app = lambda do |env|
      name = env['PATH_INFO'][%r{\A/(\w+)\.js\z}, 1]
      next [200, {'content-type' => 'text/html'}, [page]] unless name

      type, headers, = scripts.fetch(name)
      [200, {'content-type' => type}.merge(headers), [BODY]]
    end
    simulated_session(app).tap {|s| s.visit '/' }
  end

  it 'runs the scripts Fetch lets through, the parser\'s and a script\'s alike' do
    s = session
    s.execute_script(<<~JS)
      for (const t of document.getElementById('dyn').content.querySelectorAll('script')) {
        const el = document.createElement('script');
        for (const a of t.attributes) el.setAttribute(a.name, a.value);
        el.onerror = () => window.failed.push(el.id);
        document.body.appendChild(el);
      }
    JS
    expect(s.evaluate_script('window.ran.slice().sort()')).to eq(%w[d-good d-plain p-good p-plain])
    expect(s.evaluate_script('window.failed.slice().sort()')).to eq(%w[d-bad d-image d-sniff p-bad p-image p-sniff])
  end

  # Integrity is a digest of the response's BYTES — a byte-order mark and a body in an encoding other than UTF-8
  # included, whatever its text came to — and an about:blank or srcdoc document's origin is its creator's, so a
  # same-origin script there is no opaque response. Chrome 155 runs each.
  it 'checks integrity against the bytes, and the origin a document has' do
    bodies = {
      'bom' => "\xEF\xBB\xBFwindow.ran.push('bom')".b,
      'latin' => "window.ran.push('latin'); window.e = '\xE9';".b,
      'framed' => "parent.ran.push('framed')".b
    }
    sri = bodies.transform_values {|b| "sha256-#{Base64.strict_encode64(Digest::SHA256.digest(b))}" }
    srcdoc = %(<script src="/framed.js" integrity="#{sri['framed']}" onerror="parent.failed.push('framed')"></script>)
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8>
      <script>window.ran = []; window.failed = [];</script>
      <script src="/bom.js" integrity="#{sri['bom']}" onerror="failed.push('bom')"></script>
      <script src="/latin.js" integrity="#{sri['latin']}" onerror="failed.push('latin')"></script>
      <iframe srcdoc="#{CGI.escapeHTML(srcdoc)}"></iframe>
    HTML
    app = lambda do |env|
      name = env['PATH_INFO'][%r{\A/(\w+)\.js\z}, 1]
      next [200, {'content-type' => 'text/html'}, [page]] unless name

      type = name == 'latin' ? 'text/javascript; charset=iso-8859-1' : 'text/javascript'
      [200, {'content-type' => type}, [bodies.fetch(name)]]
    end
    s = simulated_session(app).tap {|session| session.visit '/' }
    s.execute_script(<<~JS)
      const el = document.createElement('script');
      el.src = '/bom.js?again';
      el.integrity = #{sri['bom'].to_json};
      el.onerror = () => failed.push('bom again');
      document.body.appendChild(el);
    JS
    expect(s.evaluate_script('[ran.slice().sort(), failed, window.e]')).to eq([%w[bom bom framed latin], [], "\u00e9"])
  end
  # An opaque response is the one Fetch made — a no-cors request any hop of which left the document's origin (a
  # redirect's response tainting stays opaque) — whatever origin the script's URL is of: a same-origin URL redirected to
  # another origin fails its integrity, a CORS one there does not, and a cross-origin URL redirected back stays opaque.
  # (…the other origin served in-process)
  it 'fails the integrity of an opaque response, whatever origin its URL is of', :every_host_local do
    sha  = "sha256-#{Base64.strict_encode64(Digest::SHA256.digest(BODY))}"
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8>
      <script>window.ran = []; window.failed = [];</script>
      <script id="away" src="/away.js" integrity="#{sha}" onerror="failed.push(this.id)"></script>
      <script id="cors" src="/away.js?cors" crossorigin integrity="#{sha}" onerror="failed.push(this.id)"></script>
      <script id="back" src="http://other.example.com/back.js" integrity="#{sha}" onerror="failed.push(this.id)"></script>
    HTML
    app = lambda do |env|
      case [env['SERVER_NAME'], env['PATH_INFO']]
      in [/\Aother/, '/back.js'] then [302, {'location' => 'http://www.example.com/script.js'}, []]
      in [/\Aother/, _] then [200, {'content-type' => 'text/javascript', 'access-control-allow-origin' => '*'}, [BODY]]
      in [_, '/away.js'] then [302, {'location' => "http://other.example.com/script.js?#{env['QUERY_STRING']}"}, []]
      in [_, '/script.js'] then [200, {'content-type' => 'text/javascript'}, [BODY]]
      else [200, {'content-type' => 'text/html'}, [page]]
      end
    end
    s = simulated_session(app).tap {|session| session.visit '/' }
    expect(s.evaluate_script('[ran, failed.slice().sort()]')).to eq([%w[cors], %w[away back]])
  end
end
