import "server-only";

import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  companies,
  dailyLeadQueue,
  opportunityScores,
  sdrIntelligence,
} from "@/db/schema";
import { dateInSaoPaulo } from "@/lib/domain";

export type DailyQueueItem = {
  id: string;
  companyId: string;
  companyName: string;
  verticalId?: string;
  rank: number;
  status: string;
  opportunityScore: number;
  confidenceScore: number;
  recommendedSolution: string;
  whyNow?: string;
};

export async function buildDailyLeadQueue(
  date = dateInSaoPaulo(),
  limit = 30,
  cooldownDays = 90,
) {
  const db = getDb();
  const now = new Date();
  const candidates = await db
    .select({
      companyId: companies.id,
      opportunityScore: opportunityScores.opportunityScore,
      confidenceScore: opportunityScores.confidenceScore,
      recommendedSolution: companies.suggestedSolution,
      whyNow: sdrIntelligence.whyNow,
    })
    .from(companies)
    .innerJoin(opportunityScores, eq(opportunityScores.companyId, companies.id))
    .leftJoin(sdrIntelligence, eq(sdrIntelligence.companyId, companies.id))
    .where(
      and(
        isNull(companies.deletedAt),
        eq(companies.qualificationStatus, "READY"),
        or(isNull(companies.cooldownUntil), lte(companies.cooldownUntil, now)),
      ),
    )
    .orderBy(
      desc(opportunityScores.opportunityScore),
      desc(opportunityScores.confidenceScore),
    )
    .limit(limit);

  let rank = 1;
  for (const candidate of candidates) {
    if (!candidate.recommendedSolution) continue;
    const [inserted] = await db
      .insert(dailyLeadQueue)
      .values({
        queueDate: date,
        companyId: candidate.companyId,
        rank,
        status: "READY",
        opportunityScore: candidate.opportunityScore,
        confidenceScore: candidate.confidenceScore,
        recommendedSolution: candidate.recommendedSolution,
        whyNow: candidate.whyNow,
      })
      .onConflictDoNothing({
        target: [dailyLeadQueue.queueDate, dailyLeadQueue.companyId],
      })
      .returning({ id: dailyLeadQueue.id });
    if (!inserted) continue;
    const cooldownUntil = new Date(now.getTime() + cooldownDays * 86_400_000);
    await db
      .update(companies)
      .set({
        lastSuggestedAt: now,
        cooldownUntil,
        timesSuggested: sql`${companies.timesSuggested} + 1`,
        updatedAt: now,
      })
      .where(eq(companies.id, candidate.companyId));
    rank += 1;
  }
  return rank - 1;
}

export async function listDailyLeadQueue(
  date = dateInSaoPaulo(),
): Promise<DailyQueueItem[]> {
  const rows = await getDb()
    .select({
      id: dailyLeadQueue.id,
      companyId: dailyLeadQueue.companyId,
      companyName: companies.name,
      verticalId: companies.verticalId,
      rank: dailyLeadQueue.rank,
      status: dailyLeadQueue.status,
      opportunityScore: dailyLeadQueue.opportunityScore,
      confidenceScore: dailyLeadQueue.confidenceScore,
      recommendedSolution: dailyLeadQueue.recommendedSolution,
      whyNow: dailyLeadQueue.whyNow,
    })
    .from(dailyLeadQueue)
    .innerJoin(companies, eq(companies.id, dailyLeadQueue.companyId))
    .where(eq(dailyLeadQueue.queueDate, date))
    .orderBy(dailyLeadQueue.rank);
  return rows.map((row) => ({
    ...row,
    verticalId: row.verticalId ?? undefined,
    whyNow: row.whyNow ?? undefined,
  }));
}
