/**
 * Worker script for parallel per-position career model training.
 * Receives training rows + options via workerData, trains a single position,
 * returns the result via parentPort.
 */
import { workerData, parentPort } from 'worker_threads';
import { trainRookieCareerModels } from './rookieCareerModel';

const { rows, position, postDraft } = workerData as {
  rows: any[];
  position: string;
  postDraft: boolean;
};

const result = trainRookieCareerModels(rows, {
  onlyPositions: [position],
  postDraft,
});

parentPort?.postMessage(result);
