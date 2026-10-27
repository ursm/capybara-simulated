// The host steps of the engine's own fetches (subresource-host.js `subresourceHost`), handed over by bridge.entry.js: a
// module that needs them reads them here, as an import of subresource-host.js would reorder the bundle's initialisers.
let host = null;
export const obtainHost = () => host;
export function setObtainHost(steps) {
  host = steps;
}
