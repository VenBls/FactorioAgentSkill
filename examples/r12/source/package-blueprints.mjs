import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

if (!process.argv[2]) throw new Error('Specify the R12 output directory');
const dist = pathToFileURL(resolve(process.argv[2]) + sep);
const files = ['rail-stations.txt', 'production-core.txt'];
const blueprints = files.map((name, index) => {
  const exchange = readFileSync(new URL(name, dist), 'utf8').trim();
  if (exchange[0] !== '0') throw new Error(`Unrecognized blueprint format in ${name}`);
  const { blueprint } = JSON.parse(inflateSync(Buffer.from(exchange.slice(1), 'base64')));
  if (blueprint?.item !== 'blueprint' || !blueprint.entities?.length) throw new Error(`Empty blueprint in ${name}`);
  return { index, blueprint };
});

const book = { blueprint_book: {
  item: 'blueprint-book',
  label: '铁路棋盘 · 物流机器人街区',
  description: '内含车站组与生产核心。将两张蓝图按总图分别放置，再按接口图接油路、用水、电力和物流网络。',
  icons: [{ signal: { name: 'logistic-robot' }, index: 1 }, { signal: { name: 'rail' }, index: 2 }],
  active_index: 0,
  version: Math.max(...blueprints.map(({ blueprint }) => blueprint.version)),
  blueprints,
} };
const exchange = `0${deflateSync(JSON.stringify(book), { level: 9 }).toString('base64')}\n`;
writeFileSync(new URL('robot-district-book.txt', dist), exchange);
console.log(`Wrote book with ${blueprints.length} blueprints`);
