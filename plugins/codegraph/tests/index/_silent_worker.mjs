// Stand-in extraction worker that takes a job and never answers, so tests can
// check the per-job timeout (the pool must reject the job and terminate it).
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ type: 'ready' });
parentPort.on('message', () => {
  /* never replies, stays alive */
});
