import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { BatchView } from "@/components/BatchView";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

async function loadBatch(id: string) {
  try {
    return await api.getBatch(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Batch ${id.slice(0, 8)} · Bulk URL Health Checker` };
}

export default async function BatchPage({ params }: { params: Params }) {
  const { id } = await params;
  const detail = await loadBatch(id);
  return <BatchView initial={detail} />;
}
