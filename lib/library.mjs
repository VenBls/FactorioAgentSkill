import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBlueprint, encodeBlueprint, inspectBlueprint } from './blueprint.mjs';

const defaultDirectory = fileURLToPath(new URL('../out/library/', import.meta.url));
const idPattern = /^[a-f0-9]{64}$/;
const keyPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');

function shortText(value, path, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new TypeError(`${path} must be a string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function blueprintStats(inspection) {
  const { type: kind } = inspection;
  if (kind === 'blueprint') return { kind, blueprints: 1, entityCount: inspection.entityCount };
  if (kind !== 'blueprint_book') return { kind, blueprints: 0, entityCount: 0 };
  const pages = inspection.entries.map(blueprintStats);
  return {
    kind,
    blueprints: pages.reduce((sum, page) => sum + page.blueprints, 0),
    entityCount: pages.reduce((sum, page) => sum + page.entityCount, 0),
  };
}

function summary({ blueprint, ...entry }) {
  return entry;
}

export function createBlueprintLibrary(directory = process.env.FACTORIO_LIBRARY_DIR || defaultDirectory) {
  const root = resolve(directory);
  async function get(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new TypeError('id must be a lowercase SHA-256');
    try {
      return JSON.parse(await readFile(join(root, `${id}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  return {
    async add(input) {
      if (!input || typeof input !== 'object' || typeof input.key !== 'string' || !keyPattern.test(input.key)) {
        throw new TypeError('key must use 1–80 lowercase ASCII letters, digits or hyphens');
      }
      let document, stats;
      try {
        document = decodeBlueprint(input.blueprint);
        stats = blueprintStats(inspectBlueprint(document));
      } catch (error) {
        throw new TypeError(error.message, { cause: error });
      }
      if (!['blueprint', 'blueprint_book'].includes(stats.kind)) throw new TypeError('Library requires a blueprint or blueprint book');
      const blueprint = typeof input.blueprint === 'string' && input.blueprint.trim().startsWith('0')
        ? input.blueprint.trim() : encodeBlueprint(document);
      const preferredLabel = input.label ?? document[stats.kind].label ?? input.key;
      const label = shortText(preferredLabel, 'label', 200) || input.key;
      const notes = shortText(input.notes ?? '', 'notes', 8_000);
      const providedTags = input.tags ?? [];
      if (!Array.isArray(providedTags) || providedTags.length > 20) throw new TypeError('tags must be an array of at most 20 strings');
      const tags = [...new Set(providedTags.map((tag) => shortText(tag, 'tag', 50)).filter(Boolean))].sort();
      const id = digest(JSON.stringify([input.key, blueprint, label, notes, tags]));
      const entry = {
        id, key: input.key, label, tags, notes, ...stats, blueprint,
        blueprintSha256: digest(blueprint), createdAt: new Date().toISOString(),
      };
      await mkdir(root, { recursive: true });
      const temp = join(root, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
        await link(temp, join(root, `${id}.json`));
        return entry;
      } catch (error) {
        if (error.code === 'EEXIST') {
          const existing = await get(id);
          if (existing) return existing;
        }
        throw error;
      } finally {
        await unlink(temp).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },

    get,

    async list({ q = '', key } = {}) {
      const query = shortText(q, 'q', 200).toLowerCase();
      if (key !== undefined && (typeof key !== 'string' || !keyPattern.test(key))) throw new TypeError('invalid key');
      const names = await readdir(root).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const entries = [];
      for (const name of names) {
        if (!name.endsWith('.json') || !idPattern.test(name.slice(0, -5))) continue;
        const entry = await get(name.slice(0, -5));
        if (!entry || (key && entry.key !== key)) continue;
        if (query && ![entry.key, entry.label, entry.notes, ...entry.tags].some((value) => value.toLowerCase().includes(query))) continue;
        entries.push(summary(entry));
      }
      return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    },
  };
}
