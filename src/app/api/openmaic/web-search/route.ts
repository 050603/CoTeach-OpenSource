/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response using the configured web search provider.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@openmaic/lib/ai/llm';
import { formatSearchResultsAsContext, searchWeb } from '@openmaic/lib/web-search';
import { isServerConfiguredProvider, resolveWebSearchApiKey } from '@openmaic/lib/server/provider-config';
import { createLogger } from '@openmaic/lib/logger';
import { apiError, apiSuccess } from '@openmaic/lib/server/api-response';
import {
  buildSearchQuery,
  SEARCH_QUERY_REWRITE_EXCERPT_LENGTH,
} from '@openmaic/lib/server/search-query-builder';
import { resolveModelFromRequest } from '@openmaic/lib/server/resolve-model';
import type { AICallFn } from '@openmaic/lib/generation/pipeline-types';
import { WEB_SEARCH_PROVIDERS } from '@openmaic/lib/web-search/constants';
import type { BaiduSubSources, WebSearchProviderId } from '@openmaic/lib/web-search/types';
import { resolveWebSearchRouteBaseUrl } from '@openmaic/lib/server/web-search-config';
import { isAbortError, throwIfAborted } from '@openmaic/lib/generation/generation-retry';

const log = createLogger('WebSearch');

export async function POST(req: NextRequest) {
  let query: string | undefined;
  try {
    throwIfAborted(req.signal);
    const body = await req.json();
    const {
      query: requestQuery,
      pdfText,
      providerId: requestProviderId,
      apiKey: bodyApiKey,
      baseUrl: bodyBaseUrl,
      baiduSubSources,
    } = body as {
      query?: string;
      pdfText?: string;
      providerId?: WebSearchProviderId;
      apiKey?: string;
      baseUrl?: string;
      baiduSubSources?: BaiduSubSources;
    };
    query = requestQuery;

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    const providerId: WebSearchProviderId =
      requestProviderId && WEB_SEARCH_PROVIDERS[requestProviderId] ? requestProviderId : 'tavily';
    const provider = WEB_SEARCH_PROVIDERS[providerId];
    // Managed providers are admin-owned: ignore (don't reject) any client-sent
    // key/baseUrl. The server config is authoritative, so a stale client base
    // URL is dropped rather than failing the request.
    const managed = isServerConfiguredProvider('webSearch', providerId);
    const clientApiKey = managed ? undefined : bodyApiKey;
    const clientBaseUrl = managed ? undefined : bodyBaseUrl;
    const apiKey = resolveWebSearchApiKey(providerId, clientApiKey);
    if (provider.requiresApiKey && !apiKey) {
      return apiError(
        'MISSING_API_KEY',
        400,
        `${provider.name} API key is not configured. Set it in Settings -> Web Search or configure ${getWebSearchEnvKey(providerId)} on the server.`,
      );
    }
    let baseUrl: string | undefined;
    try {
      baseUrl = resolveWebSearchRouteBaseUrl(providerId, clientBaseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid web search base URL';
      return apiError('INVALID_REQUEST', 400, message);
    }

    // Clamp rewrite input at the route boundary; framework body limits still apply to total request size.
    const boundedPdfText = pdfText?.slice(0, SEARCH_QUERY_REWRITE_EXCERPT_LENGTH);

    let aiCall: AICallFn | undefined;
    try {
      const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
        req,
        body,
        'web-search-query-rewrite',
      );
      aiCall = async (systemPrompt, userPrompt) => {
        const result = await callLLM(
          {
            model: languageModel,
            abortSignal: req.signal,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            maxOutputTokens: 256,
          },
          'web-search-query-rewrite',
          undefined,
          thinkingConfig,
        );
        return result.text;
      };
    } catch (error) {
      throwIfAborted(req.signal);
      log.warn('Search query rewrite model unavailable, falling back to raw requirement:', error);
    }

    throwIfAborted(req.signal);
    const searchQuery = await buildSearchQuery(query, boundedPdfText, aiCall);

    log.info('Running web search API request', {
      hasPdfContext: searchQuery.hasPdfContext,
      rawRequirementLength: searchQuery.rawRequirementLength,
      rewriteAttempted: searchQuery.rewriteAttempted,
      finalQueryLength: searchQuery.finalQueryLength,
    });

    const result = await searchWeb({
      providerId,
      query: searchQuery.query,
      apiKey,
      baseUrl,
      signal: req.signal,
      ...(providerId === 'baidu' && baiduSubSources ? { baiduSubSources } : {}),
    });
    throwIfAborted(req.signal);
    const context = formatSearchResultsAsContext(result);

    return apiSuccess({
      answer: result.answer,
      sources: result.sources,
      context,
      query: result.query,
      responseTime: result.responseTime,
    });
  } catch (err) {
    if (req.signal.aborted || isAbortError(err)) {
      return new Response(null, { status: 499 });
    }
    log.error(`Web search failed [query="${query?.substring(0, 60) ?? 'unknown'}"]:`, err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}

function getWebSearchEnvKey(providerId: WebSearchProviderId): string {
  switch (providerId) {
    case 'baidu':
      return 'BAIDU_API_KEY';
    case 'bocha':
      return 'BOCHA_API_KEY';
    case 'brave':
      return 'BRAVE_API_KEY';
    case 'minimax':
      return 'WEB_SEARCH_MINIMAX_API_KEY';
    case 'tavily':
    default:
      return 'TAVILY_API_KEY';
  }
}
