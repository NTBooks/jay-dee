// Embedding provider: local transformers.js (default) or OpenRouter.
import path from 'node:path';
import { config } from '../config.mjs';
import { log } from '../util/log.mjs';

let _local = null;

async function localEmbedder() {
  if (_local) return _local;
  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = path.join(config.dataDir, 'models');
  tf.env.allowLocalModels = true;
  log.info(`loading embedding model ${config.embed.model} (first run downloads ~130 MB into data/models)`);
  const pipe = await tf.pipeline('feature-extraction', config.embed.model, { dtype: 'fp32' });
  _local = {
    name: `local:${config.embed.model}`,
    async embed(texts) {
      const out = await pipe(texts, { pooling: 'cls', normalize: true });
      const dims = out.dims[1];
      const data = out.data;
      const vecs = [];
      for (let i = 0; i < texts.length; i++) vecs.push(Float32Array.from(data.subarray(i * dims, (i + 1) * dims)));
      if (out.dispose) out.dispose();
      return vecs;
    },
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  };
  return _local;
}

async function openrouterEmbedder() {
  const { embedTexts } = await import('../llm/openrouter.mjs');
  return {
    name: `openrouter:${config.embed.openrouterModel}`,
    async embed(texts) {
      const vecs = await embedTexts(texts);
      return vecs.map(normalize);
    },
    queryPrefix: '',
  };
}

function normalize(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export async function getEmbedder() {
  return config.embed.provider === 'openrouter' ? openrouterEmbedder() : localEmbedder();
}
