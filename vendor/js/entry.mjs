// Bundle entry: brings happy-dom and an XPath engine into one IIFE that
// exposes them on a single `__csim_bundle` global. happy-dom does not
// implement document.evaluate, so we layer fontoxpath on top.
import {Window} from 'happy-dom';
import {URL, URLSearchParams} from 'whatwg-url';
import {evaluateXPathToNodes} from 'fontoxpath';

export {Window, URL, URLSearchParams, evaluateXPathToNodes};
