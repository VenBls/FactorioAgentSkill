import { decodeBlueprint, encodeBlueprint, inspectBlueprint } from './blueprint.mjs';
import { analyzeLogistics } from './logistics.mjs';

export const defaultBlueprintVersion = 562954250027018;
const maxEntityNumber = 0xffffffff;
const defaultOffset = { x: 0, y: 0 };
const rootBlock = '$root';

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function array(value, path) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function string(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function positiveInteger(value, path, max = maxEntityNumber) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new TypeError(`${path} must be a positive integer up to ${max}`);
  return value;
}

function finite(value, path, minimum = -Infinity) {
  if (!Number.isFinite(value) || value < minimum) throw new TypeError(`${path} must be finite and at least ${minimum}`);
  return value;
}

function position(value, path, integer = false) {
  const { x, y } = object(value, path);
  if (integer && (!Number.isSafeInteger(x) || !Number.isSafeInteger(y))) {
    throw new TypeError(`${path} must use integer tile coordinates`);
  }
  return { x: finite(x, `${path}.x`), y: finite(y, `${path}.y`) };
}

function offsetPosition(value, offset, path, integer) {
  const { x, y } = position(value, path, integer);
  return position({ x: x + offset.x, y: y + offset.y }, path, integer);
}

function entityIds(entities, path) {
  const seen = new Set();
  for (const [index, entity] of entities.entries()) {
    object(entity, `${path}.entities[${index}]`);
    if (entity.entity_number === undefined) continue;
    const number = positiveInteger(entity.entity_number, `${path}.entities[${index}].entity_number`);
    if (seen.has(number)) throw new Error(`${path} contains duplicate entity number ${number}`);
    seen.add(number);
  }
  let candidate = 1;
  return entities.map((entity) => {
    if (entity.entity_number !== undefined) return entity.entity_number;
    while (seen.has(candidate)) candidate++;
    return candidate++;
  });
}

function ref(ids, number, path) {
  if (!ids.has(number)) throw new Error(`${path} refers to unknown entity number ${String(number)}`);
  return ids.get(number);
}

function connector(id, path) {
  return positiveInteger(id, path);
}

function remapWire(wire, ids, path) {
  if (!Array.isArray(wire) || wire.length !== 4) throw new TypeError(`${path} must be a four-element Factorio wire tuple`);
  const [from, fromConnector, to, toConnector] = wire;
  return [ref(ids, from, path), connector(fromConnector, path), ref(ids, to, path), connector(toConnector, path)];
}

function remapStock(value, ids, path) {
  const connection = { ...object(value, path) };
  for (const key of ['stock', 'front', 'back']) {
    if (connection[key] !== undefined) connection[key] = ref(ids, connection[key], `${path}.${key}`);
  }
  return connection;
}

function remapEntity(entity, number, ids, offset, path) {
  const copy = structuredClone(entity);
  string(copy.name, `${path}.name`);
  copy.entity_number = number;
  copy.position = offsetPosition(copy.position, offset, `${path}.position`);
  if (copy.direction !== undefined && (!Number.isInteger(copy.direction) || copy.direction < 0 || copy.direction > 15)) {
    throw new TypeError(`${path}.direction must be a Factorio 2.x integer direction from 0 through 15`);
  }
  if (copy.connections !== undefined || copy.neighbours !== undefined) {
    throw new Error(`${path} uses legacy wire fields; import and re-export it in Factorio 2.x before composing`);
  }
  if (copy.stock_connections !== undefined) copy.stock_connections = remapStock(copy.stock_connections, ids, path);
  if (copy.wires !== undefined) {
    copy.wires = array(copy.wires, `${path}.wires`).map((wire) => remapWire(wire, ids, `${path}.wires`));
  }
  return copy;
}

