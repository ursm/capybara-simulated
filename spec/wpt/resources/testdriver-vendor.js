// In-process WPT gate: no automation backend; testdriver.js is self-contained.
//
// Vendor overrides for testdriver_internal hooks the in-process driver CAN
// answer. `get_computed_label` is the accessible-name computation: for the
// aria-element-reflection tests it is driven entirely by aria-labelledby /
// ariaLabelledByElements, so we implement that branch (the IDL getter already
// drops references that are out of scope, so only valid labels contribute).
(function () {
  if (!window.test_driver) return;

  function accessibleLabel(element) {
    if (!element) return '';
    // aria-labelledby / ariaLabelledByElements: the accessible name is the
    // space-joined text ("name from content") of the valid referenced elements.
    const refs = element.ariaLabelledByElements;
    if (refs && refs.length) {
      return Array.from(refs)
        .map(r => ((r.innerText != null ? r.innerText : r.textContent) || '').trim())
        .filter(Boolean)
        .join(' ');
    }
    const ariaLabel = element.getAttribute && element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    return '';
  }

  window.test_driver.get_computed_label = function (element) {
    return Promise.resolve(accessibleLabel(element));
  };
})();
