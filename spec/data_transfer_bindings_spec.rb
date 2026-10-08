# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# DataTransfer, DataTransferItemList and DataTransferItem, generated from their IDL over one drag data store (HTML
# §6.11.3). The figures are headless Chrome's, but where the spec decides: a second string item of a type is a
# NotSupportedError and an item's type is ASCII-lowercased (Chrome adds `TEXT/PLAIN` beside `text/plain`), the item list
# and an item are the same object each time ([SameObject]; "the same object must be returned" — Chrome makes new ones),
# and effectAllowed takes a value in a script's own (read/write) DataTransfer (Chrome keeps "none").
RSpec.describe 'DataTransfer bindings' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const dt = new DataTransfer();
        dt.setData('Text', 'a');
        dt.setData('URL', 'http://x/\\nhttp://y/');
        const types = dt.types;
        const out = [
          [types, dt.getData('text/plain'), dt.getData('url'), dt.getData('text/uri-list'), types === dt.types, Object.isFrozen(types)],
          error(() => dt.items.add('b', 'TEXT/PLAIN')),
          error(() => dt.items.add('b')),
          error(() => dt.items.add({})),
          error(() => dt.setDragImage()),
          error(() => dt.setDragImage({}, 0, 0)),
          error(() => new DataTransferItem()),
          error(() => new DataTransferItemList())
        ];
        const file = dt.items.add(new File(['x'], 'f.TXT', {type: 'Text/Plain'}));
        out.push([file.kind, file.type, dt.types, dt.files.length, dt.items[2] === dt.items[2], dt.items === dt.items, dt.files === dt.files]);
        dt.clearData();
        out.push([dt.types, dt.items.length]);
        const removed = dt.items[0];
        dt.items.remove(5);
        dt.items.remove(0);
        out.push([removed.kind, removed.type, removed.getAsFile(), dt.items.length]);
        dt.dropEffect = 'bogus';
        const dropBefore = dt.dropEffect;
        dt.dropEffect = 'move';
        dt.effectAllowed = 'bogus';
        const allowedBefore = dt.effectAllowed;
        dt.effectAllowed = 'copyMove';
        out.push([dropBefore, dt.dropEffect, allowedBefore, dt.effectAllowed]);
        out.push(Object.getOwnPropertyNames(DataTransferItemList.prototype).sort());
        out.push([Object.getOwnPropertyDescriptor(dt.items, '5'), Object.hasOwn(dt.items, 5), Object.keys(dt.items)]);
        return out;
      })()
    JS
    expect(got).to eq([
      [['text/plain', 'text/uri-list'], 'a', 'http://x/', "http://x/\nhttp://y/", true, true],
      "NotSupportedError: Failed to execute 'add' on 'DataTransferItemList': An item already exists for type 'text/plain'.",
      "TypeError: Failed to execute 'add' on 'DataTransferItemList': parameter 1 is not of type 'File'.",
      "TypeError: Failed to execute 'add' on 'DataTransferItemList': parameter 1 is not of type 'File'.",
      "TypeError: Failed to execute 'setDragImage' on 'DataTransfer': 3 arguments required, but only 0 present.",
      "TypeError: Failed to execute 'setDragImage' on 'DataTransfer': parameter 1 is not of type 'Element'.",
      "TypeError: Failed to construct 'DataTransferItem': Illegal constructor",
      "TypeError: Failed to construct 'DataTransferItemList': Illegal constructor",
      ['file', 'text/plain', ['text/plain', 'text/uri-list', 'Files'], 1, true, true, true],
      [['Files'], 1],
      ['', '', nil, 0],
      ['none', 'move', 'none', 'copyMove'],
      %w[add clear constructor length remove],
      [nil, false, []]
    ])
  end

  # getAsString() calls back in a task, not synchronously; getAsFile() is a new File of the item's data.
  it 'reads an item as the spec says' do
    session.execute_script(<<~JS)
      window.got = [];
      const dt = new DataTransfer();
      const text = dt.items.add('zz', 'text/x');
      let sync = true;
      text.getAsString((s) => window.got.push([s, sync]));
      sync = false;
      const file = new File(['abc'], 'a.txt', {type: 'text/plain'});
      const item = dt.items.add(file);
      window.got.push([item.getAsFile() === file, item.getAsFile().name, item.getAsFile().size, text.getAsFile()]);
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 2 && window.got') }).to eq([
      [false, 'a.txt', 3, nil],
      ['zz', false]
    ])
  end

  # `files` is live: a FileList read before an item is added lists it, and an input given it follows a clear (Chrome).
  it 'keeps its FileList live' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const dt = new DataTransfer(), input = document.createElement('input');
        input.type = 'file';
        dt.items.add(new File(['a'], 'a'));
        const list = dt.files;
        dt.items.add(new File(['b'], 'b'));
        const added = list.length;
        input.files = dt.files;
        dt.items.clear();
        return [added, list === dt.files, input.files.length];
      })()
    JS
    expect(got).to eq([2, true, 0])
  end
end