function appendFragment(output, fragment, offset, path) {
  const entities = array(fragment.entities ?? [], `${path}.entities`);
  const sourceIds = entityIds(entities, path);
  const firstNumber = output.entities.length + 1;
  const ids = new Map(sourceIds.map((number, index) => [number, firstNumber + index]));
  for (const [index, entity] of entities.entries()) {
    output.entities.push(remapEntity(entity, firstNumber + index, ids, offset, `${path}.entities[${index}]`));
  }
  for (const [index, tile] of array(fragment.tiles ?? [], `${path}.tiles`).entries()) {
    const itemPath = `${path}.tiles[${index}]`;
    object(tile, itemPath);
    string(tile.name, `${itemPath}.name`);
    output.tiles.push({ ...structuredClone(tile), position: offsetPosition(tile.position, offset, `${itemPath}.position`, true) });
  }
  for (const wire of array(fragment.wires ?? [], `${path}.wires`)) {
    output.wires.push(remapWire(wire, ids, `${path}.wires`));
  }
  for (const schedule of array(fragment.schedules ?? [], `${path}.schedules`)) {
    const copy = structuredClone(object(schedule, `${path}.schedules`));
    copy.locomotives = array(copy.locomotives, `${path}.schedules.locomotives`).map((number) => ref(ids, number, `${path}.schedules.locomotives`));
    output.schedules.push(copy);
  }
  for (const stock of array(fragment.stock_connections ?? [], `${path}.stock_connections`)) {
    output.stock_connections.push(remapStock(stock, ids, `${path}.stock_connections`));
  }
  return ids;
}

function endpoint(value, fragments, path) {
  const { block = rootBlock, entity, connector: wireConnector } = object(value, path);
  if (!fragments.has(block)) throw new Error(`${path} refers to unknown block ${String(block)}`);
  return [ref(fragments.get(block), entity, path), connector(wireConnector, path)];
}

function withLayoutMachineCounts(production, entities) {
  object(production, 'production');
  const processes = array(production.processes, 'production.processes');
  const byMachineAndRecipe = new Map();
  const registeredProcesses = new Map();
  for (const entity of entities) {
    if (entity.recipe === undefined) continue;
    const key = JSON.stringify([entity.name, entity.recipe]);
    byMachineAndRecipe.set(key, (byMachineAndRecipe.get(key) ?? 0) + 1);
  }
  return {
    ...production,
    processes: processes.map((entry, index) => {
      const path = `production.processes[${index}]`;
      const process = object(entry, path);
      if (process.machine === undefined) return process;
      const machine = string(process.machine, `${path}.machine`);
      const recipe = string(process.recipe, `${path}.recipe`);
      const key = JSON.stringify([machine, recipe]);
      const infer = process.count === undefined;
      if (registeredProcesses.has(key) && (infer || registeredProcesses.get(key))) {
        throw new Error(`${path} shares ${machine} for ${recipe}; assign its count and the other group's count explicitly`);
      }
      registeredProcesses.set(key, infer);
      return infer ? { ...process, count: byMachineAndRecipe.get(key) ?? 0 } : process;
    }),
  };
}

function withLayoutStations(logistics, inspection) {
  const report = analyzeLogistics(logistics);
  const counts = new Map();
  for (const station of inspection.stations) {
    counts.set(station.name, (counts.get(station.name) ?? 0) + 1);
  }
  const stations = report.stations.map((station) => {
    const blueprintStationCount = counts.get(station.name) ?? 0;
    return { ...station, stationNameMatch: blueprintStationCount > 0, blueprintStationCount };
  });
  const missing = stations.filter((station) => !station.stationNameMatch);
  return {
    ...report,
    stations,
    shortfalls: [...report.shortfalls, ...missing.map(({ sequence, name }) => ({ sequence, name, issue: 'station-name-missing' }))],
  };
}

const fragmentFields = ['entities', 'tiles', 'wires', 'schedules', 'stock_connections'];
const reservedMetadata = new Set(['item', 'label', 'description', 'icons', 'version', ...fragmentFields]);
const knownBlockMetadata = new Set(['snap-to-grid', 'position-relative-to-grid', 'absolute-snapping', 'quality', ...reservedMetadata]);
const blockFields = new Set(['id', 'offset', 'source']);

