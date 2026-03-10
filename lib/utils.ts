// eslint-disable-next-line import/no-nodejs-modules
import type { EventEmitter } from 'node:events';
import type { ITimeZoneRepresentation } from '@comunica/types';
import type { Term } from '@rdfjs/types';

export function eventToPromise(event: EventEmitter): Promise<void> {
  return new Promise((resolve, reject) =>
    event.on('end', resolve).on('error', reject));
}

export function reverse(str: string): string {
  return [ ...str ].reverse().join('');
}

export function extractTimeZone(date: Date): ITimeZoneRepresentation {
  return {
    zoneHours: date.getTimezoneOffset() / 60,
    zoneMinutes: date.getTimezoneOffset() % 60,
  };
}

export const prefixCrdt = 'https://rdf-set-crdt.knows.idlab.ugent.be/';

/**
 * <> a CRDT:container .
 *
 * :a :b :c .
 * [] CRDT:tagging <<( :a :b :c )>> ;
 *    CRDT:add "10591359-7b29-44f1-99df-e2e2bbf53adc"^^CRDT:uuid
 *    CRDT:delete "2010-06-21T11:28:01Z---b4074a77-f529-4bfc-95f5-008b2f777261"^^CRDT:stamp-uuid
 *    CRDT:delete "c269c6ec-b9b5-487e-aa93-f118b5af6842"^^CRDT:uuid
 */
export enum CRDT {
  CONTAINER = `https://rdf-set-crdt.knows.idlab.ugent.be/container`,
  TAGGING = `https://rdf-set-crdt.knows.idlab.ugent.be/tagging`,
  ADD = `https://rdf-set-crdt.knows.idlab.ugent.be/add`,
  DELETE = `https://rdf-set-crdt.knows.idlab.ugent.be/delete`,
  DT_UUID = `https://rdf-set-crdt.knows.idlab.ugent.be/uuid`,
  // When nodes agree that everyone should sink every T seconds, you can remove gravestones older than 2T:
  // Worst case, B syncs, A add and syncs, then removes;
  // T after sync B: B syncs and sees A's add, afterward, A syncs the delete (now T old)
  // T after last B sync: B now sees the remove of A even-though it happened 2T ago.
  // A sufficient grace period is needed to cover clock drift and Web latency: we can only delete after 2T + X.
  // Constructed as `${uuid}--${xsd-dateTime-lexical}`: https://www.w3.org/TR/xmlschema-2/#dateTime
  DT_STAMP_UUID = `https://rdf-set-crdt.knows.idlab.ugent.be/stamp-uuid`,
}

export function termString(term: Term): string {
  // Works since no termType is a prefix of another termType
  return `${term.termType}${term.value}`;
}

export function attachEvent(from: EventEmitter, to: EventEmitter): void {
  from.on('data', data => to.emit('data', data));
  from.on('error', error => to.emit('error', error));
  from.on('end', () => to.emit('end'));
}
