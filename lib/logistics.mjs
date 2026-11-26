const roles = { queue: '候车', input: '入料', output: '出料' };

function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function amount(value, path, { integer = false, min = 0 } = {}) {
  if (!Number.isFinite(value) || value < min || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError(`${path} must be a ${integer ? 'safe integer' : 'finite number'} >= ${min}`);
  }
  return value;
}

function label(value, path) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw new TypeError(`${path} must be a non-empty single-line string`);
  }
  return value;
}

function inspectTrain(value, path) {
  const train = record(value, path);
  const locomotives = amount(train.locomotives, `${path}.locomotives`, { integer: true, min: 1 });
  if (!Array.isArray(train.wagons) || !train.wagons.length) throw new TypeError(`${path}.wagons must be a non-empty array`);
  const capacity = new Map();
  const wagons = train.wagons.map((value, index) => {
    const wagonPath = `${path}.wagons[${index}]`;
    const wagon = record(value, wagonPath);
    if (!['cargo', 'fluid'].includes(wagon.type)) throw new TypeError(`${wagonPath}.type must be cargo or fluid`);
    const allocations = Object.entries(record(wagon.materials, `${wagonPath}.materials`));
    const total = amount(wagon.capacity, `${wagonPath}.capacity`, { integer: wagon.type === 'cargo', min: Number.EPSILON });
    if (!allocations.length || (wagon.type === 'fluid' && allocations.length !== 1)) {
      throw new TypeError(`${wagonPath} needs material allocations; one fluid per fluid wagon`);
    }
    const materials = allocations.map(([material, value]) => {
      label(material, `${wagonPath}.materials key`);
      const p = `${wagonPath}.materials.${material}`;
      const allocation = wagon.type === 'cargo' ? record(value, p) : null;
      const share = allocation
        ? amount(allocation.slots, `${p}.slots`, { integer: true, min: 1 })
        : amount(value, p, { min: Number.EPSILON });
      const quantity = allocation ? share * amount(allocation.stackSize, `${p}.stackSize`, { integer: true, min: 1 }) : share;
      const previous = capacity.get(material);
      if (previous && previous.type !== wagon.type) throw new TypeError(`${material} mixes cargo and fluid allocations`);
      capacity.set(material, { type: wagon.type, quantity: amount((previous?.quantity ?? 0) + quantity, p, { integer: !!allocation }) });
      return { material, share, quantity };
    });
    const allocated = materials.reduce((sum, material) => sum + material.share, 0);
    if (allocated > total) throw new RangeError(`${wagonPath} allocates more than its capacity`);
    return { index: index + 1, type: wagon.type, capacity: total, allocated, materials };
  });
  const requiredTrackTiles = train.requiredTrackTiles === undefined
    ? null : amount(train.requiredTrackTiles, `${path}.requiredTrackTiles`, { min: Number.EPSILON });
  return { locomotives, wagons, vehicleCount: locomotives + wagons.length, capacity, requiredTrackTiles };
}

function inspectBuffer(value, capacity, role, path) {
  const buffer = record(value, path);
  for (const material of Object.keys(buffer)) {
    if (!capacity.has(material)) throw new TypeError(`${path} has no train allocation for ${material}`);
  }
  return Object.fromEntries(Array.from(capacity, ([material, car]) => {
    const p = `${path}.${material}`;
    const config = record(buffer[material], p);
    const units = { integer: car.type === 'cargo' };
    const stockCapacity = amount(config.capacity, `${p}.capacity`, units);
    const ratePerMinute = amount(config.ratePerMinute, `${p}.ratePerMinute`);
    const batch = amount(config.batch ?? car.quantity, `${p}.batch`, { ...units, min: Number.EPSILON });
    if (batch > car.quantity) throw new RangeError(`${p}.batch exceeds capacity per train`);
    const reserveMinutes = amount(config.reserveMinutes ?? 0, `${p}.reserveMinutes`);
    const reserveRaw = ratePerMinute * reserveMinutes;
    const reserve = amount(units.integer ? Math.ceil(reserveRaw) : reserveRaw, `${p}.reserve`, units);
    const reserveAndBatchFit = reserve + batch <= stockCapacity;
    return [material, {
      perTrainCapacity: car.quantity,
      capacity: stockCapacity,
      batch,
      ratePerMinute,
      reserve,
      reserveAndBatchFit,
      inboundAtOrBelow: role === 'input' && stockCapacity >= batch ? stockCapacity - batch : null,
      outboundAtOrAbove: role === 'output' && reserveAndBatchFit ? reserve + batch : null,
      minutesPerBatchAtRate: ratePerMinute === 0 ? null : amount(batch / ratePerMinute, `${p}.minutesPerBatchAtRate`),
      minutesAtFullBuffer: ratePerMinute === 0 ? null : amount(stockCapacity / ratePerMinute, `${p}.minutesAtFullBuffer`),
    }];
  }));
}