export function designBlueprint(input) {
  const spec = object(input, 'design spec');
  const blueprint = { item: 'blueprint', version: defaultBlueprintVersion };
  for (const [key, value] of Object.entries(object(spec.metadata ?? {}, 'metadata'))) {
    if (reservedMetadata.has(key)) throw new Error(`metadata.${key} has a dedicated field in the design spec`);
    Object.defineProperty(blueprint, key, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
  }
  for (const key of ['label', 'description']) {
    if (spec[key] === undefined) continue;
    if (typeof spec[key] !== 'string') throw new TypeError(`${key} must be a string`);
    blueprint[key] = spec[key];
  }
  if (spec.icons !== undefined) blueprint.icons = structuredClone(array(spec.icons, 'icons'));
  if (spec.version !== undefined) blueprint.version = positiveInteger(spec.version, 'version', Number.MAX_SAFE_INTEGER);

  const output = Object.fromEntries(fragmentFields.map((key) => [key, []]));
  const fragments = new Map([[rootBlock, appendFragment(output, spec, defaultOffset, 'design')]]);
  for (const [index, block] of array(spec.blocks ?? [], 'blocks').entries()) {
    const path = `blocks[${index}]`;
    object(block, path);
    const id = string(block.id ?? `block-${index + 1}`, `${path}.id`);
    if (fragments.has(id)) throw new Error(`Duplicate block ID ${id}`);
    const unknown = Object.keys(block).filter((key) => !blockFields.has(key));
    if (unknown.length) {
      throw new Error(`${path} supports only id, source and integer translation offset; unsupported fields: ${unknown.join(', ')}`);
    }
    const fragment = decodeBlueprint(block.source).blueprint;
    if (!fragment) throw new Error(`${path}.source must contain one blueprint`);
    if (fragment.version !== undefined) {
      const version = positiveInteger(fragment.version, `${path}.source version`, Number.MAX_SAFE_INTEGER);
      if (spec.version !== undefined && version > blueprint.version) throw new Error(`${path}.source was exported by a newer version`);
      blueprint.version = Math.max(blueprint.version, version);
    }
    const unsupported = Object.keys(fragment).filter((key) => !knownBlockMetadata.has(key));
    if (unsupported.length) throw new Error(`${path}.source has block-level settings requiring manual composition: ${unsupported.join(', ')}`);
    const offset = position(block.offset ?? defaultOffset, `${path}.offset`, true);
    fragments.set(id, appendFragment(output, fragment, offset, path));
  }
  for (const [index, link] of array(spec.links ?? [], 'links').entries()) {
    const path = `links[${index}]`;
    const { from, to } = object(link, path);
    output.wires.push([...endpoint(from, fragments, `${path}.from`), ...endpoint(to, fragments, `${path}.to`)]);
  }
  if (!output.entities.length && !output.tiles.length) throw new Error('A blueprint requires at least one entity or tile');
  for (const key of fragmentFields) {
    if (output[key].length) blueprint[key] = output[key];
  }

  const document = { blueprint };
  const result = { document, blueprint: encodeBlueprint(document), inspection: inspectBlueprint(document) };
  if (spec.production !== undefined) {
    result.production = analyzeProduction(withLayoutMachineCounts(spec.production, output.entities));
  }
  if (spec.logistics !== undefined) result.logistics = withLayoutStations(spec.logistics, result.inspection);
  return result;
}

function amountMap(value, path, allowZero = false) {
  return new Map(Object.entries(object(value, path)).map(([material, amount]) => {
    string(material, `${path} material name`);
    finite(amount, `${path}.${material}`, 0);
    if (amount === 0 && !allowZero) throw new TypeError(`${path}.${material} must be positive`);
    return [material, amount];
  }));
}

function difference(a, b) {
  const delta = a - b;
  const tolerance = 32 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(delta) <= tolerance ? 0 : delta;
}

function addRate(rates, material, amount) {
  rates.set(material, finite((rates.get(material) ?? 0) + amount, `rate for ${material}`, 0));
}

function readProcess(entry, index) {
  const path = `processes[${index}]`;
  const process = object(entry, path);
  const recipe = string(process.recipe, `${path}.recipe`);
  const machine = process.machine === undefined ? undefined : string(process.machine, `${path}.machine`);
  const seconds = finite(process.seconds, `${path}.seconds`, Number.MIN_VALUE);
  const speed = finite(process.speed, `${path}.speed`, Number.MIN_VALUE);
  const craftsPerMachine = finite(60 * speed / seconds, `${path} per-machine runs per minute`, Number.MIN_VALUE);
  const ingredients = amountMap(process.ingredients ?? {}, `${path}.ingredients`);
  const products = amountMap(process.products, `${path}.products`);
  if (!products.size) throw new TypeError(`${path}.products must contain at least one material`);
  const { count, runsPerMinute } = process;
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
    throw new TypeError(`${path}.count must be a non-negative integer`);
  }
  if (runsPerMinute !== undefined) finite(runsPerMinute, `${path}.runsPerMinute`, 0);
  return { recipe, machine, craftsPerMachine, ingredients, products, count, runsPerMinute };
}

