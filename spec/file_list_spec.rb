# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# FileList (File API §5.2): the platform's list of a file input's / a DataTransfer's files.
RSpec.describe 'FileList' do
  page = <<~HTML
    <!doctype html><meta charset="utf-8"><body>
    <form id="f"><input id="a" type="file"></form><input id="b" type="file">
    <script>
    window.selection = () => {
      const dt = new DataTransfer();
      dt.items.add(new File(['abc'], 'a.txt', {type: 'text/plain'}));
      return dt.files;
    };
    </script></body>
  HTML

  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit('/')
    s
  }

  # HTML: a file input's value set to '' empties its selected files — as a form's reset sets it, and as a type change
  # into filename mode does. They were kept (Chrome: 0 and 0).
  it "empties a file input's files on its form's reset and on a type change back to file" do
    expect(session.evaluate_script(<<~JS)).to eq([1, 0, 1, 0])
      (() => {
        const a = document.getElementById('a'), b = document.getElementById('b');
        a.files = selection();
        const before = a.files.length;
        document.getElementById('f').reset();
        b.files = selection();
        const kept = b.files.length;
        b.type = 'text';
        b.type = 'file';
        return [before, a.files.length, kept, b.files.length];
      })()
    JS
  end

  # A legacy platform object's own keys are its indices alone — its internal slots none of them.
  it 'has its indices for own keys' do
    expect(session.evaluate_script('Reflect.ownKeys(selection()).map(String)')).to eq(['0'])
  end

  # [Serializable]: a FileList posted to a worker arrives as a FileList of its Files. It arrived as a plain object.
  it 'arrives in a worker as a FileList' do
    session.execute_script(<<~JS)
      window.got = null;
      const w = new Worker(URL.createObjectURL(new Blob([
        "onmessage = async (e) => postMessage([Object.prototype.toString.call(e.data), e.data.length, await e.data[0].text()]);"
      ], {type: 'text/javascript'})));
      w.onmessage = (e) => { window.got = e.data; };
      w.postMessage(selection());
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq(['[object FileList]', 1, 'abc'])
  end
end
