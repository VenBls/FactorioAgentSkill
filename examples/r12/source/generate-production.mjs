import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const origin = { x: 22, y: 25 };
const entities = [];
const occupied = new Map();
const fluidCells = new Map();
const machines = [];
const wires = [];
const key = (x, y) => `${x},${y}`;
const point = (x, y, even = false) => ({
  x: x - origin.x + (even ? 0 : 0.5),
  y: y - origin.y + (even ? 0 : 0.5),
});

function footprint(x, y, size) {
  const cells = [];
  for (let dx = -Math.floor(size / 2); dx < Math.ceil(size / 2); dx++) {
    for (let dy = -Math.floor(size / 2); dy < Math.ceil(size / 2); dy++) cells.push(key(x + dx, y + dy));
  }
  return cells;
}

function add(name, x, y, attributes = {}, size = 1) {
  const cells = footprint(x, y, size);
  for (const cell of cells) {
    if (occupied.has(cell)) throw new Error(`${name} overlaps ${occupied.get(cell)} at ${cell}`);
    occupied.set(cell, name);
  }
  const entity = { entity_number: entities.length + 1, name, position: point(x, y, size % 2 === 0), ...attributes };
  entities.push(entity);
  return entity;
}

function requests(items) {
  return { sections: [{ index: 1, filters: Object.entries(items).map(([name, count], i) => ({
    index: i + 1, name, quality: 'normal', comparator: '=', count,
  })) }] };
}

function maker(name, recipe, x, y, items = {}, solidOutput = true) {
  const machine = add(name, x, y, name === 'electric-furnace' ? {} : { recipe }, 3);
  machines.push({ ...machine.position, name, recipe });
  if (Object.keys(items).length) {
    add('requester-chest', x - 3, y, { request_filters: requests(items) });
    add('fast-inserter', x - 2, y, { direction: 12 });
  }
  if (solidOutput) {
    add('fast-inserter', x + 2, y, { direction: 12 });
    add('passive-provider-chest', x + 3, y, { bar: recipe === 'logistic-robot' ? 4 : 1 });
  }
}

function pipe(fluid, x, y, facing) {
  const cell = key(x, y);
  const existing = fluidCells.get(cell);
  if (existing) {
    if (existing.fluid !== fluid || existing.facing !== facing) throw new Error(`Conflicting pipes at ${cell}`);
    return;
  }
  add(facing === undefined ? 'pipe' : 'pipe-to-ground', x, y, facing === undefined ? {} : { direction: facing });
  fluidCells.set(cell, { ...point(x, y), fluid, facing });
}

function line(fluid, x1, y1, x2, y2) {
  if (x1 !== x2 && y1 !== y2) throw new Error('Pipe segments must be straight');
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) pipe(fluid, x, y);
  }
}

function tunnel(fluid, x1, y, x2) {
  pipe(fluid, x1, y, 12);
  pipe(fluid, x2, y, 4);
}

maker('chemical-plant', 'lubricant', 2, 8, {}, false);
maker('chemical-plant', 'light-oil-cracking', 12, 8, {}, false);
maker('chemical-plant', 'light-oil-cracking', 20, 8, {}, false);
maker('chemical-plant', 'sulfur', 31, 8);
maker('chemical-plant', 'sulfuric-acid', 38, 17, { sulfur: 20, 'iron-plate': 12 }, false);
for (const x of [30, 39]) maker('chemical-plant', 'battery', x, 27, { 'iron-plate': 16, 'copper-plate': 16 });

for (const x of [4, 11, 18]) maker('assembling-machine-2', 'electric-engine-unit', x, 28, { 'engine-unit': 8, 'electronic-circuit': 18 });
for (const x of [4, 11, 18, 25]) maker('electric-furnace', 'steel-plate', x, 34, { 'iron-plate': 30 });
for (const x of [4, 11, 18]) maker('assembling-machine-2', 'engine-unit', x, 41, { 'steel-plate': 12, 'iron-gear-wheel': 12, pipe: 24 });
maker('assembling-machine-2', 'iron-gear-wheel', 25, 41, { 'iron-plate': 24 });
maker('assembling-machine-2', 'pipe', 32, 41, { 'iron-plate': 24 });
maker('assembling-machine-2', 'logistic-robot', 39, 41, { 'flying-robot-frame': 16, 'advanced-circuit': 32 });
for (const x of [4, 11, 18, 25, 32, 39]) maker('assembling-machine-2', 'flying-robot-frame', x, 48, {
  'electric-engine-unit': 8, battery: 12, 'steel-plate': 7, 'electronic-circuit': 18,
});

line('heavy-oil', 1, 0, 1, 6);
line('light-oil', 13, 0, 13, 6);
line('light-oil', 13, 1, 21, 1);
line('light-oil', 21, 1, 21, 6);

const water = 'water';
line(water, 38, 0, 38, 15);
line(water, 37, 15, 38, 15);
line(water, 11, 3, 11, 6);
tunnel(water, 12, 3, 14);
line(water, 15, 3, 19, 3);
line(water, 19, 3, 19, 6);
tunnel(water, 20, 3, 22);
line(water, 23, 3, 38, 3);
line(water, 30, 3, 30, 6);

