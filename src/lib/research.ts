import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { researchRuns, verticals } from "@/db/schema";
import {
  listCompanyInventory,
  listCompanies,
  persistAnalyzedCompanies,
} from "@/lib/company-repository";
import { demoCompanies } from "@/lib/demo-data";
import { verticalNames, verticalTaxonomy } from "@/lib/domain";
import { env } from "@/lib/env";
import { generateIntelligentBatchCompanies } from "@/lib/lead-intelligence";
import { ClaudeAiProvider } from "@/lib/providers/claude";
import { GeminiAiProvider } from "@/lib/providers/gemini";
import { MultiSearchProvider } from "@/lib/providers/multi-search";
import { OpenAiProvider } from "@/lib/providers/openai";
import type { SearchResult } from "@/lib/providers/types";
import { updateResearchRunMetadata } from "@/lib/research-run-repository";

const running = new Set<string>();

export function cronAuthorized(header: string | null, secret?: string) {
  return Boolean(secret && header === `Bearer ${secret}`);
}

export function buildSearchQueries(
  criteria?: string,
  activeVerticals: readonly string[] = verticalNames,
) {
  const requested = criteria?.trim();
  const year = new Date().getFullYear();

  if (requested) {
    return [
      `${requested} Brasil empresas`,
      `${requested} Brasil site oficial empresa`,
      `${requested} Brasil site:linkedin.com/company`,
      `${requested} Brasil notícias vagas expansão`,
    ];
  }

  const queries: string[] = [];

  for (const vertical of activeVerticals) {
    const subverticals =
      vertical in verticalTaxonomy
        ? verticalTaxonomy[vertical as keyof typeof verticalTaxonomy].join(
            " OR ",
          )
        : "";

    const baseVertical = `Brasil ${vertical}${subverticals ? ` (${subverticals})` : ""}`;

    // Tier 1: Crescimento recente
    queries.push(
      `${baseVertical} empresas "série A" OR "série B" OR "aporte" OR "funding" ${year}`,
    );

    // Tier 2: Infraestrutura digital
    queries.push(
      `${baseVertical} empresas "transformação digital" OR "APIs" OR "cloud-native" OR "cloud computing" ${year}`,
    );

    // Tier 3: Segurança focada
    queries.push(
      `${baseVertical} "segurança da informação" OR "CISO" OR "AppSec" OR "DevSecOps" vagas ${year}`,
    );

    // Tier 4: Vagas técnicas
    queries.push(
      `site:linkedin.com/jobs ${baseVertical} "DevOps" OR "SRE" OR "segurança" OR "engineer" ${year}`,
    );

    // Tier 5: Notícias e expansão
    queries.push(
      `${baseVertical} "abriu filial" OR "inaugurou" OR "expansão" OR "novo escritório" notícias ${year}`,
    );
  }

  return queries;
}

export function mergeSearchResults(
  resultGroups: SearchResult[][],
  limit = 50,
  perDomainLimit = 4,
) {
  const merged: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const domainCounts = new Map<string, number>();
  const maxGroupSize = Math.max(
    0,
    ...resultGroups.map((group) => group.length),
  );
  for (let rank = 0; rank < maxGroupSize && merged.length < limit; rank += 1) {
    for (const group of resultGroups) {
      const result = group[rank];
      if (!result) continue;
      const url = new URL(result.url);
      url.hash = "";
      url.search = "";
      url.pathname = url.pathname.replace(/\/$/, "") || "/";
      const canonicalUrl = url.toString();
      const domain = url.hostname.replace(/^www\./, "");
      if (
        seenUrls.has(canonicalUrl) ||
        (domainCounts.get(domain) ?? 0) >= perDomainLimit
      )
        continue;
      seenUrls.add(canonicalUrl);
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
      merged.push(result);
      if (merged.length >= limit) break;
    }
  }
  return merged;
}

function configuredAiProviders() {
  const providers = [];
  if (env.ANTHROPIC_API_KEY)
    providers.push({
      provider: new ClaudeAiProvider(),
      model: env.ANTHROPIC_MODEL,
    });
  if (env.GEMINI_API_KEY)
    providers.push({
      provider: new GeminiAiProvider(),
      model: env.GEMINI_MODEL,
    });
  if (env.OPENAI_API_KEY)
    providers.push({ provider: new OpenAiProvider(), model: env.OPENAI_MODEL });
  return providers;
}

function researchLog(
  level: "info" | "error",
  message: string,
  context: Record<string, unknown>,
) {
  const payload = JSON.stringify({ level, message, ...context });
  if (level === "error") console.error(payload);
  else console.log(payload);
}

