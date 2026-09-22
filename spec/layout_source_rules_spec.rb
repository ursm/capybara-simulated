# frozen_string_literal: true

# Rules about `layout.js` that hold over its SOURCE rather than over any page it lays out. A rule lands here
# when the thing it forbids is invisible from the outside — no geometry moves, no parity breaks, nothing
# declines — so no shape can be written that fails. Checking the text is then not a shortcut: it is the only
# instrument there is. (`layout_spec_escapes_spec` is the same idea aimed at the specs.)
RSpec.describe 'layout.js source rules' do
  SOURCE = File.read(File.expand_path('../lib/capybara/simulated/js/src/layout.js', __dir__))

  # The body of a top-level `function NAME(...) { … }`, by brace matching from its opening `{`. Good enough
  # for this file, where every function is at column 0 and no string or comment in one carries an unbalanced
  # brace — asserted below, because a matcher that silently ran off the end would make every rule vacuous.
  def body_of(name)
    start = SOURCE.index(/^function #{Regexp.escape(name)}\(/)
    raise "no top-level `function #{name}` in layout.js" unless start

    open = SOURCE.index('{', start)
    depth = 0
    SOURCE[open..].each_char.with_index do |c, i|
      depth += 1 if c == '{'
      depth -= 1 if c == '}'
      return SOURCE[open..(open + i)] if depth.zero?
    end
    raise "unbalanced braces from `function #{name}`"
  end

  it 'finds a function body and stops at its end' do
    b = body_of('shrinkWrapsToFit')
    expect(b).to include("_tag === 'button'")
    expect(b).not_to include('function ')
  end

  # `usedSize` computes a size and writes NOTHING. That is what lets `marginBasis` ask it about a box the
  # flow has not reached and may never lay out this pass — it walks a subtree deriving widths for margin
  # runs, and a stamp left on a box whose own layout never runs is a stamp no later layout corrects. The
  # stamp lives in `layoutSize`, which is the name a caller uses when it is actually PLACING the box.
  #
  # It was inside `usedSize` until 2026-09-22, and the flow covered for it by re-stamping every box it laid
  # out — every box except the ones in a REUSED subtree. Nothing observable came of it: the basis it wrote
  # was only read again through the walk's marshalling, and two engines that agree about a wrong basis agree.
  # Three shapes were built trying to make a page show the difference and none did, which is exactly why the
  # rule is checked here instead of there.
  it 'keeps `usedSize` free of stamps, so a query can ask it about a box the flow has not reached' do
    stamps = body_of('usedSize').scan(/^\s*\w+\._lb\w+\s*=[^=]/)
    expect(stamps).to be_empty, <<~MSG
      `usedSize` writes on the element:
      #{stamps.join("\n")}
      Put the write in `layoutSize` — the caller that is placing the box — and leave `usedSize` a question
      anyone may ask, including about a box that will not be laid out this pass.
    MSG
    # …and the stamp really is in `layoutSize`, so this rule cannot pass by the write having been deleted.
    expect(body_of('layoutSize')).to match(/_lbCbH\s*=\s*cbH/)
  end
end
