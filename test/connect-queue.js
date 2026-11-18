// Testes da fila de conexao (limite de Chromium subindo ao mesmo tempo).
const assert = require('assert');
const { ConnectQueue } = require('../src/core/connect-queue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1) limite de concorrencia
  const q = new ConnectQueue({ maxConcurrent: 2, minGapMs: 0 });
  await q.acquire();
  await q.acquire();
  assert.strictEqual(q.active, 2, 'duas vagas deveriam estar ocupadas');

  let thirdEntered = false;
  const third = q.acquire().then(() => { thirdEntered = true; });
  await sleep(150);
  assert.strictEqual(thirdEntered, false, 'a terceira conexao passou do limite');
  assert.strictEqual(q.pending, 1, 'a terceira conexao deveria estar na fila');

  q.release();
  await third;
  assert.strictEqual(thirdEntered, true, 'a vaga liberada nao acordou a fila');
  assert.strictEqual(q.active, 2, 'a vaga liberada deveria ser ocupada');
  console.log('ok - fila de conexao: respeita o limite e libera a vaga');

  // 2) intervalo minimo entre inicios
  const q2 = new ConnectQueue({ maxConcurrent: 3, minGapMs: 200 });
  const t0 = Date.now();
  await q2.acquire();
  await q2.acquire();
  const gap = Date.now() - t0;
  assert.ok(gap >= 180, `intervalo minimo nao respeitado (${gap}ms)`);
  console.log('ok - fila de conexao: espaca os inicios');

  // 3) release defensivo
  const q3 = new ConnectQueue({ maxConcurrent: 2 });
  q3.release();
  assert.strictEqual(q3.active, 0, 'release sem acquire nao pode ficar negativo');
  console.log('ok - fila de conexao: release defensivo');

  assert.strictEqual(new ConnectQueue({ maxConcurrent: 0 }).maxConcurrent, 1, 'minimo de 1 vaga');
  console.log('ok - fila de conexao: nunca fica com zero vagas');

  console.log('TODOS OS TESTES DA FILA PASSARAM');
})().catch((e) => {
  console.error('FALHOU:', e && e.stack ? e.stack : e);
  process.exit(1);
});