function netRates(process) {
  const inputs = new Map();
  const outputs = new Map();
  for (const material of new Set([...process.ingredients.keys(), ...process.products.keys()])) {
    const amount = difference(process.products.get(material) ?? 0, process.ingredients.get(material) ?? 0);
    if (amount > 0) outputs.set(material, amount);
    if (amount < 0) inputs.set(material, -amount);
  }
  return { inputs, outputs };
}

function solveTargets(processes, targets, external) {
  const net = processes.map(netRates);
  const producers = new Map();
  for (const [index, { outputs }] of net.entries()) {
    for (const material of outputs.keys()) {
      if (!producers.has(material)) producers.set(material, []);
      producers.get(material).push(index);
    }
  }
  function producerFor(material) {
    if (external.has(material)) return undefined;
    const candidates = producers.get(material) ?? [];
    if (candidates.length > 1) throw new Error(`Multiple processes can supply ${material}; select one recipe or give every process an explicit runsPerMinute`);
    return candidates[0];
  }

  const selected = new Set();
  const queue = [];
  const dependencies = new Map();
  const incoming = new Map();
  function addProcess(index) {
    if (index === undefined || selected.has(index)) return;
    selected.add(index);
    queue.push(index);
  }
  for (const [material, rate] of targets) {
    if (rate > 0) addProcess(producerFor(material));
  }
  for (const index of queue) {
    const suppliers = new Set();
    for (const material of net[index].inputs.keys()) {
      const upstream = producerFor(material);
      if (upstream === undefined) continue;
      addProcess(upstream);
      suppliers.add(upstream);
    }
    dependencies.set(index, suppliers);
    for (const supplier of suppliers) incoming.set(supplier, (incoming.get(supplier) ?? 0) + 1);
  }

  const demands = new Map(targets);
  const rates = processes.map(() => 0);
  const ready = queue.filter((index) => !incoming.has(index));
  for (const index of ready) {
    const { inputs, outputs } = net[index];
    let rate = 0;
    for (const [material, perCraft] of outputs) {
      if (!external.has(material)) rate = Math.max(rate, (demands.get(material) ?? 0) / perCraft);
    }
    rates[index] = finite(rate, `planned rate for ${processes[index].recipe}`, 0);
    for (const [material, amount] of inputs) addRate(demands, material, rate * amount);
    for (const supplier of dependencies.get(index)) {
      const remaining = incoming.get(supplier) - 1;
      incoming.set(supplier, remaining);
      if (remaining === 0) ready.push(supplier);
    }
  }
  if (ready.length !== queue.length) {
    throw new Error('Target inference found a process cycle; give every process an explicit runsPerMinute to calculate its material balance');
  }
  return rates;
}

