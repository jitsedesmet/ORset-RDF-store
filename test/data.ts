import type { Quad, Stream } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { RdfStore } from 'rdf-stores';
import { CRDT } from '../lib';

const DF = new DataFactory();
export const prefix = `https://jitsedesmet.be/`;

function uuid(val: string) {
  return DF.literal(val, DF.namedNode(CRDT.DT_UUID));
}

export const addTag = uuid('10591359-7b29-44f1-99df-e2e2bbf53adc');
export const delTag = uuid('c269c6ec-b9b5-487e-aa93-f118b5af6842');

export function basicTestContent(DF: DataFactory): Stream & AsyncIterator<Quad> {
  const testStore = RdfStore.createDefault();

  const triple = DF.quad(DF.namedNode(`${prefix}a`), DF.namedNode(`${prefix}b`), DF.namedNode(`${prefix}c`));
  testStore.addQuad(triple);
  const metaBlank = DF.blankNode();

  testStore.addQuad(DF.quad(metaBlank, DF.namedNode(CRDT.TAGGING), triple));
  testStore.addQuad(DF.quad(metaBlank, DF.namedNode(CRDT.ADD), addTag));
  testStore.addQuad(DF.quad(metaBlank, DF.namedNode(CRDT.DELETE), delTag));

  return testStore.match();
}
