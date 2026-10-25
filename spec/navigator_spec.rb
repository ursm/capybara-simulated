# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The navigator (HTML §8.9.1): its plugins and MIME types none where no PDF is viewed inline (§8.9.1.6:
# `pdfViewerEnabled` false, every list empty, one object each), and an attribute whose answer is an object of its
# realm answered by the realm of the navigator it is asked of — "this's relevant global object's": a frame's getter
# called on the page's navigator gives the page's object (Chrome, Firefox), the page's called on a detached frame's the
# frame's (Chrome).
RSpec.describe 'navigator' do
  let(:session) do
    simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/f' ? '<!DOCTYPE html>f' : '<!DOCTYPE html><iframe src="/f"></iframe>']] })
  end

  it 'has no plugins and no MIME types where no PDF viewer is' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      [navigator.pdfViewerEnabled, navigator.plugins.length, navigator.mimeTypes.length, navigator.plugins === navigator.plugins,
       navigator.plugins.item(0), navigator.plugins[0], [...navigator.plugins].length, String(navigator.plugins), typeof Plugin, typeof MimeType]
    JS
    expect(got).to eq([false, 0, 0, true, nil, nil, 0, '[object PluginArray]', 'function', 'function'])
  end

  it 'answers an attribute by the realm of the navigator it is asked of' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const frame = frames[0].Navigator.prototype;
        return ['plugins', 'mimeTypes', 'userActivation', 'clipboard', 'permissions', 'locks', 'languages']
          .filter((n) => Object.getOwnPropertyDescriptor(frame, n).get.call(navigator) !== navigator[n]);
      })()
    JS
    expect(got).to eq([])
    # (…and a detached frame's navigator its own realm's, whichever realm's getter asks — Chrome)
    session.execute_script(<<~JS)
      window.fnav = frames[0].navigator;
      window.fplugins = fnav.plugins;
      document.querySelector('iframe').remove();
    JS
    expect(session.evaluate_script("Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins').get.call(fnav) === fplugins")).to be(true)
  end
end
