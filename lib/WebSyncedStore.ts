import { wrap } from 'asynciterator';
import { Parser, Writer } from 'n3';
import { RdfStore } from 'rdf-stores';
import type { CrdtStoreArgs } from './CrdtStore';
import { CrdtStore } from './CrdtStore';
import { eventToPromise, reverse } from './utils';

export interface WebSyncedStoreOptions extends CrdtStoreArgs {
  fetch?: typeof fetch;
  webSource: string;
  webSyncInterval?: number;
}

/**
 * A CrdtStore that self-manages external synchronization
 */
export class WebSyncedStore extends CrdtStore {
  protected fetch: typeof fetch;
  protected webSource: string;
  protected parser: Parser;
  protected remoteEtag = '';
  public webSyncInterval: number;
  public currentWebPromise: Promise<void> = Promise.resolve();

  public constructor(option: WebSyncedStoreOptions) {
    super(option);
    this.fetch = option.fetch ?? fetch;
    this.webSource = option.webSource;
    this.parser = new Parser({ factory: <any> this.DF, format: 'N-Quads' });
    this.webSyncInterval = option.webSyncInterval ?? 0;

    this.registerWebPromise();
  }

  public stop(): Promise<void> {
    this.webSyncInterval = 0;
    return this.currentWebPromise;
  }

  private registerWebPromise(): void {
    if (this.webSyncInterval > 0) {
      const running = this.currentWebPromise;
      this.currentWebPromise = (async() => {
        await running;
        await new Promise(resolve => setTimeout(resolve, this.webSyncInterval));
        // A smarter sync strategy might sync depending on the error
        try {
          await this.pullData();
          await this.pushData();
        } catch {
          // Transient sync errors are tolerated; the loop will retry on the next interval.
        }
        this.registerWebPromise();
      })().catch((err) => {
        throw err;
      });
    }
  }

  public async pullData(): Promise<void> {
    const remote = await this.fetch(this.webSource);
    const etag = remote.headers.get('etag');
    if (!etag) {
      throw new Error('No etag found for WebSynced store');
    }
    this.remoteEtag = etag;
    const remoteText = await remote.text();
    const triples = this.parser.parse(remoteText);

    const remoteStore = RdfStore.createDefault();
    await eventToPromise(remoteStore.import(wrap(triples)));

    await eventToPromise(this.crdtMerge(remoteStore));
  }

  public async pushData(): Promise<void> {
    if (!this.remoteEtag) {
      throw new Error('Store should not sync without first pulling');
    }

    const writer = new Writer({ factory: <any> this.DF, format: 'N-Quads' });
    for await (const quad of wrap(this.store.match())) {
      writer.addQuad(quad);
    }
    let text = await new Promise<string>((resolve, reject) => writer
      .end((error: any, result: any) => {
        if (error) {
          reject(error);
        }
        resolve(result);
      }));
    // TODO: this is only a temporary fix because N3 generator is wrong.
    text = text.replaceAll('<<', '<<(');
    // >>> -> >)>> : >>> -> >>> -> >>)> -> >)>>
    text = reverse(reverse(text).replaceAll('>>', '>>)'));

    const response = await this.fetch(this.webSource, {
      method: 'PUT',
      headers: {
        // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag#avoiding_mid-air_collisions
        'If-Match': this.remoteEtag,
      },
      body: text,
    });

    if (!response.ok) {
      throw new Error(`response not okay: ${await response.text()}`);
    }

    const newEtag = response.headers.get('etag');
    if (!newEtag) {
      throw new Error('Push did not provide new etag');
    }
    this.remoteEtag = newEtag;
  }
}
