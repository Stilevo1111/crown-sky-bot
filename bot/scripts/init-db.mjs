import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sql } from '../db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '..', 'schema.sql');
const schema = await readFile(schemaPath, 'utf8');

await sql.unsafe(schema);
console.log('✅ Схема и стартовые данные применены к Neon.');
process.exit(0);
