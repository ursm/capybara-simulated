# frozen_string_literal: true

# A weak handle dropped with the isolate's slots frees what V8's teardown GC then calls back into: a process crash as a
# Context is finalized, at whichever session the allocator has reused that memory by (dom.rs `impl Drop for Dom`). When it
# crashes depends on the allocator, so no run of a page can hold this; what can is that every field of `Dom` holding a weak
# handle is one its Drop lets go of whole. (`clone_shadow_hooks` was not: 3 of 4 runs of a session list with an 8 MB
# `javascript:` document in a pop-up crashed.)
RSpec.describe 'Dom, as its isolate is torn down' do
  let(:source) { File.read(File.expand_path('../ext/csim_native/src/dom.rs', __dir__)) }

  def weak_fields
    fields = source[/pub\(crate\) struct Dom \{.*?^\}/m].scan(/^\s*pub\(crate\) (\w+): [^\n]*v8::Weak</).flatten
    expect(fields).not_to be_empty
    fields
  end

  it 'leaks every field holding a weak handle' do
    drop = source[/impl Drop for Dom \{.*?^\}/m]
    expect(weak_fields.reject {|field| drop.include?("self.#{field}") }).to eq([])
  end
end
