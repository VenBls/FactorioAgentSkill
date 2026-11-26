import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  analyzeLogistics, analyzeProduction, createBlueprintLibrary, decodeBlueprint, designBlueprint,
  encodeBlueprint, inspectBlueprint,
} from './lib/index.mjs';

const operations = {
  design: (input, exchange) => {
    const result = designBlueprint(JSON.parse(input));
    return exchange ? result.blueprint : result;
  },
  production: (input) => analyzeProduction(JSON.parse(input)),
  logistics: (input) => analyzeLogistics(JSON.parse(input)),
  inspect: inspectBlueprint,
  decode: decodeBlueprint,
  encode: (input) => encodeBlueprint(JSON.parse(input)),
};

async function readInput(path) {
  const raw = path === '-'
    ? Buffer.concat(await Array.fromAsync(process.stdin)).toString('utf8')
    : await readFile(path, 'utf8');
  return raw.replace(/^\uFEFF/, '');
}

async function libraryCommand([action, argument, path, ...rest], values) {
  if (rest.length) throw new Error('Unexpected library arguments');
  const library = createBlueprintLibrary();
  if (action === 'list' && !argument) return library.list({ q: values.query, key: values.key });
  if (action === 'get' && argument && !path) {
    const entry = await library.get(argument);
    if (!entry) throw new Error('Blueprint revision not found');
    return values.exchange ? entry.blueprint : entry;
  }
  if (action === 'add' && argument && path) {
    return library.add({
      key: argument,
      blueprint: await readInput(path),
      label: values.label,
      tags: values.tag,
      notes: values.notes,
    });
  }
  throw new Error('Use library list, library get <id>, or library add <key> <file|->');
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' }, exchange: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      label: { type: 'string' }, tag: { type: 'string', multiple: true }, notes: { type: 'string' },
      query: { type: 'string' }, key: { type: 'string' },
    },
  });
  const [command, path] = positionals;
  if (values.help) {
    console.log([
      'Usage: node cli.mjs <design|production|logistics|inspect|decode|encode> <file|-> [--output file] [--exchange]',
      '       node cli.mjs library add <key> <file|-> [--label text] [--tag text] [--notes text]',
      '       node cli.mjs library list [--query text] [--key key]',
      '       node cli.mjs library get <id> [--exchange] [--output file]',
    ].join('\n'));
    return;
  }
  let result;
  if (command === 'library') {
    result = await libraryCommand(positionals.slice(1), values);
  } else {
    if (!Object.hasOwn(operations, command) || !path || positionals.length !== 2 || (values.exchange && command !== 'design')) {
      throw new Error('Use --help for usage. --exchange applies to design and library get.');
    }
    result = operations[command](await readInput(path), values.exchange);
  }
  const output = (typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + '\n';
  if (values.output) await writeFile(values.output, output, 'utf8');
  else process.stdout.write(output);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
