import { searchWithBaidu } from './baidu';
import { searchWithBocha } from './bocha';
import { searchWithBrave } from './brave';
import { searchWithMiniMax } from './minimax';
import { searchWithTavily } from './tavily';
import type { WebSearchResult } from '@openmaic/lib/types/web-search';
import type { BaiduSubSources, WebSearchProviderId } from './types';
import { throwIfAborted } from '@openmaic/lib/generation/generation-retry';

export { formatSearchResultsAsContext } from './format';

export async function searchWeb(params: {
  providerId: WebSearchProviderId;
  query: string;
  apiKey?: string;
  maxResults?: number;
  baseUrl?: string;
  baiduSubSources?: BaiduSubSources;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { providerId, query, apiKey = '', maxResults, baseUrl, baiduSubSources, signal } = params;
  throwIfAborted(signal);

  const result = await (async () => {
    switch (providerId) {
    case 'baidu':
        return searchWithBaidu({ query, apiKey, maxResults, baseUrl, subSources: baiduSubSources, signal });
    case 'bocha':
        return searchWithBocha({ query, apiKey, maxResults, baseUrl, signal });
    case 'brave':
        return searchWithBrave({ query, apiKey: apiKey || undefined, maxResults, baseUrl, signal });
    case 'minimax':
        return searchWithMiniMax({ query, apiKey, maxResults, baseUrl, signal });
    case 'tavily':
        return searchWithTavily({ query, apiKey, maxResults, baseUrl, signal });
    default: {
      const exhaustive: never = providerId;
      throw new Error(`Unsupported web search provider: ${exhaustive}`);
    }
    }
  })();
  throwIfAborted(signal);
  return result;
}
