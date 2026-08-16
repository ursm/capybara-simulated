# frozen_string_literal: true

# The layout specs assert FORMULAS, not the pixel figures Chrome printed: those depend on
# which face fontconfig serves for Arial, the formulas don't, and it is the formula each
# file exists to pin. That means every one of them needs the same three things out of a
# page — the boxes under test, the width of a few strings in the same font, and the height
# of a plain one-line block — which is what this measures, in ONE pass over one session.
#
# `include LayoutMeasure` in the describe that wants it: `measure` is a general enough name
# that it has no business in every example group in the suite.
module LayoutMeasure
  # Lay `body` out and report `[boxes, text, line, session]`: the `[x, y, width, height]` of
  # each selector, a `Text` over the measured `probes`, the height of one line, and the
  # session itself, for an example that needs to ask the laid-out page something else (a hit
  # test, a client-rect list). The probes sit at the END of the body, so they add a line
  # below everything measured and disturb none of it.
  def measure(body, selectors, probes: [], bold_probes: [], style: 'margin:0;font:16px Arial')
    probe_markup = '<div id="__line">x</div><span id="__probe" style="white-space:pre"></span>'
    html    = %(<html><head><meta charset="utf-8"></head><body style="#{style}">#{body}#{probe_markup}</body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    js = <<~JS
      (function () {
        var probe = document.getElementById('__probe'), text = {};
        function widths(list, weight) {
          probe.style.fontWeight = weight;
          list.forEach(function (t) { probe.textContent = t; text[weight + ' ' + t] = probe.getBoundingClientRect().width; });
        }
        widths(#{probes.to_json}, 'normal');
        widths(#{bold_probes.to_json}, 'bold');
        probe.remove();
        return JSON.stringify({
          boxes: #{selectors.to_json}.map(function (sel) {
            var r = document.querySelector(sel).getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
          text: text,
          line: document.getElementById('__line').getBoundingClientRect().height
        });
      })()
    JS
    m = JSON.parse(session.evaluate_script(js))
    [m['boxes'], Text.new(m['text']), m['line'], session]
  end

  # The measured width of a string, and of the widest word in it (its min-content).
  Text = Struct.new(:table) do
    def [](s, weight = 'normal') = table.fetch("#{weight} #{s}")
    def word(s) = s.split.map {|w| self[w] }.max
  end
end
