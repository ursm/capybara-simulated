// Whether this realm's document is a child navigable's — a frame's — rather than a top-level traversable's (the page's, a
// window's): the engine's answer (navigables.rs `nested`), which never changes once the realm is its container's
// navigable's — a frame removed since is one still — so it is taken then, as the container's document links the realm
// (host-queries.js `linkFrameRealm`), before the realm's document loads, and read with no call after: a frameless
// page's dispatch asks it for every event.

import { dom } from './engine.js';
let nested = false;
export const realmNested = () => nested;
globalThis.__csimTakeNesting = () => { nested = dom.nested(); };
