/* eslint-disable import/no-nodejs-modules */
import { EventEmitter } from 'node:events';
import type { ITimeZoneRepresentation } from '@comunica/types';
import {
  addDurationToDateTime,
  defaultedDurationRepresentation,
  parseDateTime,
  toDateTimeRepresentation,
  toUTCDate,
  DateTimeLiteral,
} from '@comunica/utils-expression-evaluator';
import type { Quad, Store, Stream, Term } from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { wrap } from 'asynciterator';
import { RdfStore } from 'rdf-stores';
import type { DataFactoryUuid } from './DataFactoryUuid';
import { attachEvent, CRDT, eventToPromise, prefixCrdt, termString, extractTimeZone } from './utils';

export interface CrdtStoreArgs {
  dataFactory: DataFactoryUuid;
  initialCrdtState?: AsyncIterator<Quad>;
  now?: () => Date;
  /**
   * When (now - expirationDuration) is higher than the tombstone tag creation date, it will be removed.
   * Provided in seconds. LTE 0 seconds means you never remove.
   */
  expirationDuration?: number;
}

/**
 * Implementation of a state-based Set CRDT (SU-set/ OR-set).
 * Has an internal store that reflects the remote data,
 * but wraps around that store to be a front for what is exported outside.
 */
export class CrdtStore implements Store {
  /**
   * List used to sequentialize all operations on the store.
   */
  public actionableList: EventEmitter[] = [];
  protected store: Store;
  protected readonly DF: DataFactoryUuid;
  protected now: () => Date;
  protected readonly expirationDuration: number;

  public constructor(args: CrdtStoreArgs) {
    this.DF = args.dataFactory;
    this.now = args.now ?? (() => new Date(Date.now()));
    this.expirationDuration = args.expirationDuration ?? 0;

    const initial = args.initialCrdtState;
    this.store = <Store> RdfStore.createDefault();
    if (initial) {
      this.sequentializeEvent(() => this.store.import(initial));
    }
  }

  public sequentializeEvent(callback: () => EventEmitter): EventEmitter {
    const lastEvent = this.actionableList.at(-1);
    const wrappedEvent = new EventEmitter();
    this.actionableList.push(wrappedEvent);
    wrappedEvent.on('end', () => this.actionableList.shift());

    if (lastEvent) {
      lastEvent.on('end', () => {
        const event = callback();
        attachEvent(event, wrappedEvent);
      });
    } else {
      const event = callback();
      attachEvent(event, wrappedEvent);
    }
    return wrappedEvent;
  }

  public deleteGraph(graph: Quad['graph'] | string): EventEmitter {
    return this.removeMatches(null, null, null, typeof graph === 'string' ? this.DF.namedNode(graph) : graph);
  }

  /**
   * Here you have the choice whether adding what was already added should still create a new Tag or not.
   * We do not perform sush a filter here.
   * @param stream
   */
  public import(stream: Stream): EventEmitter {
    return this.sequentializeEvent(() => {
      const DF = this.DF;
      const store = this.store;
      // Import stream and verify tagging
      const insertStream = wrap(stream).transform<Quad>({ transform: (quad, done, push) => {
        push(quad);
        // First check whether we already have a reifier for this triple.
        const tripleTerm = DF.quad(quad.subject, quad.predicate, quad.object);
        const graph = quad.graph;
        wrap(store.match(null, DF.namedNode(CRDT.TAGGING), tripleTerm, graph)).toArray().then((reifierRes) => {
          let reifier = reifierRes.at(0)?.subject;
          if (!reifier) {
            reifier = DF.blankNode();
            push(DF.quad(reifier, DF.namedNode(CRDT.TAGGING), tripleTerm, graph));
          }
          push(DF.quad(
            reifier,
            DF.namedNode(CRDT.ADD),
            DF.literal(crypto.randomUUID(), DF.namedNode(CRDT.DT_UUID)),
            graph,
          ));
          done();
        }).catch((error) => {
          throw error;
        });
      } });
      return this.store.import(insertStream);
    });
  }

  public match(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null,
  ): Stream & AsyncIterator<Quad> {
    // No need to sequentialize since the store is read once, changes to it do not matter.
    // Just get the triples that are not dedicated to your management structure.
    const formStoreRes = wrap(this.store.match(subject, predicate, object, graph));
    return formStoreRes
      .filter(item => item.predicate.termType === 'NamedNode' && !item.predicate.value.startsWith(prefixCrdt));
  }

