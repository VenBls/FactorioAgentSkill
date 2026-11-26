import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBlueprintLibrary } from '../lib/index.mjs';
import { createFactorioAgentServer } from '../server.mjs';

const example = (name) => readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8');
const compact = JSON.parse(await example('compact-assembly.json'));
const book = await example('r12/robot-district-book.txt');

test('local HTTP workflow compiles, inspects, stores and retrieves revisions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'factorio-agent-api-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const server = createFactorioAgentServer({ library: createBlueprintLibrary(directory) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function get(path, expected = 200) {
    const response = await fetch(base + path);
    assert.equal(response.status, expected);
    return response;
  }
  async function api(path, body, expected = 200) {
    const response = await fetch(base + '/api/v1/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, expected);
    return response.json();
  }
  const metadata = await (await get('/openapi.json')).json();
  assert.equal(metadata.paths['/api/v1/designs'].post.operationId, 'designBlueprint');
  assert.equal(await (await get('/examples/compact-assembly.json')).text(), await example('compact-assembly.json'));
  assert.match(await (await get('/')).text(), /工作台/);
  const design = await api('designs', compact);
  assert.equal(design.inspection.entityCount, 6);
  assert.equal(design.production.imports['iron-plate'], 120);
  assert.equal(design.production.processes[0].installedCount, 1);
  const encoded = await api('blueprints/encode', { document: design.document });
  assert.equal(encoded.blueprint, design.blueprint);
  assert.deepEqual((await api('blueprints/decode', encoded)).document, design.document);
  assert.equal((await api('blueprints/inspect', { blueprint: book })).inspection.entries.length, 2);
  assert.equal((await api('production/analyze', JSON.parse(await example('r12-production.json')))).outputs['logistic-robot'], 12);
  const rail = await api('logistics/analyze', JSON.parse(await example('rail-logistics.json')));
  assert.equal(rail.stations[0].requiredTrackTiles, 36);
  assert.equal(rail.stations[1].buffers['iron-ore'].inboundAtOrBelow, 6_000);
  assert.equal(rail.stations[3].buffers['iron-plate'].outboundAtOrAbove, 3_600);

  assert.deepEqual(await (await get('/api/v1/library')).json(), { entries: [] });
  const input = { key: 'factory', blueprint: design.blueprint, tags: ['制造', '原版'] };
  const [first, duplicate] = await Promise.all([api('library', input), api('library', input)]);
  assert.equal(duplicate.entry.id, first.entry.id);
  assert.equal(duplicate.entry.createdAt, first.entry.createdAt);
  const second = await api('library', { key: 'factory', blueprint: book, tags: ['物流'] });
  assert.notEqual(second.entry.id, first.entry.id);
  assert.equal(second.entry.blueprints, 2);
  const list = await (await get('/api/v1/library?key=factory')).json();
  assert.equal(list.entries.length, 2);
  assert.equal(Object.hasOwn(list.entries[0], 'blueprint'), false);
  assert.equal((await (await get('/api/v1/library?q=' + encodeURIComponent('制造'))).json()).entries[0].id, first.entry.id);
  assert.equal((await (await get('/api/v1/library/' + first.entry.id)).json()).entry.blueprint, design.blueprint);
  assert.equal((await createBlueprintLibrary(directory).get(second.entry.id)).blueprint, book.trim());
  assert.equal((await api('library', { key: '../world', blueprint: book }, 400)).error.code, 'invalid_input');
  assert.equal((await api('library', { key: 'bad-data', blueprint: '0AAAAAAAA' }, 400)).error.code, 'invalid_input');
  assert.equal((await api('designs', {}, 400)).error.code, 'invalid_input');
  await get('/api/v1/library/' + 'f'.repeat(64), 404);
  await get('/api/v1/designs', 405);
  assert.equal((await fetch(base + '/api/v1/library', { headers: { Origin: 'https://example.com' } })).status, 403);
});
