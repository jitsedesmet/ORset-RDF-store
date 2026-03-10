import type { BlankNode, Term } from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';

class UuidBlank implements BlankNode {
  public value: string;
  public termType = <const> 'BlankNode';
  public constructor() {
    this.value = crypto.randomUUID();
  }

  public equals(other: Term | null | undefined): boolean {
    return other?.termType === 'BlankNode' && other.value === this.value;
  }
}

export class DataFactoryUuid extends DataFactory {
  private readonly blankMap: Record<string, UuidBlank> = {};
  public override blankNode(label?: string): BlankNode {
    const existing = this.blankMap[label ?? ''];
    if (label !== undefined && existing) {
      return existing;
    }
    const newBnode = new UuidBlank();
    if (label !== undefined) {
      this.blankMap[label] = newBnode;
    }
    return newBnode;
  }
}
