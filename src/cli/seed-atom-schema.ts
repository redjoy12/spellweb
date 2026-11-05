/**
 * npm run seed:atom-schema
 *
 * Loads the tag list of config/atom-schema.json into the database, at the schema_version of the
 * file. A new database needs it before the first extraction: run it once, after `npm run sync:rules`.
 *
 * Do not use `npm run generate:atom-schema -- --persist` on a new database. That command numbers
 * each version from the versions already in the database, so on a new database it writes the same
 * tags as an early version, and the code tests the version number of the tag list.
 */
import { openDb } from '../db/client.js';
import { loadAtomSchema, persistAtomSchema } from '../atoms/schema.js';

const db = openDb();
const schema = loadAtomSchema();
const row = db.prepare('SELECT MAX(schema_version) v FROM atom_types').get() as { v: number | null };
if (row.v !== null && row.v >= schema.schema_version) {
  console.log(`atom schema v${row.v} is already in the database (the file has v${schema.schema_version}); nothing to do`);
  process.exit(0);
}
persistAtomSchema(db, schema);
console.log(`persisted ${schema.types.length} atom types as schema v${schema.schema_version}`);
