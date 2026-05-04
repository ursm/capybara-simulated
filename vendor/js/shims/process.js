// Minimal `process` global shim used by some happy-dom code paths.
const processStub = {
  env: {NODE_ENV: 'production'},
  platform: 'browser',
  version: 'v20.0.0',
  versions: {node: '20.0.0'},
  nextTick: (cb, ...args) => Promise.resolve().then(() => cb(...args)),
  cwd: () => '/',
  argv: [],
  stdout: {write: () => true},
  stderr: {write: () => true},
  on: () => {},
  once: () => {},
  off: () => {}
};

export default processStub;
