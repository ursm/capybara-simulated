// The flags of an element's own steps that no attribute carries — the engine's (element_flags.rs,
// `NodeData::element_flags`), one bit each.
// A `<select>` has a `<selectedcontent>` it keeps mirroring its selection (custom-elements.js).
export const SELECT_HAS_SELECTED_CONTENT   = 1 << 0;
// A select or a selectedcontent was connected before: its re-insertion re-snapshots.
export const EVER_CONNECTED                = 1 << 1;
// A select's selectedcontent update is running, which an update it causes waits out.
export const SELECT_IN_UPDATE              = 1 << 2;
// A `<form>` is constructing its entry list (HTML §4.10.21.4): a submission meanwhile does nothing.
export const FORM_CONSTRUCTING_ENTRY_LIST  = 1 << 3;
// …is firing its submission events (§4.10.21.3 step 6): an interactive submission nested in them does nothing.
export const FORM_FIRING_SUBMISSION_EVENTS = 1 << 4;
// …is locked for reset (§4.10.22): a reset nested in its `reset` event does nothing.
export const FORM_LOCKED_FOR_RESET         = 1 << 5;
// A `<style>` has queued its `load` (HTML "update a style block"): once.
export const STYLE_LOAD_FIRED              = 1 << 6;

export const elementFlag = (el, flag) => (globalThis.__dom.elementFlags(el._nid) & flag) !== 0;
export const setElementFlag = (el, flag, on) => globalThis.__dom.setElementFlags(el._nid, flag, on ? flag : 0);
