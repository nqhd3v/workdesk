import { Skeleton } from "@/components/ui/skeleton";

// Default loading state for signed-in pages; the sidebar and header stay put.
export default function Loading() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6" aria-busy aria-label="Loading">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
