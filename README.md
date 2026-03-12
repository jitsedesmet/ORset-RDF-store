# OR-Set RDF Datastore

[![npm version](https://badge.fury.io/js/orset-rdf-store.svg)](https://www.npmjs.com/package/orset-rdf-store)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.txt)

A proof-of-concept **[RDFjs](https://rdf.js.org/)**-compliant RDF triple store that implements an **add-wins OR-Set CRDT**, enabling conflict-free concurrent writes to RDF datasets over HTTP with eventual consistency.

---

## Table of Contents

- [Overview](#overview)
- [Key Concepts](#key-concepts)
- [Install](#install)
- [Quickstart](#quickstart)
  - [Basic usage – add and remove triples](#basic-usage--add-and-remove-triples)
  - [Merging two local stores (offline-first)](#merging-two-local-stores-offline-first)
  - [Web-synced store (automatic HTTP synchronization)](#web-synced-store-automatic-http-synchronization)
  - [Querying with SPARQL (Comunica)](#querying-with-sparql-comunica)
- [API](#api)
  - [CrdtStore](#crdtstore)
  - [WebSyncedStore](#websyncedstore)
  - [DataFactoryUuid](#datafactoryuuid)
  - [CRDT vocabulary constants](#crdt-vocabulary-constants)
- [Internal Data Model](#internal-data-model)
- [Server Requirements](#server-requirements)
- [Tombstone Expiration](#tombstone-expiration)
- [Limitations](#limitations)

---

## Overview

`orset-rdf-store` lets multiple clients read and write the same RDF graph concurrently—even while offline—and later reconcile their changes without conflicts.

The core idea is the **OR-Set** (Observed-Remove Set) CRDT:

- Every added triple is tagged with a unique identifier (UUID).
- Removing a triple records the UUIDs of all add-tags that were known at removal time.
- When two replicas merge, a triple survives if and only if at least one of its add-tags is **not** covered by a removal. This gives **add-wins** semantics: concurrent add and remove of the same triple always keeps the triple.

The metadata required by the CRDT is stored inline inside the RDF dataset using **RDF 1.2 triple terms** (quoted triples), keeping the representation self-contained in a single RDF document.

---

## Key Concepts

| Term            | Meaning                                                                                                                |
|-----------------|------------------------------------------------------------------------------------------------------------------------|
| **CRDT**        | Conflict-free Replicated Data Type – a data structure that can be merged without coordination                          |
| **OR-Set**      | Observed-Remove Set – an add-wins variant of a CRDT set                                                                |
| **Add-wins**    | When an add and a remove of the same element happen concurrently, the add takes precedence                             |
| **Triple term** | An RDF 1.2 feature that allows an entire triple (subject, predicate, object) to appear as the object of another triple |
| **Tombstone**   | A deletion marker that is kept until all peers have observed the removal                                               |
| **ETag**        | HTTP mechanism used to detect mid-air collisions when pushing data to a server                                         |

---

## Install

```bash
npm install orset-rdf-store
# or
yarn add orset-rdf-store
```

---

## Quickstart

All examples use TypeScript. The package ships compiled JavaScript so plain JavaScript works identically.

### Basic usage – add and remove triples

```typescript
import { wrap } from 'asynciterator';
import { DataFactoryUuid } from 'orset-rdf-store/lib/DataFactoryUuid';
import { CrdtStore } from 'orset-rdf-store';

const DF = new DataFactoryUuid();
const store = new CrdtStore({ dataFactory: DF });

// --- Add a triple ---
const triple = DF.quad(
  DF.namedNode('https://example.org/Alice'),
  DF.namedNode('https://example.org/knows'),
  DF.namedNode('https://example.org/Bob'),
);

await new Promise<void>((resolve, reject) =>
  store.import(wrap([triple])).on('end', resolve).on('error', reject),
);

// --- Query (returns only data triples, not internal CRDT metadata) ---
const quads = await wrap(store.match()).toArray();
console.log(quads.length); // 1

// --- Remove a triple ---
await new Promise<void>((resolve, reject) =>
  store.remove(wrap([triple])).on('end', resolve).on('error', reject),
);

const quadsAfterRemove = await wrap(store.match()).toArray();
console.log(quadsAfterRemove.length); // 0
```

### Merging two local stores (offline-first)

The `crdtMerge` method implements the state-based CRDT merge: it is commutative, associative, and idempotent.

```typescript
import { wrap } from 'asynciterator';
import { CrdtStore } from 'orset-rdf-store';
import { DataFactoryUuid } from 'orset-rdf-store/lib/DataFactoryUuid';

function waitForEvent(emitter: import('node:events').EventEmitter): Promise<void> {
  return new Promise((resolve, reject) => emitter.on('end', resolve).on('error', reject));
}

const DF1 = new DataFactoryUuid();
const DF2 = new DataFactoryUuid();

const storeA = new CrdtStore({ dataFactory: DF1 });
const storeB = new CrdtStore({ dataFactory: DF2 });

const tripleA = DF1.quad(
  DF1.namedNode('https://example.org/Alice'),
  DF1.namedNode('https://example.org/knows'),
  DF1.namedNode('https://example.org/Bob'),
);
const tripleB = DF2.quad(
  DF2.namedNode('https://example.org/Bob'),
  DF2.namedNode('https://example.org/knows'),
  DF2.namedNode('https://example.org/Carol'),
);

// Both clients add triples independently (offline)
await waitForEvent(storeA.import(wrap([tripleA])));
await waitForEvent(storeB.import(wrap([tripleB])));

// Merge A into B and B into A  →  both stores converge
await waitForEvent(storeA.crdtMerge(storeB));
await waitForEvent(storeB.crdtMerge(storeA));

console.log((await wrap(storeA.match()).toArray()).length); // 2
console.log((await wrap(storeB.match()).toArray()).length); // 2

// --- Demonstrate add-wins ---
// B removes tripleA while A simultaneously re-adds it (no sync in between)
const storeC = new CrdtStore({ dataFactory: new DataFactoryUuid() });
const storeD = new CrdtStore({ dataFactory: new DataFactoryUuid() });

const sharedTriple = DF1.quad(
  DF1.namedNode('https://example.org/subject'),
  DF1.namedNode('https://example.org/predicate'),
  DF1.namedNode('https://example.org/object'),
);

await waitForEvent(storeC.import(wrap([sharedTriple])));
await waitForEvent(storeC.crdtMerge(storeD));
await waitForEvent(storeD.crdtMerge(storeC));

// C removes the triple; D independently re-adds it
await waitForEvent(storeC.removeMatches());
await waitForEvent(storeD.import(wrap([sharedTriple])));

// After merging, add-wins: the triple survives
await waitForEvent(storeC.crdtMerge(storeD));
await waitForEvent(storeD.crdtMerge(storeC));
console.log((await wrap(storeC.match()).toArray()).length); // 1 – add wins!
console.log((await wrap(storeD.match()).toArray()).length); // 1
```

### Web-synced store (automatic HTTP synchronization)

`WebSyncedStore` extends `CrdtStore` with automatic periodic pull/push synchronization against an HTTP server that supports conditional `PUT` with ETags.

```typescript
import { WebSyncedStore } from 'orset-rdf-store/lib/WebSyncedStore';
import { DataFactoryUuid } from 'orset-rdf-store/lib/DataFactoryUuid';
import { wrap } from 'asynciterator';

const DFA = new DataFactoryUuid();
const DFB = new DataFactoryUuid();

// Both clients point at the same remote resource.
// webSyncInterval (ms) controls how often they poll the server.
const storeA = new WebSyncedStore({
  dataFactory: DFA,
  webSource: 'https://my-pod.example/data.nq',
  webSyncInterval: 2_000, // sync every 2 seconds
});

const storeB = new WebSyncedStore({
  dataFactory: DFB,
  webSource: 'https://my-pod.example/data.nq',
  webSyncInterval: 3_000,
});

// Wait for first sync cycle to complete
await new Promise(resolve => setTimeout(resolve, 5_000));

// Store A adds a triple; it will propagate to B on the next sync cycle
const triple = DFA.quad(
  DFA.namedNode('https://example.org/s'),
  DFA.namedNode('https://example.org/p'),
  DFA.namedNode('https://example.org/o'),
);
await new Promise<void>((resolve, reject) =>
  storeA.import(wrap([triple])).on('end', resolve).on('error', reject),
);

// Wait long enough for both stores to sync
await new Promise(resolve => setTimeout(resolve, 6_000));

const quads = await wrap(storeB.match()).toArray();
console.log(quads.length); // 1

// Stop the background sync loops before exiting
await Promise.all([storeA.stop(), storeB.stop()]);
```

You can also drive synchronization manually:

```typescript
import { WebSyncedStore } from 'orset-rdf-store/lib/WebSyncedStore';
import { DataFactoryUuid } from 'orset-rdf-store/lib/DataFactoryUuid';
import { wrap } from 'asynciterator';

const store = new WebSyncedStore({
  dataFactory: new DataFactoryUuid(),
  webSource: 'https://my-pod.example/data.nq',
  // omit webSyncInterval (or set to 0) to disable automatic background sync
});

// Fetch the remote state and merge it into the local store
await store.pullData();

// Make local changes
const triple = store['DF'].quad(
  store['DF'].namedNode('https://example.org/s'),
  store['DF'].namedNode('https://example.org/p'),
  store['DF'].namedNode('https://example.org/o'),
);
await new Promise<void>((resolve, reject) =>
  store.import(wrap([triple])).on('end', resolve).on('error', reject),
);

// Push the merged state back to the server
await store.pushData();
```

### Querying with SPARQL (Comunica)

`CrdtStore` implements the `@rdfjs/types` `Store` interface, so it works as both a source and a destination for the [Comunica](https://comunica.dev/) query engine.

```typescript
import { QueryEngine } from '@comunica/query-sparql';
import type * as RDF from '@rdfjs/types';
import { WebSyncedStore } from 'orset-rdf-store/lib/WebSyncedStore';
import { DataFactoryUuid } from 'orset-rdf-store/lib/DataFactoryUuid';

const engine = new QueryEngine();
const store = new WebSyncedStore({
  dataFactory: new DataFactoryUuid(),
  webSource: 'https://my-pod.example/data.nq',
  webSyncInterval: 2_000,
});

// Wait for initial sync
await new Promise(resolve => setTimeout(resolve, 3_000));

// INSERT via SPARQL
const insert = await engine.query<RDF.QueryVoid>(`
  INSERT DATA {
    <https://example.org/Alice> <https://example.org/knows> <https://example.org/Bob> .
  }
`, { sources: [store], destination: store });
await insert.execute();

// SELECT via SPARQL
const bindingsStream = await engine.queryBindings(`SELECT * { ?s ?p ?o }`, {
  sources: [store],
});
const bindings = await bindingsStream.toArray();
console.log(bindings.length); // 1

// DELETE via SPARQL
const del = await engine.query<RDF.QueryVoid>(`DELETE WHERE { ?s ?p ?o }`, {
  sources: [store],
  destination: store,
});
await del.execute();

await store.stop();
```

---

## API

### DataFactoryUuid

```typescript
import { DataFactoryUuid } from 'orset-rdf-store/lib/DataFactoryUuid';
```

A thin extension of `rdf-data-factory`'s `DataFactory` that generates globally-unique UUID-based blank node identifiers instead of sequential labels. This is required so that blank nodes used as CRDT taggers remain unique across independently operating replicas that never coordinate blank-node allocation.

### CRDT vocabulary constants

```typescript
import { CRDT } from 'orset-rdf-store';
```

The `CRDT` enum exposes the URIs used for CRDT metadata predicates and datatypes:

| Constant             | URI               | Description                                                                     |
|----------------------|-------------------|---------------------------------------------------------------------------------|
| `CRDT.CONTAINER`     | `crdt:container`  | Type of a CRDT-managed document                                                 |
| `CRDT.TAGGING`       | `crdt:tagging`    | Links a blank-node tagger to the triple term it tracks                          |
| `CRDT.ADD`           | `crdt:add`        | Add-tag: UUID literal identifying one "add" of a triple                         |
| `CRDT.DELETE`        | `crdt:delete`     | Remove-tag: UUID (or stamped UUID) literal identifying one "remove"             |
| `CRDT.DT_UUID`       | `crdt:uuid`       | Datatype for a plain UUID add/remove tag                                        |
| `CRDT.DT_STAMP_UUID` | `crdt:stamp-uuid` | Datatype for a timestamped UUID remove-tag (used when `expirationDuration > 0`) |

With the prefix `crdt:` resolving to `https://rdf-set-crdt.knows.idlab.ugent.be/`.

---

## Internal Data Model

The CRDT metadata is stored as regular RDF quads alongside the data triples. For each data triple `<s> <p> <o>`, the store maintains:

```turtle
# The data triple itself
<s> <p> <o> .

# A blank-node "tagger" that is associated with the triple term via RDF 1.2 quoted-triple syntax
_:tagger  crdt:tagging  <<( <s> <p> <o> )>> .

# One add-tag per "add" operation (UUID literal)
_:tagger  crdt:add     "550e8400-e29b-41d4-a716-446655440000"^^crdt:uuid .

# One remove-tag per "remove" operation (UUID or stamped-UUID literal)
_:tagger  crdt:delete  "07d9c9a0-3e54-4e2a-ab1e-000000000001"^^crdt:uuid .
```

A triple is **visible** (returned by `match()`) if and only if at least one of its add-tags is **not** referenced by any of its remove-tags.
In practice, the `crdt:add` triple gets removed since it contains no additional information.

The N-Quads serialization of this structure is what gets stored on the server and exchanged between replicas.

---

## Server Requirements

`WebSyncedStore` requires an HTTP server that:

1. Serves the RDF document as N-Quads (`application/n-quads`) via `GET`.
2. Returns a strong `ETag` response header on every `GET` and successful `PUT`.
3. Accepts conditional `PUT` requests with an `If-Match` header and returns `412 Precondition Failed` when the ETag does not match.

A minimal reference implementation (used in the test suite) can be found in [`test/public/webserver.ts`](test/public/webserver.ts). Any [Solid](https://solidproject.org/) server or a simple ETag-aware HTTP storage server (e.g. [Community Solid Server](https://communitysolidserver.github.io/CommunitySolidServer/)) satisfies these requirements.

---

## Tombstone Expiration

Without tombstone expiration, removed triples leave behind permanent delete-tags.
This prevents the store from growing unboundedly in long-lived deployments.
You can enable expiration by providing an `expirationDuration` (in seconds):

```typescript
const store = new CrdtStore({
  dataFactory: new DataFactoryUuid(),
  expirationDuration: 60 * 60 * 24, // tombstones expire after 24 hours
});
```

When `expirationDuration > 0`:

- Remove-tags are stored as **stamped UUIDs** (`crdt:stamp-uuid`) that embed the timestamp of the deletion.
- During `crdtMerge`, remove-tags older than `expirationDuration` are silently discarded.
- After discarding, orphaned taggers can be cleaned up with `cleanTaggers()`.

> **Important:** To guarantee correctness, `expirationDuration` must be at least **the sync interval + 4000s** as a safety margin for clock drift. If a tombstone expires before all peers have seen it, a previously deleted triple may reappear.

---

## Limitations

- **Proof of concept:** This library is not production-hardened. It is intended to demonstrate the feasibility of OR-Set CRDTs for RDF datasets.
- **In-memory only:** The underlying store is held in memory. There is currently no persistence layer.
- **N-Quads serialization only:** `WebSyncedStore` serializes data as N-Quads. Other RDF serializations are not supported for the sync protocol.
- **No access control:** The library does not implement any authentication or authorization. Securing the HTTP endpoint is left to the deployment.

---

## License

[MIT](LICENSE.txt)
