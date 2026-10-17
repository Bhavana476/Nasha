// MongoDB storage, used when a connection string is configured (see store.mjs).
// Each list in the data (items, offers, reservations…) is its own collection with one document per
// record, kept in order by a `_pos` field. Single-document parts (settings, content, meta, visits) live in
// the `state` collection. Photos are stored in the `images` collection.
import { MongoClient } from 'mongodb';

const STATE = 'state';
const keyOf = record => record?.id ?? record?.tokenHash; // Password-reset entries are keyed by their token hash.
const strip = ({ _id, _pos, ...record }) => record;

export async function openMongo(uri, name = 'nasha', attempts = 5) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000, appName: 'nasha' });
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect();
      await client.db(name).command({ ping: 1 });
      return { client, database: client.db(name) };
    } catch (error) {
      if (attempt === attempts) { await client.close().catch(() => {}); throw error; }
      console.error(`MongoDB is not reachable yet (attempt ${attempt} of ${attempts}): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
    }
  }
}

// The whole data set as saved in MongoDB, or null if nothing has been saved there yet.
export async function loadFromMongo(database) {
  const parts = await database.collection(STATE).find().toArray();
  if (!parts.some(part => part._id === 'meta')) return null;
  const data = {};
  for (const part of parts) {
    if (part.kind === 'list') data[part._id] = (await database.collection(part._id).find().sort({ _pos: 1 }).toArray()).map(strip);
    else data[part._id] = part.value;
  }
  return data;
}

// Writes only what changed since the last write. Calls are queued, so writes never overlap.
export function mongoWriter(database) {
  const written = new Map(); // collection name -> Map(record key -> JSON as last written); STATE holds the single documents
  const seenIn = name => written.get(name) || written.set(name, new Map()).get(name);

  // Records what is already in MongoDB, so the first write sends only differences, deletions included.
  function prime(data) {
    for (const [name, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        const map = seenIn(name);
        value.forEach((record, pos) => map.set(String(keyOf(record)), JSON.stringify([pos, record])));
        seenIn(STATE).set(name, 'list');
      } else seenIn(STATE).set(name, JSON.stringify(value));
    }
  }

  async function write(data) {
    const stateOps = [];
    for (const [name, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        const before = seenIn(name), after = new Map(), ops = [];
        value.forEach((record, pos) => {
          const key = keyOf(record);
          if (key === undefined || key === null) throw new Error(`A record in "${name}" has no id, so it cannot be saved.`);
          const id = String(key);
          if (after.has(id)) throw new Error(`Two records in "${name}" share the id ${id}.`);
          const json = JSON.stringify([pos, record]);
          after.set(id, json);
          if (before.get(id) !== json) ops.push({ replaceOne: { filter: { _id: id }, replacement: { _id: id, _pos: pos, ...record }, upsert: true } });
        });
        for (const id of before.keys()) if (!after.has(id)) ops.push({ deleteOne: { filter: { _id: id } } });
        if (ops.length) await database.collection(name).bulkWrite(ops, { ordered: false });
        written.set(name, after);
        if (seenIn(STATE).get(name) !== 'list') stateOps.push([name, { _id: name, kind: 'list' }, 'list']);
      } else {
        const json = JSON.stringify(value);
        if (seenIn(STATE).get(name) !== json) stateOps.push([name, { _id: name, kind: 'value', value }, json]);
      }
    }
    if (stateOps.length) await database.collection(STATE).bulkWrite(stateOps.map(([, doc]) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })), { ordered: false });
    for (const [name, , mark] of stateOps) seenIn(STATE).set(name, mark);
  }

  let running = null, again = false;
  // Resolves true when MongoDB holds everything up to the latest change, false if a write failed.
  function sync(data) {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await write(data); } while (again);
        return true;
      } catch (error) {
        console.error(`Could not save to MongoDB, will retry: ${error.message}`);
        return false;
      } finally { running = null; }
    })();
    return running;
  }
  return { prime, sync };
}

export function mongoImages(database) {
  const images = database.collection('images');
  return {
    async put(name, bytes, isPublic) { await images.replaceOne({ _id: name }, { _id: name, data: bytes, public: isPublic, size: bytes.length, createdAt: new Date() }, { upsert: true }); },
    async get(name) { const doc = await images.findOne({ _id: name }); return doc && { bytes: Buffer.from(doc.data.buffer), public: doc.public }; },
    async setPublic(name, isPublic) { await images.updateOne({ _id: name }, { $set: { public: isPublic } }); },
    async remove(name) { await images.deleteOne({ _id: name }); },
    async info(name) { return images.findOne({ _id: name }, { projection: { data: 0 } }); },
  };
}
