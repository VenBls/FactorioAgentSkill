import { deflateSync, inflateSync } from 'node:zlib';

const rootTypes = ['blueprint', 'blueprint_book', 'deconstruction_planner', 'upgrade_planner'];
const maxDecodedBytes = 32 * 1024 * 1024;

function identify(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('Expected a Factorio blueprint, book, or planner document');
  }
  const types = rootTypes.filter((type) => Object.hasOwn(document, type));
  const item = document[types[0]];
  if (types.length !== 1 || !item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError('Expected exactly one Factorio blueprint, book, or planner object');
  }
  return [types[0], item];
}

export function decodeBlueprint(value) {
  let document = value;
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const text = String(value).trim();
    if (text.startsWith('{')) {
      document = JSON.parse(text);
    } else {
      if (!text.startsWith('0')) throw new TypeError('Expected JSON or a Factorio exchange string with prefix 0');
      const payload = text.slice(1).replace(/\s/g, '');
      const compressed = Buffer.from(payload, 'base64');
      if (!payload || compressed.toString('base64') !== payload) throw new Error('Invalid exchange string base64');
      const json = inflateSync(compressed, { maxOutputLength: maxDecodedBytes });
      document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
    }
  }
  identify(document);
  return document;
}

export function encodeBlueprint(value) {
  const document = decodeBlueprint(value);
  const serialized = JSON.stringify(document);
  if (Buffer.byteLength(serialized) > maxDecodedBytes) throw new RangeError('Blueprint JSON exceeds 32 MiB');
  return `0${deflateSync(serialized, { level: 9 }).toString('base64')}`;
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function inspectDocument(document) {
  const [type, item] = identify(document);
  const summary = { type, label: item.label, prototypeVersion: item.version };
  if (type === 'blueprint_book') {
    const entries = (item.blueprints ?? []).map(({ index, ...entry }) => ({ index, ...inspectDocument(entry) }));
    return { ...summary, entries };
  }
  if (type !== 'blueprint') return summary;

  const prototypes = new Map();
  const recipes = new Map();
  const stations = [];
  let entityCenterBounds;
  for (const entity of item.entities ?? []) {
    increment(prototypes, entity.name);
    if (entity.recipe) increment(recipes, entity.recipe);
    if (entity.name === 'train-stop') {
      stations.push({
        name: entity.station,
        entityNumber: entity.entity_number,
        position: entity.position,
        direction: entity.direction ?? 0,
        manualTrainLimit: entity.manual_trains_limit,
      });
    }
    const { x, y } = entity.position ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    entityCenterBounds ??= { minX: x, minY: y, maxX: x, maxY: y };
    entityCenterBounds.minX = Math.min(entityCenterBounds.minX, x);
    entityCenterBounds.minY = Math.min(entityCenterBounds.minY, y);
    entityCenterBounds.maxX = Math.max(entityCenterBounds.maxX, x);
    entityCenterBounds.maxY = Math.max(entityCenterBounds.maxY, y);
  }
  return {
    ...summary,
    entityCount: item.entities?.length ?? 0,
    tileCount: item.tiles?.length ?? 0,
    wireCount: item.wires?.length ?? 0,
    entityCenterBounds,
    prototypes: Object.fromEntries(prototypes),
    recipes: Object.fromEntries(recipes),
    stations,
  };
}

export function inspectBlueprint(value) {
  return inspectDocument(decodeBlueprint(value));
}
