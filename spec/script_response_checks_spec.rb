require 'capybara/simulated'
require 'digest'
require 'base64'
require_relative 'support/session_teardown'

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
end
