import { parentPort, workerData } from 'node:worker_threads';
import { type SearchJob, searchFiles } from './search.ts';

try {
    parentPort?.postMessage({ result: searchFiles(workerData as SearchJob) });
} catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
