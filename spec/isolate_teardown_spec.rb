# frozen_string_literal: true

# A weak handle dropped with the isolate's slots frees what V8's teardown GC then calls back into: a process crash as a
# Context is finalized, at whichever session the allocator has reused that memory by (dom.rs `impl Drop for Dom`). What catches
# it is a list of some 23 sessions under `MALLOC_PERTURB_` (~/.local/share/csim-bench/js/jsu/pert3.sh, 18 s; shorter lists, and
# a loop forcing GC, survived a build with the fix reverted). This is the cheap part of that, and holds less: every field of
# `Dom` directly of a weak handle is one its Drop lets go of whole, a struct holding one its own to check.
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
