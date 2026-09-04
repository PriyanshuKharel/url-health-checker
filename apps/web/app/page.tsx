import type { BatchListResponse } from "@uhc/shared";
import { api } from "@/lib/api";
import { BatchList } from "@/components/BatchList";
import { NewBatchForm } from "@/components/NewBatchForm";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let initial: BatchListResponse | null = null;
  try {
    initial = await api.listBatches();
  } catch {
    initial = null;
  }

  return (
    <>
      <NewBatchForm />
      <BatchList initial={initial} />
    </>
  );
}
