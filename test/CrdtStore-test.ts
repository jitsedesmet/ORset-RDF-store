import { expect } from '@playwright/test';
import { wrap } from 'asynciterator';
import type { Literal } from 'n3';
import { DataFactory } from 'rdf-data-factory';
import { CRDT, CrdtStore } from '../lib';
import type { CrdtStoreArgs } from '../lib/CrdtStore';
import { DataFactoryUuid } from '../lib/DataFactoryUuid';
import { eventToPromise } from '../lib/utils';
import { basicTestContent, prefix } from './data';
import { compareTerm, getIter, getStore, getStoreIter, termString } from './utils';

describe('Crdt Store', () => {
  const DF = new DataFactoryUuid();

  it('filters out CRDT triples', async() => {
    const crdt = new CrdtStore({ dataFactory: DF, initialCrdtState: basicTestContent(DF) });

    await expect(getStoreIter(crdt).toArray()).resolves.toHaveLength(4);
    await expect(getIter(crdt).toArray()).resolves.toHaveLength(1);
  });

  it('is idempotent', async() => {
    for (let times = 0; times < 10; times++) {
      const content = basicTestContent(DF);
      const crdt1 = new CrdtStore({ dataFactory: DF, initialCrdtState: content });
      // When not running the merge, blank node labels otherwise differ
      const crdt2 = new CrdtStore({ dataFactory: DF, initialCrdtState: times ? basicTestContent(DF) : content });

      for (let i = 0; i < times; i++) {
        await eventToPromise(crdt1.crdtMerge(crdt2));
      }
      await expect(wrap(crdt1.match()).toArray()).resolves.toHaveLength(1);
      await expect(wrap(getStore(crdt1).match()).toArray()).resolves.toHaveLength(4);

      await expect(getStoreIter(crdt1).toArray()
        .then(x => x.sort(compareTerm)), `running ${times}x`)
        .resolves.toEqual((await getStoreIter(crdt2).toArray()).sort(compareTerm));
    }
  });

  it('registers removal', async() => {
    for (let times = 1; times < 10; times++) {
      const crdt1 = new CrdtStore({ dataFactory: DF, initialCrdtState: basicTestContent(DF) });
      const crdt2 = new CrdtStore({ dataFactory: DF, initialCrdtState: basicTestContent(DF) });
      await expect(getIter(crdt1).toArray()).resolves.toHaveLength(1);

      // Test idempotence remove
      for (let i = 0; i < times; i++) {
        await new Promise((resolve, reject) =>
          crdt1.removeMatches().on('end', resolve).on('error', reject));
        // Console.log('remove');
      }
      await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(3);
      await expect(getStoreIter(crdt1, null, DF.namedNode(CRDT.DELETE)).toArray()).resolves.toHaveLength(2);

      await eventToPromise(crdt1.crdtMerge(crdt2));
      await expect(wrap(getStore(crdt1).match()).toArray()).resolves.toHaveLength(3);
      await expect(getIter(crdt1).toArray()).resolves.toHaveLength(0);
    }
  });

  it('registers addition', async() => {
    for (let times = 1; times < 10; times++) {
      const crdt1 = new CrdtStore({ dataFactory: DF, initialCrdtState: basicTestContent(DF) });
      const crdt2 = new CrdtStore({ dataFactory: DF, initialCrdtState: basicTestContent(DF) });
      await new Promise((resolve, reject) =>
        crdt1.removeMatches(null, null, null).on('end', resolve).on('error', reject));
      await eventToPromise(crdt1.crdtMerge(crdt2));

      // Test add external idempotence, internal non-idempotence
      for (let i = 0; i < times; i++) {
        await new Promise((resolve, reject) => crdt1.import(wrap([
          DF.quad(DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}b`), DF.namedNode(`${prefix}c`)),
        ])).on('end', resolve).on('error', reject));
      }
      await expect(getIter(crdt1).toArray()).resolves.toHaveLength(1);
      await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(4 + times);

      const inner1 = await getStoreIter(crdt1).toArray();
      await eventToPromise(crdt1.crdtMerge(crdt2));
      // Crdt1 should be unchanged
      await expect(getStoreIter(crdt1).toArray().then(x => x.sort(compareTerm)))
        .resolves.toEqual(inner1.sort(compareTerm));

      // CRDT2 is different to CRDT1
      await expect(getStoreIter(crdt1).toArray().then(x => x.sort(compareTerm)))
        .resolves.not.toEqual((await getStoreIter(crdt2).toArray()).sort(compareTerm));

      // After merging CRDT1 in CRDT2 - they will be equal
      await eventToPromise(crdt2.crdtMerge(crdt1));
      await expect(getStoreIter(crdt1).toArray().then(x => x.sort(compareTerm)))
        .resolves.toEqual((await getStoreIter(crdt2).toArray()).sort(compareTerm));
    }
  });

  it('does not break merge when adding to both CRDTs', async() => {
    const failTest = false;
    const DF1 = <DataFactoryUuid> (failTest ? new DataFactory({ blankNodePrefix: 'bnode' }) : new DataFactoryUuid());
    const DF2 = <DataFactoryUuid> (failTest ? new DataFactory({ blankNodePrefix: 'bnode' }) : new DataFactoryUuid());
    const crdt1 = new CrdtStore({ dataFactory: DF1, initialCrdtState: basicTestContent(DF1) });
    await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(4);
    const crdt2 = new CrdtStore({ dataFactory: DF2, initialCrdtState: basicTestContent(DF2) });

    // Separate DFs result in same construction
    if (failTest) {
      await expect(getStoreIter(crdt1).toArray().then(x => x.sort(compareTerm)))
        .resolves.toEqual((await getStoreIter(crdt2).toArray()).sort(compareTerm));
    }

    await new Promise((resolve, reject) =>
      crdt1.import(wrap([ DF.quad(DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`)) ]))
        .on('end', resolve).on('error', reject));
    await new Promise((resolve, reject) =>
      crdt2.import(wrap([ DF.quad(DF.namedNode(`${prefix}b`), DF.namedNode(`${prefix}b`), DF.namedNode(`${prefix}b`)) ]))
        .on('end', resolve).on('error', reject));
    await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(7);
    await expect(getStoreIter(crdt2).toArray()).resolves.toHaveLength(7);
    await expect(getStoreIter(crdt1).toArray().then(x => x.sort(compareTerm)))
      .resolves.not.toEqual((await getStoreIter(crdt2).toArray()).sort(compareTerm));
    await eventToPromise(crdt1.crdtMerge(crdt2));
    await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(10);
    // After merging, the structure should still be correct.
    // (Each reifies has a different node (definition of blank node usage))
    const taggers = await getStoreIter(crdt1, null, DF.namedNode(CRDT.TAGGING)).toArray();
    const taggersSet = new Set<string>();
    for (const tagger of taggers) {
      taggersSet.add(termString(tagger.subject));
    }
    expect(taggersSet.size).toBeGreaterThan(0);
    expect(taggersSet.size).toEqual(taggers.length);
  });

  it('does not care about removing non-existing', async() => {
    const crdt1 = new CrdtStore({ dataFactory: DF, initialCrdtState: basicTestContent(DF) });
    await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(4);
    await new Promise((resolve, reject) =>
      crdt1.remove(wrap([ DF.quad(DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`)) ]))
        .on('end', resolve).on('error', reject));
    await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(4);
  });

  it('timestamps tombstones when asked', async() => {
    const crdt1 = new CrdtStore({ dataFactory: DF });
    const crdt2 = new CrdtStore({ dataFactory: DF, expirationDuration: 60 * 60 * 5 });
    const testTriple = DF.quad(DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`));
    await eventToPromise(crdt1.import(wrap([ testTriple ])));
    await eventToPromise(crdt2.import(wrap([ testTriple ])));
    await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(3);
    await expect(getStoreIter(crdt2).toArray()).resolves.toHaveLength(3);

    await eventToPromise(crdt1.removeMatches());
    await eventToPromise(crdt2.removeMatches());
    await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(2);
    await expect(getStoreIter(crdt2).toArray()).resolves.toHaveLength(2);

    await expect(getStoreIter(crdt1, null, DF.namedNode(CRDT.DELETE)).toArray().then((x) => {
      const lit = <Literal> x.at(0)?.object;
      return lit.datatype.value;
    })).resolves.toEqual(CRDT.DT_UUID);
    await expect(getStoreIter(crdt2, null, DF.namedNode(CRDT.DELETE)).toArray().then((x) => {
      const lit = <Literal> x.at(0)?.object;
      return lit.datatype.value;
    })).resolves.toEqual(CRDT.DT_STAMP_UUID);
  });

  it('merging timestamped tombstones', async() => {
    const now = new Date(Date.now());
    const args: CrdtStoreArgs = {
      dataFactory: DF,
      expirationDuration: 60 * 60 * 5,
      now: () => now,
    };
    const crdt1 = new CrdtStore(args);
    const crdt2 = new CrdtStore(args);

    const testTriple = DF.quad(DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`));
    await eventToPromise(crdt1.import(wrap([ testTriple ])));
    await eventToPromise(crdt1.crdtMerge(crdt2));
    await eventToPromise(crdt2.crdtMerge(crdt1));
    await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(3);
    await expect(getStoreIter(crdt2).toArray()).resolves.toHaveLength(3);

    await eventToPromise(crdt1.removeMatches());
    await eventToPromise(crdt1.crdtMerge(crdt2));
    await eventToPromise(crdt2.crdtMerge(crdt1));
    await expect(getStoreIter(crdt1).toArray()).resolves.toHaveLength(2);
    await expect(getStoreIter(crdt2).toArray()).resolves.toHaveLength(2);
  });

  it('merging old timestamped tombstones removes them', async() => {
    // 5 hours ago
    const oldTimeDiffMs = 1000 * 60 * 60 * 5;
    const oldTime = new Date(Date.now() - oldTimeDiffMs);
    const now = new Date(Date.now());
    const args: CrdtStoreArgs = {
      dataFactory: DF,
      expirationDuration: oldTimeDiffMs / 1000 / 3,
      now: () => now,
    };
    const crdtOld = new CrdtStore({ ...args, now: () => oldTime });
    const crdtNow = new CrdtStore(args);

    const testTriple = DF.quad(DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}a`));
    await eventToPromise(crdtOld.import(wrap([ testTriple ])));
    await eventToPromise(crdtOld.crdtMerge(crdtNow));
    await expect(getStoreIter(crdtOld).toArray()).resolves.toHaveLength(3);
    await eventToPromise(crdtOld.removeMatches());

    await eventToPromise(crdtOld.crdtMerge(crdtNow));
    await eventToPromise(crdtNow.crdtMerge(crdtOld));
    await expect(getStoreIter(crdtOld).toArray()).resolves.toHaveLength(2);
    await expect(getStoreIter(crdtNow).toArray()).resolves.toHaveLength(1);

    await eventToPromise(crdtNow.cleanTaggers());
    await expect(getStoreIter(crdtNow).toArray()).resolves.toHaveLength(0);
  });
});
