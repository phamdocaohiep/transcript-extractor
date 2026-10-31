import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchService } from './search-service';
import type { StaticEmbedder } from './static-embedder';

afterEach(() => vi.restoreAllMocks());

describe('index freshness', () => {
  it('rebuilds when content changes without changing record counts', async () => {
    const service = new SearchService();
    service.indexLexical([{ chunkIndex: 0, text: 'alpha' }], 'library:1:1');
    service.indexLexical([{ chunkIndex: 0, text: 'beta' }], 'library:1:1');
    expect(await service.search('alpha')).toEqual([]);
    expect(await service.search('beta')).toHaveLength(1);
  });
  it('does not let an earlier semantic job replace the latest index', async () => {
    const service = new SearchService();
    let release!: (embedder: StaticEmbedder) => void;
    const embedder = {
      embed: (text: string) => new Float32Array(text === 'alpha' ? [1, 0] : [0, 1]),
    } as unknown as StaticEmbedder;
    vi.spyOn(service as unknown as { getEmbedder: () => Promise<StaticEmbedder> }, 'getEmbedder')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = resolve;
          })
      )
      .mockResolvedValue(embedder);
    const old = service.indexSemantic([{ chunkIndex: 4, text: 'alpha' }], 'old');
    service.indexLexical([{ chunkIndex: 9, text: 'beta' }], 'new');
    await service.indexSemantic([{ chunkIndex: 9, text: 'beta' }], 'new');
    release(embedder);
    expect(await old).toBe(0);
    expect((await service.search('beta'))[0].chunkIndex).toBe(9);
  });
  it('clears dense results as soon as the content changes', async () => {
    const service = new SearchService();
    const embedder = { embed: () => new Float32Array([1, 0]) } as unknown as StaticEmbedder;
    vi.spyOn(
      service as unknown as { getEmbedder: () => Promise<StaticEmbedder> },
      'getEmbedder'
    ).mockResolvedValue(embedder);
    await service.indexSemantic([{ chunkIndex: 0, text: 'alpha' }], 'a');
    service.indexLexical([{ chunkIndex: 1, text: 'beta' }], 'b');
    expect(service.isSemanticReady).toBe(false);
    expect(await service.search('alpha')).toEqual([]);
  });
});
