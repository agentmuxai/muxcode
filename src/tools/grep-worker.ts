// Runs the JS Grep fallback off the main thread. A model-supplied regex can
// backtrack catastrophically, and JavaScript can't interrupt a running match:
// on the main thread that would freeze the whole CLI, Ctrl+C included. In a
// worker, the main thread stays free and terminates the worker on a timeout or
// an interrupt.
import { parentPort, workerData } from 'worker_threads';
import { grepJs, type GrepOptions } from './grep.js';

grepJs(workerData as GrepOptions).then(
  lines => parentPort!.postMessage({ ok: true, lines }),
  (err: Error) => parentPort!.postMessage({ ok: false, message: err.message }),
);
