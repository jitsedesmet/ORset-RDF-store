import type { Quad, Store, Term } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { wrap } from 'asynciterator';
import type { CrdtStore } from '../lib';

export function getStore(crdt: CrdtStore): Store {
  return (<any>crdt).store;
}

export function getIter(crdt: CrdtStore): AsyncIterator<Quad> {
  return wrap(crdt.match());
}

export function getStoreIter(
  crdt: CrdtStore,
  ...rest: Parameters<CrdtStore['match']>
): AsyncIterator<Quad> {
  return wrap(getStore(crdt).match(...rest));
}

export function termString(term: Term): string {
  switch (term.termType) {
    case 'Quad':
      return `${termString(term.subject)};${termString(term.predicate)};${termString(term.object)}`;
    default:
      return `${term.termType}${term.value}`;
  }
}

export function compareTerm(a: Term, b: Term): number {
  return termString(a).localeCompare(termString(b));
}