const gas = 'petroleum-gas';
line(gas, 42, 0, 42, 13);
line(gas, 32, 6, 36, 6);
tunnel(gas, 37, 6, 39);
line(gas, 40, 6, 42, 6);
line(gas, 11, 10, 11, 13);
line(gas, 19, 10, 19, 13);
line(gas, 11, 13, 36, 13);
tunnel(gas, 37, 13, 39);
line(gas, 40, 13, 42, 13);

const lube = 'lubricant';
line(lube, 1, 10, 1, 24);
line(lube, 1, 24, 18, 24);
for (const x of [4, 11, 18]) line(lube, x, 24, x, 26);

const acid = 'sulfuric-acid';
line(acid, 37, 19, 37, 22);
line(acid, 29, 22, 38, 22);
for (const x of [29, 38]) line(acid, x, 22, x, 25);

const inputs = ['iron-plate', 'copper-plate', 'electronic-circuit', 'advanced-circuit'].map((item, index) => {
  const { position } = add('passive-provider-chest', 16 + index * 2, 0);
  return { ...position, item };
});
const { position: outputPosition } = add('requester-chest', 28, 0, { request_filters: requests({ 'logistic-robot': 150 }) });
const output = { ...outputPosition, item: 'logistic-robot' };
const roboports = [add('roboport', 22, 19, {}, 4), add('roboport', 22, 38, {}, 4)].map((entity) => entity.position);

const substations = [];
for (const [x, y] of [[5, 4], [17, 6], [27, 6], [41, 4], [6, 19], [15, 20], [28, 18], [42, 20],
  [6, 31], [16, 32], [29, 32], [42, 32], [7, 45], [17, 45], [29, 45], [43, 45]]) {
  substations.push(add('substation', x, y, {}, 2));
}
const powered = new Set(['chemical-plant', 'assembling-machine-2', 'electric-furnace', 'fast-inserter', 'roboport']);
for (const entity of entities.filter((entry) => powered.has(entry.name))) {
  const inRange = substations.some(({ position }) => Math.abs(position.x - entity.position.x) <= 9 && Math.abs(position.y - entity.position.y) <= 9);
  if (!inRange) throw new Error(`No power for ${entity.name} #${entity.entity_number}`);
}
const connected = [substations.shift()];
while (substations.length) {
  const candidates = substations.flatMap((station, i) => connected.map((other) => ({ station, i, other,
    distance: Math.hypot(station.position.x - other.position.x, station.position.y - other.position.y),
  })));
  const { station, i, other, distance } = candidates.sort((a, b) => a.distance - b.distance)[0];
  if (distance > 18) throw new Error(`Electric networks split at distance ${distance}`);
  wires.push([other.entity_number, 5, station.entity_number, 5]);
  connected.push(station);
  substations.splice(i, 1);
}

const directionOffset = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };
for (const pipeCell of fluidCells.values()) {
  const local = { x: pipeCell.x + origin.x - 0.5, y: pipeCell.y + origin.y - 0.5 };
  const exposed = pipeCell.facing === undefined ? [0, 4, 8, 12] : [pipeCell.facing];
  for (const dir of exposed) {
    const [dx, dy] = directionOffset[dir];
    const peer = fluidCells.get(key(local.x + dx, local.y + dy));
    const joins = peer && (peer.facing === undefined || peer.facing === (dir + 8) % 16);
    if (joins && peer.fluid !== pipeCell.fluid) throw new Error(`Cross-connected fluid at ${local.x},${local.y}: ${pipeCell.fluid}/${peer.fluid}`);
  }
}

const fluids = [[1, 'heavy-oil'], [13, 'light-oil'], [38, 'water'], [42, 'petroleum-gas']]
  .map(([x, fluid]) => ({ ...point(x, 0), fluid }));
const manifest = {
  bounds: { minX: -22, minY: -25, maxX: 22, maxY: 25 },
  inputs, fluids, output, roboports, machines,
  power: connected[0].position,
  fluidTiles: [...fluidCells.values()],
  entityCount: entities.length,
};
const blueprint = { blueprint: {
  item: 'blueprint', label: '机器人工坊 · 生产核心',
  description: '目标 12 物流机器人/分钟。供给铁板、铜板、电路板、高级电路板、水、重油，并在石油气与轻油中择一或并用。接电，激活机器人指令平台并投入物流机器人。测试配置为 200 架物流机器人、工作机器人速度和载货量各 2 级。',
  icons: [{ signal: { name: 'logistic-robot' }, index: 1 }, { signal: { name: 'assembling-machine-2' }, index: 2 }],
  entities, wires, version: 2 * 2 ** 48 + 2 ** 32,
} };
if (!process.argv[2]) throw new Error('Specify the R12 output directory');
const dist = pathToFileURL(resolve(process.argv[2]) + sep);
mkdirSync(dist, { recursive: true });
const write = (name, data) => writeFileSync(new URL(name, dist), data);
write('production-core.txt', `0${deflateSync(JSON.stringify(blueprint), { level: 9 }).toString('base64')}\n`);
write('production-core-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
write('production-core.json', `${JSON.stringify(blueprint, null, 2)}\n`);
console.log(`${entities.length} entities, ${wires.length} power connections`);
