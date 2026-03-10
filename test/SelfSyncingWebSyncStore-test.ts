import { wrap } from 'asynciterator';
import { RdfStore } from 'rdf-stores';
import { DataFactoryUuid } from '../lib/DataFactoryUuid';
import { eventToPromise } from '../lib/utils';
import { WebSyncedStore } from '../lib/WebSyncedStore';
import { prefix } from './data';
import { getIter, getStoreIter } from './utils';

describe('Web Synced Store auto', () => {
  const DF = new DataFactoryUuid();

  it('store A and B can work independently and over time will sync', async() => {
    const DF1 = new DataFactoryUuid();
    const DF2 = new DataFactoryUuid();
    const crdtClear = new WebSyncedStore({ dataFactory: DF1, webSource: 'http://localhost:3000/test.nq' });
    // Clear server completely
    await crdtClear.pullData();
    (<any> crdtClear).store = RdfStore.createDefault();
    await crdtClear.pushData();
    await expect(getStoreIter(crdtClear).toArray()).resolves.toHaveLength(0);

    // Our two crdt's that will talk
    const crdt1 = new WebSyncedStore({ dataFactory: DF1, webSource: 'http://localhost:3000/test.nq', webSyncInterval: 100 });
    const crdt2 = new WebSyncedStore({ dataFactory: DF2, webSource: 'http://localhost:3000/test.nq', webSyncInterval: 150 });
    const longTime = 1000;

    const testTripleA = DF.quad(DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`));
    const testTripleB = DF.quad(DF.namedNode(`${prefix}b`), DF.namedNode(`${prefix}b`), DF.namedNode(`${prefix}b`));
    const testTripleC = DF.quad(DF.namedNode(`${prefix}c`), DF.namedNode(`${prefix}c`), DF.namedNode(`${prefix}c`));

    const addAto1 = eventToPromise(crdt1.import(wrap([ testTripleA ])));
    const addBto1 = eventToPromise(crdt2.import(wrap([ testTripleB ])));
    const addCto1 = eventToPromise(crdt1.import(wrap([ testTripleC ])));
    const addCto2 = eventToPromise(crdt2.import(wrap([ testTripleC ])));

    await new Promise(resolve => setTimeout(resolve, longTime));
    await expect(getIter(crdt1).toArray()).resolves.toHaveLength(3);
    await expect(getIter(crdt2).toArray()).resolves.toHaveLength(3);

    const delAfrom1 = eventToPromise(crdt1.remove(wrap([ testTripleA ])));
    const delCfrom1 = eventToPromise(crdt1.remove(wrap([ testTripleC ])));

    await new Promise(resolve => setTimeout(resolve, longTime));
    await expect(getIter(crdt1).toArray()).resolves.toHaveLength(1);
    await expect(getIter(crdt2).toArray()).resolves.toHaveLength(1);

    await Promise.all([ addAto1, addBto1, addCto1, addCto2, delAfrom1, delCfrom1 ]);
    crdt1.webSyncInterval = 0;
    crdt2.webSyncInterval = 0;
  });
});
