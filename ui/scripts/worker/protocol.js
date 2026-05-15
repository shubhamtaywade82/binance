// Message-type constants shared between the main thread and the script worker.
// Both directions are kept in one file so renaming a constant breaks the build on
// both sides simultaneously.

export const MSG = {
  // Main → Worker
  COMPILE_RUN: 'compile_run',
  BAR: 'bar',
  REMOVE: 'remove',
  SWEEP: 'sweep',
  WALK_FORWARD: 'walk_forward',
  // Worker → Main
  COMPILED: 'compiled',
  TICK: 'tick',
  ERROR: 'error',
  SWEEP_RESULT: 'sweep_result',
  WALK_FORWARD_RESULT: 'walk_forward_result',
};
