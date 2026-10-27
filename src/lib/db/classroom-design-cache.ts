import type { Prisma } from "@prisma/client";
import { prisma } from "./client";
import { decodePblTemplate, type PblTemplateDesign } from "@/lib/platform/pbl-template";

const MAX_ENTRIES = 64;
const MAX_BYTES = 32 * 1024 * 1024;
type Entry = { design: PblTemplateDesign; bytes: number };

/** Published snapshots are immutable. Drafts and transaction reads never join
 * this cache. Return independent objects because Course reducers may mutate
 * nested design fields. No permissions or student data are retained here.
 */
export function createClassroomDesignCache(maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES) {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<PblTemplateDesign | null>>();
  let bytes = 0;
  return {
    async read(id: string, query: () => Promise<unknown>): Promise<PblTemplateDesign | null> {
      const cached = entries.get(id);
      if (cached) {
        entries.delete(id); entries.set(id, cached);
        return structuredClone(cached.design);
      }
      let job = pending.get(id);
      if (!job) {
        if (pending.size >= maxEntries) return decodePblTemplate(await query());
        job = (async () => {
          const design = decodePblTemplate(await query());
          if (!design) return null;
          const size = Buffer.byteLength(JSON.stringify(design));
          if (size <= maxBytes) {
            const previous = entries.get(id);
            if (previous) { bytes -= previous.bytes; entries.delete(id); }
            while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes)) {
              const oldest = entries.keys().next().value!;
              bytes -= entries.get(oldest)!.bytes; entries.delete(oldest);
            }
            entries.set(id, { design, bytes: size }); bytes += size;
          }
          return design;
        })();
        // A hung database read must not retain every future caller forever.
        const expiry = setTimeout(() => { if (pending.get(id) === job) pending.delete(id); }, 2_000);
        expiry.unref?.();
        pending.set(id, job);
        const settled = () => { clearTimeout(expiry); if (pending.get(id) === job) pending.delete(id); };
        void job.then(settled, settled);
      }
      const design = await job;
      return design ? structuredClone(design) : null;
    },
    snapshot: () => ({ entries: entries.size, pending: pending.size, bytes }),
  };
}

declare global { var __openPblClassroomDesignCache: ReturnType<typeof createClassroomDesignCache> | undefined; }
const cache = globalThis.__openPblClassroomDesignCache ??= createClassroomDesignCache();
export const classroomDesignCacheSnapshot = cache.snapshot;

export async function readClassroomDesign(db: Prisma.TransactionClient,
  version: { id: string; status: string; snapshot?: unknown }): Promise<PblTemplateDesign | null> {
  if ("snapshot" in version) return decodePblTemplate(version.snapshot);
  const query = async () => (await db.classroomTemplateVersion.findUnique({ where: { id: version.id }, select: { snapshot: true } }))?.snapshot;
  if (db !== prisma || version.status.toUpperCase() === "DRAFT") return decodePblTemplate(await query());
  return cache.read(version.id, query);
}