function summarizeProcess(process, rate, used, made) {
  const inputRates = new Map();
  const outputRates = new Map();
  for (const [material, amount] of process.ingredients) {
    addRate(inputRates, material, rate * amount);
    addRate(used, material, rate * amount);
  }
  for (const [material, amount] of process.products) {
    addRate(outputRates, material, rate * amount);
    addRate(made, material, rate * amount);
  }
  const quota = rate / process.craftsPerMachine;
  const nearest = Math.round(quota);
  const requiredCount = rate === 0 ? 0 : Math.max(1, difference(quota, nearest) === 0 ? nearest : Math.ceil(quota));
  if (!Number.isSafeInteger(requiredCount)) throw new RangeError(`Machine count for ${process.recipe} exceeds the supported integer range`);
  const plannedCount = process.count ?? requiredCount;
  const capacity = finite(plannedCount * process.craftsPerMachine, `capacity for ${process.recipe}`, 0);

  return {
    recipe: process.recipe,
    machine: process.machine,
    runsPerMinute: rate,
    requiredCount,
    plannedCount,
    installedCount: process.count ?? null,
    capacityRunsPerMinute: capacity,
    utilization: capacity ? rate / capacity : rate > 0 ? null : 0,
    capacitySufficient: difference(capacity, rate) >= 0,
    inputsPerMinute: Object.fromEntries(inputRates),
    outputsPerMinute: Object.fromEntries(outputRates),
  };
}

export function analyzeProduction(input) {
  const spec = object(input, 'production spec');
  const processes = array(spec.processes, 'processes').map(readProcess);
  if (!processes.length) throw new TypeError('processes must contain at least one process');
  const targets = amountMap(spec.targets ?? {}, 'targets', true);
  const external = new Set(array(spec.external ?? [], 'external').map((material) => string(material, 'external material')));
  const explicit = processes.some(({ runsPerMinute }) => runsPerMinute !== undefined);
  if (explicit && processes.some(({ runsPerMinute }) => runsPerMinute === undefined)) {
    throw new Error('Set runsPerMinute for all processes or omit it from all processes');
  }
  if (!explicit && ![...targets.values()].some((rate) => rate > 0)) {
    throw new Error('Target inference requires at least one positive target per-minute rate');
  }
  const rates = explicit ? processes.map(({ runsPerMinute }) => runsPerMinute) : solveTargets(processes, targets, external);

  const used = new Map();
  const made = new Map();
  const rows = processes.map((process, index) => summarizeProcess(process, rates[index], used, made));
  const normalize = (entries) => Object.fromEntries(entries);
  const balance = new Map();
  const imports = new Map();
  const outputs = new Map();
  const surplus = new Map();
  const shortfalls = new Map();
  for (const material of new Set([...made.keys(), ...used.keys(), ...targets.keys()])) {
    const produced = made.get(material) ?? 0;
    const consumed = used.get(material) ?? 0;
    const net = difference(produced, consumed);
    const afterTarget = difference(Math.max(0, net), targets.get(material) ?? 0);
    balance.set(material, { produced, consumed, net });
    if (net < 0) imports.set(material, -net);
    if (net > 0) outputs.set(material, net);
    if (afterTarget > 0) surplus.set(material, afterTarget);
    if (afterTarget < 0) shortfalls.set(material, -afterTarget);
  }
  return {
    mode: explicit ? 'explicit' : 'targets',
    feasible: shortfalls.size === 0 && rows.every(({ capacitySufficient }) => capacitySufficient),
    targets: normalize(targets),
    targetShortfalls: normalize(shortfalls),
    imports: normalize(imports),
    outputs: normalize(outputs),
    surplus: normalize(surplus),
    processes: rows,
    balance: normalize(balance),
  };
}
