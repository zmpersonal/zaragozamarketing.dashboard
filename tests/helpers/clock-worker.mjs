import { parentPort, workerData } from 'node:worker_threads';
import { businessMinutes } from '../../src/lib/clock.ts';

parentPort.postMessage(businessMinutes(workerData.from, workerData.to));
