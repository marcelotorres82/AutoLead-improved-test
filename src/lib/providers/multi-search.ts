import "server-only";

import { env } from "@/lib/env";
import { PerplexitySearchProvider } from "@/lib/providers/perplexity";
import { PublicWebSearchProvider } from "@/lib/providers/public-search";
import { TavilySearchProvider } from "@/lib/providers/tavily";
import type { SearchResult, WebSearchProvider } from "@/lib/providers/types";

export class MultiSearchProvider implements WebSearchProvider {
  readonly name = "multi-search";
  private providers: WebSearchProvider[] = [];

  constructor() {
    // Provedores prioritários
    if (env.TAVILY_API_KEY) {
      this.providers.push(new TavilySearchProvider());
    }
    this.providers.push(new PerplexitySearchProvider());
    this.providers.push(new PublicWebSearchProvider());
  }

  async search(query: string, limit = 15): Promise<SearchResult[]> {
    const searches = await Promise.allSettled(
      this.providers.map((p) => p.search(query, limit)),
    );

    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    for (const result of searches) {
      if (result.status === "fulfilled") {
        for (const item of result.value) {
          if (!seenUrls.has(item.url)) {
            seenUrls.add(item.url);
            results.push(item);
            if (results.length >= limit) return results;
          }
        }
      }
    }

    if (results.length === 0) {
      // Fallback garantido
      const fallback = new PublicWebSearchProvider();
      return fallback.search(query, limit);
    }

    return results;
  }
}
