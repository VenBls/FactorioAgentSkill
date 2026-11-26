import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeBlueprint, encodeBlueprint, inspectBlueprint } from '../lib/blueprint.mjs';
import { analyzeProduction, designBlueprint } from '../lib/designer.mjs';

const r12 = new URL('../examples/r12/robot-district-integrated.txt', import.meta.url);

function pole(entity_number, x) {
  return { entity_number, name: 'medium-electric-pole', position: { x, y: 0.5 } };
}

test('R12 decodes and composes back into the complete original game document', () => {
  const source = readFileSync(r12, 'utf8');
  const document = decodeBlueprint(source);
  const { label, description, icons, version } = document.blueprint;
  const composition = designBlueprint({ label, description, icons, version, blocks: [{ id: 'r12', source }] });

  assert.deepEqual(decodeBlueprint(encodeBlueprint(document)), document);
  assert.deepEqual(decodeBlueprint(composition.blueprint), document);
  const inspection = inspectBlueprint(composition.blueprint);
  assert.equal(inspection.entityCount, 857);
  assert.equal(inspection.wireCount, 27);
  assert.equal(inspection.stations.length, 7);
  assert.equal(inspection.stations.at(-1).name, 'R12-07 出料｜物流机器人');
});

test('translation remaps local and cross-block wire references without mutating fragments', () => {
  const source = { blueprint: {
    entities: [pole(13, 0.5), pole(2, 4.5)],
    wires: [[13, 5, 2, 5]],
    tiles: [{ name: 'refined-concrete', position: { x: 0, y: 0 } }],
  } };
  const before = structuredClone(source);
  const { document } = designBlueprint({
    entities: [pole(1, 0.5)],
    blocks: [
      { id: 'a', source, offset: { x: 4, y: 0 } },
      { id: 'b', source, offset: { x: 12, y: 0 } },
    ],
    links: [
      { from: { entity: 1, connector: 5 }, to: { block: 'a', entity: 13, connector: 5 } },
      { from: { block: 'a', entity: 2, connector: 5 }, to: { block: 'b', entity: 13, connector: 5 } },
    ],
  });

  assert.deepEqual(source, before);
  assert.deepEqual(document.blueprint.entities.map(({ entity_number, position }) => [entity_number, position.x]),
    [[1, 0.5], [2, 4.5], [3, 8.5], [4, 12.5], [5, 16.5]]);
  assert.deepEqual(document.blueprint.wires, [[2, 5, 3, 5], [4, 5, 5, 5], [1, 5, 2, 5], [3, 5, 4, 5]]);
  assert.deepEqual(document.blueprint.tiles.map(({ position }) => position), [{ x: 4, y: 0 }, { x: 12, y: 0 }]);
  assert.throws(() => designBlueprint({ entities: [pole(1, 0.5)], wires: [[1, 5, 7, 5]] }), /unknown entity number 7/);
  assert.throws(() => designBlueprint({ blocks: [{ source, rotate: 90 }] }), /translation offset/);
});

test('target inference balances a shared producer and coproducts, and reports capacity separately', () => {
  const result = analyzeProduction({
    targets: { robot: 12, slag: 7 },
    processes: [
      { recipe: 'smelt', seconds: 1, speed: 1, ingredients: { ore: 3 }, products: { metal: 2, slag: 1 } },
      { recipe: 'robot', seconds: 5, speed: 1, count: 0, ingredients: { metal: 2, slag: 0.5 }, products: { robot: 1 } },
    ],
  });
  assert.deepEqual(result.outputs, { metal: 2, slag: 7, robot: 12 });
  assert.deepEqual(result.imports, { ore: 39 });
  assert.deepEqual(result.surplus, { metal: 2 });
  assert.deepEqual(result.targetShortfalls, {});
  assert.equal(result.processes[0].runsPerMinute, 13);
  assert.equal(result.processes[1].requiredCount, 1);
  assert.equal(result.processes[1].capacitySufficient, false);
  assert.equal(result.feasible, false);
});

test('target inference surfaces cycles and explicit rates permit a closed process loop', () => {
  const processes = [
    { recipe: 'regenerate', seconds: 1, speed: 1, ingredients: { spent: 1 }, products: { active: 1 } },
    { recipe: 'make-product', seconds: 1, speed: 1, ingredients: { active: 1 }, products: { product: 1, spent: 1 } },
  ];
  const targets = { product: 12 };
  assert.throws(() => analyzeProduction({ targets, processes }), /process cycle/);
  const verified = analyzeProduction({ targets, processes: processes.map((process) => ({ ...process, runsPerMinute: 12 })) });
  assert.equal(verified.feasible, true);
  assert.deepEqual(verified.outputs, { product: 12 });
  assert.deepEqual(verified.imports, {});
});

test('design counts matching machines and reports station name discrepancies', () => {
  const recipe = 'iron-gear-wheel';
  const machine = 'assembling-machine-2';
  const result = designBlueprint({
    entities: [
      { name: machine, recipe, position: { x: 1.5, y: 1.5 } },
      { name: 'train-stop', station: 'G01-02 入料｜铁板', position: { x: 9, y: 0 } },
    ],
    production: {
      targets: { [recipe]: 12 },
      processes: [{ recipe, machine, seconds: 0.5, speed: 0.75, ingredients: { 'iron-plate': 2 }, products: { [recipe]: 1 } }],
    },
    logistics: { module: 'G01', stations: [
      { sequence: 1, role: 'queue', label: 'A股道', serves: [2] },
      {
        sequence: 2, role: 'input', label: '铁板',
        train: { locomotives: 1, wagons: [{ type: 'cargo', capacity: 40, materials: { 'iron-plate': { slots: 20, stackSize: 100 } } }] },
        buffers: { 'iron-plate': { capacity: 2400, ratePerMinute: 24, reserveMinutes: 10 } },
      },
    ] },
  });

  assert.equal(result.production.feasible, true);
  assert.equal(result.production.processes[0].installedCount, 1);
  assert.deepEqual(result.logistics.stations.map(({ stationNameMatch, blueprintStationCount }) => [stationNameMatch, blueprintStationCount]),
    [[false, 0], [true, 1]]);
  assert.deepEqual(result.logistics.shortfalls, [{ sequence: 1, name: 'G01-01 候车｜A股道', issue: 'station-name-missing' }]);
});