export function analyzeLogistics(spec) {
  record(spec, 'logistics');
  const module = label(spec.module, 'module');
  if (!Array.isArray(spec.stations) || !spec.stations.length) throw new TypeError('stations must be a non-empty array');
  const stations = new Map();
  for (const [index, value] of spec.stations.entries()) {
    const path = `stations[${index}]`;
    const station = record(value, path);
    const sequence = amount(station.sequence, `${path}.sequence`, { integer: true, min: 1 });
    if (sequence > 99 || stations.has(sequence)) throw new RangeError(`${path}.sequence must be unique and at most 99`);
    const { role } = station;
    if (!Object.hasOwn(roles, role)) throw new TypeError(`${path}.role must be queue, input or output`);
    const name = station.name === undefined
      ? `${module}-${String(sequence).padStart(2, '0')} ${roles[role]}｜${label(station.label, `${path}.label`)}`
      : label(station.name, `${path}.name`);
    const berths = amount(station.berths ?? 1, `${path}.berths`, { integer: true, min: 1 });
    const usableTrackTiles = station.usableTrackTiles === undefined
      ? null : amount(station.usableTrackTiles, `${path}.usableTrackTiles`, { min: Number.EPSILON });
    if (role === 'queue') {
      if (!Array.isArray(station.serves) || !station.serves.length || (new Set(station.serves)).size !== station.serves.length) {
        throw new TypeError(`${path}.serves must be a non-empty array of unique work-station sequences`);
      }
      stations.set(sequence, { sequence, role, name, berths, usableTrackTiles, serves: station.serves });
      continue;
    }
    const { capacity, ...train } = inspectTrain(station.train, `${path}.train`);
    const buffers = inspectBuffer(station.buffers, capacity, role, `${path}.buffers`);
    stations.set(sequence, { sequence, role, name, berths, usableTrackTiles, train, buffers });
  }
  const report = Array.from(stations.values(), (station) => {
    const serving = station.role === 'queue' ? station.serves.map((sequence) => {
      const work = stations.get(sequence);
      if (!work?.train) throw new TypeError(`Queue station ${station.sequence} has no work station ${sequence}`);
      return work.train;
    }) : [station.train];
    const maximumVehicles = Math.max(...serving.map((train) => train.vehicleCount));
    const requiredTrackTiles = serving.some((train) => train.requiredTrackTiles === null)
      ? null : Math.max(...serving.map((train) => train.requiredTrackTiles));
    const trackFits = requiredTrackTiles === null || station.usableTrackTiles === null ? null
      : station.usableTrackTiles >= requiredTrackTiles;
    return { ...station, maximumVehicles, requiredTrackTiles, trackFits };
  });
  return {
    module,
    stations: report,
    shortfalls: report.flatMap((station) => [
      ...(station.trackFits === false ? [{ sequence: station.sequence, issue: 'track-too-short' }] : []),
      ...Object.entries(station.buffers ?? {}).filter(([, buffer]) => !buffer.reserveAndBatchFit)
        .map(([material]) => ({ sequence: station.sequence, material, issue: 'reserve-and-batch-do-not-fit' })),
    ]),
  };
}
