// Message-type constants shared between the main thread and the script worker.
// Both directions are kept in one file so renaming a constant breaks the build on
// both sides simultaneously.

export const MSG = {
  // Main → Worker
  COMPILE_RUN: 'compile_run',
  BAR: 'bar',
  REMOVE: 'remove',
  SWEEP: 'sweep',
  // Worker → Main
  COMPILED: 'compiled',
  TICK: 'tick',
  ERROR: 'error',
  SWEEP_RESULT: 'sweep_result',
};
