// Stand-in worker that announces readiness and dies at once, every time it is
// spawned: simulates an engine that initialises but crashes on the first job
// (e.g. a wasm trap in extractFile), so tests can check that the pool stops
// blaming files and escalates to a pool failure.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ type: 'ready' });
process.exit(7);
