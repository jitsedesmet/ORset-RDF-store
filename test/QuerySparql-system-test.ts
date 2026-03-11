import type { Server } from 'node:http';
import { QueryEngine } from '@comunica/query-sparql';
import type * as RDF from '@rdfjs/types';
import { RdfStore } from 'rdf-stores';
import { DataFactoryUuid } from '../lib/DataFactoryUuid';
import { WebSyncedStore } from '../lib/WebSyncedStore';
import { startServer, stopServer, TEST_SERVER_PORT } from './public/webserver';
import { getIter, getStoreIter, promiseWait } from './utils';

const webSource = `http://localhost:${TEST_SERVER_PORT}/test.nq`;

describe('System test: QuerySparql', () => {
  let engineA: QueryEngine;
  let engineB: QueryEngine;
  let server: Server;

  beforeAll(async() => {
    server = await startServer(TEST_SERVER_PORT);
    engineA = new QueryEngine();
    engineB = new QueryEngine();
  });

  afterAll(async() => {
    await stopServer(server);
  });

  /**
   * Clear the running webserver
   */
  async function clearRemote(): Promise<void> {
    const DF1 = new DataFactoryUuid();
    const crdtClear = new WebSyncedStore({ dataFactory: DF1, webSource });
    // Clear server completely
    await crdtClear.pullData();
    (<any> crdtClear).store = RdfStore.createDefault();
    await crdtClear.pushData();
    await expect(getStoreIter(crdtClear).toArray()).resolves.toHaveLength(0);
  }

  it('two stores syncing data', async() => {
    await clearRemote();
    const DFA = new DataFactoryUuid();
    const DFB = new DataFactoryUuid();
    const crdtA = new WebSyncedStore({ dataFactory: DFA, webSource, webSyncInterval: 100 });
    const crdtB = new WebSyncedStore({ dataFactory: DFB, webSource, webSyncInterval: 150 });
    const longTime = 1_000;
    await promiseWait(longTime);

    // Starting for a synced state, now add in store and engine A
    const result = <RDF.QueryVoid> await engineA.query(`INSERT DATA {
          <ex:s> <ex:p> <ex:o>.
        }`, {
      sources: [ crdtA ],
      destination: crdtA,
    });
    await result.execute();

    // When waiting a long time, both stores will have synced the server and seen the added triple
    await promiseWait(longTime);
    await expect(getIter(crdtA).toArray()).resolves.toHaveLength(1);
    await expect(getIter(crdtB).toArray()).resolves.toHaveLength(1);

    // This also reflects when querying using engine and store B
    const resQueryB = await engineB.queryBindings(`SELECT * { ?s ?p ?o }`, { sources: [ crdtB ]});
    await expect(resQueryB.toArray()).resolves.toHaveLength(1);

    // Stop synchronization of the stores, allowing program to exit
    await Promise.all([ crdtA.stop(), crdtB.stop() ]);
  });

  it('two stores working independently', async() => {
    await clearRemote();
    const DFA = new DataFactoryUuid();
    const DFB = new DataFactoryUuid();
    const crdtA = new WebSyncedStore({ dataFactory: DFA, webSource, webSyncInterval: 100 });
    const crdtB = new WebSyncedStore({ dataFactory: DFB, webSource, webSyncInterval: 150 });
    const longTime = 1_000;
    await promiseWait(longTime);

    // A list of operation A will do (concurrently with B)
    const engineAExec = (async() => {
      const result = <RDF.QueryVoid> await engineA.query(`INSERT DATA {
          <ex:s> <ex:p> <ex:o>.
        }`, {
        sources: [ crdtA ],
        destination: crdtA,
      });
      await result.execute();

      // After waiting long, B removed the triple
      await promiseWait(longTime * 2);
      const bindings = await engineB.queryBindings(`SELECT * { ?s ?p ?o }`, { sources: [ crdtA ]});
      await expect(bindings.toArray()).resolves.toHaveLength(0);
    })();
    // Operations B will do (concurrent with A)
    const engineBExec = (async() => {
      // Query the data, will be empty because we have not synced
      let bindings = await engineB.queryBindings(`SELECT * { ?s ?p ?o }`, { sources: [ crdtB ]});
      await expect(bindings.toArray()).resolves.toHaveLength(0);

      // After waiting long, you will see the insert of A.
      await promiseWait(longTime);
      bindings = await engineB.queryBindings(`SELECT * { ?s ?p ?o }`, { sources: [ crdtB ]});
      await expect(bindings.toArray()).resolves.toHaveLength(1);

      // Now let's remove that insert
      const update = <RDF.QueryVoid> await engineB.query(`DELETE WHERE { ?s ?p ?o }`, {
        sources: [ crdtB ],
        destination: crdtB,
      });
      await update.execute();
      // Locally we see the disappearance.
      bindings = await engineB.queryBindings(`SELECT * { ?s ?p ?o }`, { sources: [ crdtB ]});
      await expect(bindings.toArray()).resolves.toHaveLength(0);
    })();

    // Sync point between A and B
    await Promise.all([ engineAExec, engineBExec ]);

    await Promise.all([ crdtA.stop(), crdtB.stop() ]);
  });
});
