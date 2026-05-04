// Injected as a global so direct `process.env` references resolve without
// each module having to `import process from 'process'`.
import process from './process.js';
export {process};