  public remove(stream: Stream): EventEmitter {
    return this.sequentializeEvent(() => {
      const DF = this.DF;
      const store = this.store;
      const now = this.now();
      const timezone = extractTimeZone(now);
      const nowAsString = new DateTimeLiteral(toDateTimeRepresentation({ date: now, timeZone: timezone })).str();
      // Should remove the item itself, remove the add labels, and make remove labels with the same subj and pred
      const dataStream = wrap(stream).clone();
      const metaDataTriples = dataStream.clone()
        .transform<Quad>({
          transform: (quad, done, push) => {
            // Remove item itself
            const graph = quad.graph;
            const tripleTerm = DF.quad(quad.subject, quad.predicate, quad.object);
            // Perform lookup of add labels:
            (async() => {
              const reifierRes = await wrap(store.match(null, null, tripleTerm, graph)).toArray();
              const reifier = reifierRes.at(0)?.subject;
              // Reifier should exist since all triples are tracked. Can now look for add labels
              if (reifier) {
                const metaDataStream = store.match(reifier, DF.namedNode(CRDT.ADD), null, graph);
                metaDataStream.on('data', (data: Quad) => {
                  push(data);
                  const deleteObject = this.expirationDuration <= 0 ?
                    data.object :
                    DF.literal(`${data.object.value}--${nowAsString}`, DF.namedNode(CRDT.DT_STAMP_UUID));
                  push(DF.quad(reifier, DF.namedNode(CRDT.DELETE), deleteObject, graph));
                });
                metaDataStream.on('end', () => done());
              } else {
                done();
              }
            })().catch((err) => {
              throw err;
            });
          },
        });

      const combined = new EventEmitter();
      let ended = 0;
      function end(): void {
        ended++;
        if (ended > 1) {
          combined.emit('end');
        }
      }
      const metadataToRemove = metaDataTriples.clone().filter(data => data.predicate.value === CRDT.ADD);
      const metadataToAdd = metaDataTriples.clone().filter(data => data.predicate.value === CRDT.DELETE);
      const removeEmitter = this.store.remove(dataStream.clone().append(metadataToRemove));
      const addEmitter = this.store.import(metadataToAdd);
      removeEmitter.on('data', data => combined.emit('data', data));
      removeEmitter.on('error', error => combined.emit('error', error));
      removeEmitter.on('end', end);
      addEmitter.on('data', data => combined.emit('data', data));
      addEmitter.on('error', error => combined.emit('error', error));
      addEmitter.on('end', end);

      return combined;
    });
  }

  public removeMatches(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null,
  ): EventEmitter {
    return this.remove(this.match(subject, predicate, object, graph));
  }

