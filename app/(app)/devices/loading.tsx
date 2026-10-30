import { Skeleton } from "@/components/ui/skeleton";

// Mirrors the devices page layout while its data loads.
export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6" aria-busy aria-label="Loading devices">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col border">
        <Skeleton className="h-9 w-full rounded-none" />
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="flex items-center gap-6 border-t px-2 py-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="ml-auto h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
