# frozen_string_literal: true
# Reading a laid-out figure to hold against Chrome's, and pinning one that is known to differ from it.
module ChromeFigures
  # `#m`'s laid-out rectangle, `[x, y, width, height]`, on a fresh page of `body` — the figure a spec holds against
  # Chrome's. Asks the example group's own `page`, so it reads the document the golden reads.
  def laid_out_rect(body, id = 'm')
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script("(r => [r.x, r.y, r.width, r.height])(document.getElementById('#{id}').getBoundingClientRect())")
  end

  # A figure the layout gives and Chrome does not — recorded rather than fixed, and pinned so it cannot drift
  # unnoticed.
  #
  # Checked CHROME FIRST, and that order is the whole point of having one helper for it. Written inline, every
  # copy asserted the shared figure first and the Chrome tripwire second — so the day an engine moved onto
  # Chrome's number, the shared assertion failed with a message about a regression and the one that would have
  # said "this is a FIX, pin Chrome's number now" was never reached. Four copies had that order; none could fire.
  def expect_shared_gap(got, shared:, chrome:, what:)
    unless (shared - chrome).abs <= 0.05
      expect(got).not_to(
        be_within(0.05).of(chrome),
        "#{what}: #{got} now AGREES with Chrome (#{chrome}) — a fix, not a regression: pin it as Chrome's figure"
      )
    end
    expect(got).to be_within(0.05).of(shared), "#{what}: #{got}; the layout gave #{shared}, Chrome says #{chrome}"
  end
end

RSpec.configure {|c| c.include ChromeFigures }
