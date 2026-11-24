// Stand-in extraction worker for pool tests: answers every job with a stub
// result except the path 'crash.ts', which takes the whole thread down so the
// test can watch the pool reject that one job, respawn and keep serving.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (msg) => {
  if (msg.path === 'crash.ts') process.exit(3);
  parentPort.postMessage({ type: 'result', path: msg.path, extracted: { path: msg.path, ok: true } });
});