  /**
   * Core of a state base CRDT - must be communicative, associative and idempotent.
   * Remove tombstones older then {@link this.expirationDuration}.
   * OR-set:
   * https://youtu.be/OqqliwwG0SM?t=613&si=QGhZoSSPLYpvlObs
   * https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type#OR-Set_(Observed-Remove_Set)
   * https://inria.hal.science/inria-00555588/document#?page=29
   */
  public async crdtMergeGraph(newStore: Store, otherStore: Store, graph: Quad['graph']): Promise<void> {
    const DF = this.DF;
    const origStore = this.store;

    // Key = termType + value
    // used for knowing what reified is used for what quad (triple term)
    // Mapping knownTagger (in newStore) to the one in origStore. (can only be one given correct merges)
    const toOrigReifier: Record<string, Quad['subject'] | undefined> = {};
    const toNewReifier: Record<string, Quad['subject'] | undefined> = {};
    const translateOldQuadToNew = (quad: Quad): Quad => {
      const newSubj = toNewReifier[termString(quad.subject)];
      if (newSubj) {
        return DF.quad(newSubj, quad.predicate, quad.object, quad.graph);
      }
      return quad;
    };

    // Add others reifiers - they are already on the server (synced) so we give them precedence.
    await eventToPromise(newStore.import(otherStore.match(null, this.DF.namedNode(CRDT.TAGGING), null, graph)));
    // Populate toOrigReifier for those reification subjects in `this` that tag the same triple (triple term equality)
    // And add those that were not present in `other`.
    const newTags = wrap(origStore.match(null, this.DF.namedNode(CRDT.TAGGING), null, graph))
      .transform<Quad>({
        transform: (quad, done, push) => {
          const tripleTerm = quad.object;
          const currentTagger = quad.subject;
          const knownTaggerRes = newStore.match(null, null, tripleTerm, graph);
          wrap(knownTaggerRes).toArray().then((knownTaggerQuad) => {
            const knownTagger = knownTaggerQuad.at(0)?.subject;
            // Is there a known tag? If yes, remember in case the name is different
            if (knownTagger) {
              if (!knownTagger.equals(currentTagger)) {
                toOrigReifier[termString(knownTagger)] = currentTagger;
                toNewReifier[termString(currentTagger)] = knownTagger;
              }
            } else {
              // Not yet present, push...
              push(quad);
            }
            done();
          }).catch((err) => {
            throw err;
          });
        },
      });
    await eventToPromise(newStore.import(newTags));

    // NewStore knows all thing being Tagged. Now add `remove tags`
    let removeTaggers = wrap(newStore.match(null, DF.namedNode(CRDT.TAGGING), null, graph)).transform<Quad>({
      transform: (quad, done, push) => {
        const tagger = quad.subject;
        const metaDataTriples =
          wrap(origStore.match(toOrigReifier[termString(tagger)] ?? tagger, DF.namedNode(CRDT.DELETE), null, graph))
            .map(translateOldQuadToNew)
            .append(wrap(otherStore.match(tagger, DF.namedNode(CRDT.DELETE), null, graph)));

        metaDataTriples.on('data', (data: Quad) => push(data));
        metaDataTriples.on('end', () => done());
        metaDataTriples.on('error', (error) => {
          throw error;
        });
      },
    });
    if (this.expirationDuration > 0) {
      const now = this.now();
      const defaultTimeZone: ITimeZoneRepresentation = extractTimeZone(now);
      const currentTimeAsLiteral = toDateTimeRepresentation({ date: now, timeZone: defaultTimeZone });
      // Remove old tombstones
      removeTaggers = removeTaggers.filter((quad) => {
        const tag = quad.object;
        if (tag.termType !== 'Literal' || tag.datatype.value !== CRDT.DT_STAMP_UUID) {
          return true;
        }
        // Value is concat of a uuid and a XSD:dateTime (https://www.w3.org/TR/xmlschema-2/#dateTime)
        const [ _, timeStamp ] = tag.value.split('--');
        const timeStampLiteral = parseDateTime(timeStamp);
        const expiresAfter = addDurationToDateTime(
          timeStampLiteral,
          defaultedDurationRepresentation({ seconds: this.expirationDuration }),
        );
        // Valid only if expiresAfter is after now
        return toUTCDate(expiresAfter, defaultTimeZone).getTime() >
          toUTCDate(currentTimeAsLiteral, defaultTimeZone).getTime();
      });
    }
    await new Promise(resolve => newStore.import(removeTaggers).on('end', resolve));

    // Now add those add tags that are not removed.
    const addTaggers = wrap(newStore.match(null, DF.namedNode(CRDT.TAGGING), null, graph)).transform<Quad>({
      transform: (quad, done, push) => {
        // For each tagger, get the adding quads in other and this
        const tagger = quad.subject;
        const addTagQuads =
          wrap(origStore.match(toOrigReifier[termString(tagger)] ?? tagger, DF.namedNode(CRDT.ADD), null, graph))
            .map(translateOldQuadToNew)
            .append(wrap(otherStore.match(tagger, DF.namedNode(CRDT.ADD), null, graph)));

        (async() => {
          // For each add tag, check whether there is a delete
          for await (const addTagQuad of addTagQuads) {
            const tag = addTagQuad.object.value;
            const deletesOnTagerWithSameTag =
              wrap(newStore.match(addTagQuad.subject, DF.namedNode(CRDT.DELETE), null, graph))
                .filter(removeQuad => removeQuad.object.value.includes(tag));
            if ((await deletesOnTagerWithSameTag.toArray()).length === 0) {
              push(addTagQuad);
            }
          }
          done();
        })().catch((err) => {
          throw err;
        });
      },
    });
    await new Promise(resolve => newStore.import(addTaggers).on('end', resolve));

    const activeTriple = wrap(newStore.match(null, DF.namedNode(CRDT.ADD), null, graph))
      .map(quad => quad.subject).uniq(tagger => termString(tagger))
      .transform<Quad>({
        transform: (tagger, done, push) => {
          const taggedRes = wrap(newStore.match(tagger, DF.namedNode(CRDT.TAGGING), null, graph));
          taggedRes.toArray().then((list) => {
            const quadToAdd = list.at(0)?.object;
            if (!quadToAdd || quadToAdd.termType !== 'Quad') {
              throw new Error(`Did not find tripleTerm of tagger ${termString(tagger)}`);
            }
            push(quadToAdd);
            done();
          }).catch((err) => {
            throw err;
          });
        },
      });
    await new Promise(resolve => newStore.import(activeTriple).on('end', resolve));
  }

  /**
   * Merge two add-wins set CRDTs.
   * Calls the merge function for each unique graph present.
   */
  public crdtMerge(otherStore: Store): EventEmitter {
    if (otherStore instanceof CrdtStore) {
      otherStore = otherStore.store;
    }
    return this.sequentializeEvent(() => {
      const newStore = <Store>RdfStore.createDefault();

      return wrap(this.store.match()).append(wrap(otherStore.match()))
        .map(quad => quad.graph).uniq(graph => graph.value)
        .transform({ transform: (graph, done) => {
          this.crdtMergeGraph(newStore, otherStore, graph).then(done).catch((error) => {
            throw error;
          });
        } })
        .on('end', () => this.store = newStore);
    });
  }

  public cleanTaggers(): EventEmitter {
    const DF = this.DF;
    const store = this.store;
    const toRemove = wrap(store.match(null, DF.namedNode(CRDT.TAGGING)))
      .transform<Quad>({ transform: (quad, done, push) => {
        (async() => {
          const addTags = await wrap(store.match(quad.subject, DF.namedNode(CRDT.ADD)))
            .append(wrap(store.match(quad.subject, DF.namedNode(CRDT.DELETE)))).toArray();
          if (addTags.length === 0) {
            push(quad);
          }
          done();
        })().catch(() => {
          // Errors during async iteration are surfaced through the readable stream's error event.
        });
      } });
    return this.remove(toRemove);
  }
}
