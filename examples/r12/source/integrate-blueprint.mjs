import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

if (!process.argv[2]) throw new Error('Specify the R12 output directory');
const dist = pathToFileURL(resolve(process.argv[2]) + sep);
const read = (name) => readFileSync(new URL(name, dist), 'utf8');
const decode = (name) => JSON.parse(inflateSync(Buffer.from(read(name).trim().slice(1), 'base64'))).blueprint;
const deck = decode('rail-stations.txt');
const core = decode('production-core.txt');
const production = JSON.parse(read('production-core-manifest.json'));
const interfaces = JSON.parse(read('rail-integration.json'));
const shift = interfaces.coreOffset ?? { x: 0, y: 100 };
const translate = ({ x, y }) => ({ x: x + shift.x, y: y + shift.y });
const entities = [];
const wires = [];
const byTile = new Map();
const underground = new Map();
const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const tile = (position) => [Math.floor(position.x), Math.floor(position.y)];
const key = (x, y) => `${x},${y}`;
const width = {
  'assembling-machine-2': [3, 3], 'electric-furnace': [3, 3], 'chemical-plant': [3, 3],
  roboport: [4, 4], substation: [2, 2], 'train-stop': [2, 2], 'straight-rail': [2, 2],
  'storage-tank': [3, 3], pump: [1, 2], 'big-electric-pole': [2, 2],
  'curved-rail-a': [8, 8], 'curved-rail-b': [8, 8], 'half-diagonal-rail': [4, 4],
};

function tiles(entity) {
  const [w, h] = width[entity.name] ?? [1, 1];
  const [xSpan, ySpan] = (entity.direction ?? 0) % 8 === 4 ? [h, w] : [w, h];
  const cells = [];
  for (let x = Math.floor(entity.position.x - xSpan / 2); x < entity.position.x + xSpan / 2 - 0.1; x++) {
    for (let y = Math.floor(entity.position.y - ySpan / 2); y < entity.position.y + ySpan / 2 - 0.1; y++) cells.push(key(x, y));
  }
  return cells;
}

function push(entity, fluid) {
  const entry = { ...entity, entity_number: entities.length + 1 };
  if (fluid) entry.fluid = fluid;
  for (const id of tiles(entry)) {
    const current = byTile.get(id) ?? [];
    current.push(entry);
    byTile.set(id, current);
  }
  if (entry.name === 'pipe-to-ground') underground.set(key(...tile(entry.position)), entry);
  entities.push(entry);
  return entry;
}

const same = (a, b) => a.x === b.x && a.y === b.y;
function append(blueprint, isCore) {
  const remap = new Map();
  for (const entity of blueprint.entities) {
    if (isCore && same(entity.position, production.output)) continue;
    const position = isCore ? translate(entity.position) : entity.position;
    if (isCore && tiles({ ...entity, position }).some((id) => byTile.get(id)?.some((entry) => entry.deck))) {
      throw new Error(`Core overlaps train infrastructure at ${position.x},${position.y}`);
    }
    const pipeTag = isCore
      ? production.fluidTiles.find((cell) => same(cell, entity.position))
      : interfaces.fluids.find((outlet) => same(outlet, position));
    const current = !isCore && same(position, interfaces.output) ? {
      ...entity,
      request_filters: { sections: [{ index: 1, filters: [
        { index: 1, name: 'logistic-robot', quality: 'normal', comparator: '=', count: 1200 },
      ] }] },
    } : entity;
    const entry = push({ ...current, position, deck: !isCore }, pipeTag?.fluid);
    remap.set(entity.entity_number, entry.entity_number);
  }
  for (const [a, ca, b, cb] of blueprint.wires ?? []) {
    if (remap.has(a) && remap.has(b)) wires.push([remap.get(a), ca, remap.get(b), cb]);
  }
}

append(deck, false);
append(core, true);
for (const { x, y, fluid } of interfaces.fluids) {
  const position = { x, y };
  if (byTile.has(key(...tile(position)))) throw new Error(`Tank outlet ${fluid} is obstructed`);
  push({ name: 'pipe', position }, fluid);
}

function permitted(x, y, fluid, openings, goalId) {
  if (x < -45 || x > 45 || y < 20 || y > shift.y - 24) return false;
  const id = key(x, y);
  if (byTile.has(id) && id !== goalId) return false;
  return openings.every((dir) => {
    const [dx, dy] = directions[dir];
    return (byTile.get(key(x + dx, y + dy)) ?? []).every((near) => {
      if (near.name !== 'pipe' && near.name !== 'pipe-to-ground') return true;
      if (near.name === 'pipe-to-ground' && (near.direction ?? 0) / 4 !== (dir + 2) % 4) return true;
      return near.fluid === fluid;
    });
  });
}

function tunnelSafe(x, y, dir, length) {
  const [dx, dy] = directions[dir];
  for (let n = -10; n <= length + 10; n++) {
    const pipe = underground.get(key(x + dx * n, y + dy * n));
    if (!pipe) continue;
    const surface = (pipe.direction ?? 0) / 4;
    if ((n > 0 && n <= 10 && surface === dir) || (n < length && n >= length - 10 && surface === (dir + 2) % 4)) return false;
  }
  return true;
}

