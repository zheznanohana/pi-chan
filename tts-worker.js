const { parentPort, workerData } = require('worker_threads');
const engine = require('./tts-engine');
try {
  const result = workerData.voice === 'gpt-sovits-klee'
    ? engine.synthesizeGptSovits(workerData.text, workerData.options)
    : engine.synthesizeClone(workerData.text, workerData.options);
  parentPort.postMessage({ result });
} catch (error) { parentPort.postMessage({ error: error.message }); }