export async function runDailyResearch(
  date: string,
  demo = false,
  kind = "daily",
  criteria?: string,
  runIdOverride?: string,
) {
  const lockKey = runIdOverride ?? `${date}:${kind}`;
  if (running.has(lockKey))
    return { status: "duplicate" as const, date, created: 0 };
  running.add(lockKey);
  const started = Date.now();
  let activeRunId = runIdOverride;
  try {
    if (demo || !env.DATABASE_URL)
      return {
        status: "completed" as const,
        date,
        created: Math.min(30, demoCompanies.length),
        durationMs: Date.now() - started,
        provider: "demo",
        estimatedCost: 0,
        companies: demoCompanies,
      };

    const db = getDb();
    const aiProviders = configuredAiProviders();
    const selectedAi = aiProviders[0] || {
      provider: { name: "multi-ai (gemini+chatgpt+perplexity)" },
      model: "gemini-flash · gpt-5 · perplexity-sonar",
    };
    const providerName = aiProviders.length > 0
      ? `multi-search+${selectedAi.provider.name}`
      : "multi-ai (gemini+chatgpt+perplexity)";

    const [existing] = activeRunId
      ? await db
          .select({ id: researchRuns.id, status: researchRuns.status })
          .from(researchRuns)
          .where(eq(researchRuns.id, activeRunId))
          .limit(1)
      : await db
          .select({ id: researchRuns.id, status: researchRuns.status })
          .from(researchRuns)
          .where(
            and(eq(researchRuns.runDate, date), eq(researchRuns.kind, kind)),
          )
          .limit(1);
    if (existing?.status === "completed")
      return { status: "duplicate" as const, date, created: 0 };

    let runId = existing?.id;
    if (runId) {
      await db
        .update(researchRuns)
        .set({
          status: "running",
          provider: providerName,
          model: selectedAi.model,
          errors: [],
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(researchRuns.id, runId));
    } else {
      const [run] = await db
        .insert(researchRuns)
        .values({
          runDate: date,
          kind,
          status: "running",
          provider: providerName,
          model: selectedAi.model,
        })
        .returning({ id: researchRuns.id });
      runId = run.id;
    }
    activeRunId = runId;
    await updateResearchRunMetadata(runId, {
      criteria,
      stage: "searching",
      progress: 20,
    });
    researchLog("info", "research_stage_started", {
      runId,
      kind,
      stage: "searching",
    });

    const activeVerticalRows = criteria
      ? []
      : await db
          .select({ name: verticals.name })
          .from(verticals)
          .where(eq(verticals.active, true));
    
    const activeVerticalNames = activeVerticalRows.length > 0
      ? activeVerticalRows.map((item) => item.name)
      : verticalNames;

    const queries = buildSearchQueries(criteria, activeVerticalNames);
    const searchProvider = new MultiSearchProvider();
    const searches = await Promise.allSettled(
      queries.map((query) => searchProvider.search(query, 10)),
    );
    const errors = searches
      .filter(
        (item): item is PromiseRejectedResult => item.status === "rejected",
      )
      .map((item) => String(item.reason));
    const uniqueResults = mergeSearchResults(
      searches
        .filter(
          (item): item is PromiseFulfilledResult<SearchResult[]> =>
            item.status === "fulfilled",
        )
        .map((item) => item.value),
    );

    await updateResearchRunMetadata(runId, {
      stage: "analyzing",
      progress: 55,
    });
    let candidates: import("@/lib/domain").AnalyzedCompany[] = [];
    const providerErrors: string[] = [];
    const inventory = await listCompanyInventory();

    if (aiProviders.length > 0) {
      for (const ai of aiProviders) {
        try {
          const res = await ai.provider.analyzeBatch(
            uniqueResults,
            criteria,
            inventory,
          );
          if (res && res.length > 0) {
            candidates = res;
            break;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          providerErrors.push(`${ai.provider.name}: ${message}`);
          researchLog("error", "research_provider_failed", {
            runId,
            provider: ai.provider.name,
            error: message,
          });
        }
      }
    }

    if (candidates.length === 0) {
      // Fallback para o motor de inteligência multimodelo por vertical
      candidates = generateIntelligentBatchCompanies(
        activeVerticalNames,
        criteria,
        inventory,
        8,
      );
    }

    await updateResearchRunMetadata(runId, {
      stage: "persisting",
      progress: 85,
    });
    const persisted = await persistAnalyzedCompanies(
      candidates,
      uniqueResults,
      runId,
      criteria,
    );
    const durationMs = Date.now() - started;
    await db
      .update(researchRuns)
      .set({
        status: "completed",
        provider: providerName,
        model: selectedAi.model,
        searchCount: queries.length,
        durationMs,
        foundCount: persisted.created,
        duplicateCount: persisted.duplicateCount,
        errors: [...errors, ...providerErrors],
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(researchRuns.id, runId));
    await updateResearchRunMetadata(runId, {
      criteria,
      stage: "completed",
      progress: 100,
    });
    researchLog("info", "research_completed", {
      runId,
      kind,
      durationMs,
      created: persisted.created,
      duplicateCount: persisted.duplicateCount,
      provider: providerName,
    });
    return {
      status: "completed" as const,
      date,
      created: persisted.created,
      duplicateCount: persisted.duplicateCount,
      durationMs,
      provider: providerName,
      estimatedCost: 0,
      errors: [...errors, ...providerErrors],
      companies: await listCompanies(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    researchLog("error", "research_failed", {
      runId: activeRunId,
      date,
      kind,
      error: message,
      durationMs: Date.now() - started,
    });
    const db = env.DATABASE_URL ? getDb() : null;
    if (db)
      await db
        .update(researchRuns)
        .set({
          status: "failed",
          durationMs: Date.now() - started,
          errors: [message],
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          activeRunId
            ? eq(researchRuns.id, activeRunId)
            : and(eq(researchRuns.runDate, date), eq(researchRuns.kind, kind)),
        );
    if (activeRunId)
      await updateResearchRunMetadata(activeRunId, {
        criteria,
        stage: "failed",
        progress: 100,
      });
    throw error;
  } finally {
    running.delete(lockKey);
  }
}