function route(outlet, destination) {
  const source = tile(outlet);
  const goal = tile(destination);
  const sourceId = key(...source);
  const goalId = key(...goal);
  if (!byTile.get(sourceId)?.some((entity) => entity.name === 'pipe')) throw new Error(`Source ${outlet.fluid} is not a normal pipe`);
  const frontier = [{ x: source[0], y: source[1], cost: 0, previous: null, run: [] }];
  const visited = new Set();
  const estimate = (node) => node.cost + 0.25 * (Math.abs(node.x - goal[0]) + Math.abs(node.y - goal[1]));
  while (frontier.length) {
    frontier.sort((a, b) => estimate(b) - estimate(a));
    const node = frontier.pop();
    const id = key(node.x, node.y);
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === goalId) {
      const cells = [];
      for (let step = node; step.previous; step = step.previous) cells.unshift(...step.run);
      return cells.filter(({ x, y }) => key(x, y) !== sourceId && key(x, y) !== goalId);
    }
    for (const [dir, [dx, dy]] of directions.entries()) {
      const x = node.x + dx;
      const y = node.y + dy;
      if (permitted(x, y, outlet.fluid, [0, 1, 2, 3], goalId)) {
        frontier.push({ x, y, cost: node.cost + 1, previous: node, run: [{ x, y }] });
      }
      const reverse = (dir + 2) % 4;
      if (!permitted(x, y, outlet.fluid, [reverse], goalId) || key(x, y) === goalId) continue;
      for (let length = 2; length <= 9; length++) {
        const tx = x + dx * length;
        const ty = y + dy * length;
        const nx = tx + dx;
        const ny = ty + dy;
        if (!permitted(tx, ty, outlet.fluid, [dir], goalId) || key(tx, ty) === goalId) continue;
        if (!permitted(nx, ny, outlet.fluid, [0, 1, 2, 3], goalId) || !tunnelSafe(x, y, dir, length)) continue;
        frontier.push({ x: nx, y: ny, cost: node.cost + 3 + 0.15 * length, previous: node,
          run: [{ x, y, facing: reverse * 4 }, { x: tx, y: ty, facing: dir * 4 }, { x: nx, y: ny }],
        });
      }
    }
  }
  throw new Error(`Could not route ${outlet.fluid} from ${sourceId} to ${goalId}`);
}

const links = [];
for (const outlet of interfaces.fluids) {
  const port = production.fluids.find(({ fluid }) => fluid === outlet.fluid);
  if (!port) throw new Error(`No core port for ${outlet.fluid}`);
  const destination = translate(port);
  const positions = route(outlet, destination);
  for (const { x, y, facing } of positions) {
    const position = { x: x + 0.5, y: y + 0.5 };
    const entity = facing === undefined ? { name: 'pipe', position } : { name: 'pipe-to-ground', direction: facing, position };
    push(entity, outlet.fluid);
  }
  links.push({ fluid: outlet.fluid, outlet, destination, pipeTiles: positions });
}

const poleRadius = { 'medium-electric-pole': 9, 'small-electric-pole': 7.5, 'big-electric-pole': 30, substation: 18 };
const poles = entities.filter(({ name }) => name in poleRadius);
const powerLinks = poles.filter(({ deck }) => deck).flatMap((a) => poles.filter(({ deck }) => !deck).map((b) => ({
  a, b, distance: Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y),
}))).filter(({ a, b, distance }) => distance <= Math.min(poleRadius[a.name], poleRadius[b.name]));
for (const { a, b } of powerLinks.sort((a, b) => a.distance - b.distance).slice(0, 1)) {
  wires.push([a.entity_number, 5, b.entity_number, 5]);
}

const blueprint = { blueprint: {
  item: 'blueprint',
  label: '铁路棋盘 · 物流机器人街区（车站及工厂）',
  description: '连接车站组、独立料仓和物流机器人生产核心。接南侧水路入口、电源和外部铁路，用 1+1 列车访问车站。向机器人指令平台存入物流机器人。',
  icons: core.icons,
  version: Math.max(deck.version, core.version),
  entities: entities.map(({ deck, fluid, ...entity }) => entity),
  wires,
} };
const transform = (item) => ({ ...item, ...translate(item) });
const occupiedPositions = [...byTile.keys()].map((id) => id.split(',').map(Number));
const xPositions = occupiedPositions.map(([x]) => x);
const yPositions = occupiedPositions.map(([, y]) => y);
const manifest = {
  ...production,
  bounds: { minX: Math.min(...xPositions), minY: Math.min(...yPositions), maxX: Math.max(...xPositions) + 1, maxY: Math.max(...yPositions) + 1 },
  coreOffset: shift,
  inputs: interfaces.inputs,
  output: interfaces.output,
  fluids: [transform(production.fluids.find(({ fluid }) => fluid === 'water')), ...interfaces.fluids],
  roboports: [...production.roboports.map(transform), ...(interfaces.roboports ?? [])],
  machines: production.machines.map(transform),
  power: transform(production.power),
  fluidTiles: [...production.fluidTiles.map(transform), ...links.flatMap(({ fluid, outlet, pipeTiles }) => [outlet,
    ...pipeTiles.map(({ x, y, facing }) => ({ x: x + 0.5, y: y + 0.5, facing, fluid })),
  ])],
  links: links.map(({ pipeTiles, ...link }) => ({ ...link, pipeTiles: pipeTiles.map(({ x, y, facing }) => ({ x: x + 0.5, y: y + 0.5, facing })) })),
  entityCount: entities.length,
};
writeFileSync(new URL('robot-district-integrated.txt', dist), `0${deflateSync(JSON.stringify(blueprint), { level: 9 }).toString('base64')}\n`);
writeFileSync(new URL('robot-district-integrated-manifest.json', dist), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(new URL('./robot-district-integrated.json', dist), `${JSON.stringify(blueprint, null, 2)}\n`);
console.log(`Integrated ${entities.length} entities and ${links.length} fluid routes with ${powerLinks.length ? 'linked electric poles' : 'two separate electric connections'}`);
