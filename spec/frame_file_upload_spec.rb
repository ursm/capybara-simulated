require 'capybara/simulated'
require 'tempfile'
require_relative 'support/session_teardown'

# A file `attach_file` picks inside a frame is read as one picked on the top page is: its pick is kept by the frame
# element's handle, whatever number type the frame's handle arrives as.
RSpec.describe 'attach_file in a frame' do
  let(:file) {
    f = Tempfile.new(['pick', '.txt'])
    f.write('picked bytes')
    f.flush
    f
  }
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/inner'
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><input type=file id=fu>']]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><iframe src="/inner"></iframe>']]
      end
    end
  }
  let(:session) { simulated_session(app) }

  it 'reads its bytes, and a slice of them' do
    session.visit '/'
    got = session.within_frame(session.find('iframe')) do
      session.attach_file('fu', file.path)
      session.evaluate_async_script(<<~JS)
        const done = arguments[0], f = document.getElementById('fu').files[0];
        Promise.all([f.text(), f.slice(0, 6).text()]).then(done);
      JS
    end
    expect(got).to eq(['picked bytes', 'picked'])
  end
end
