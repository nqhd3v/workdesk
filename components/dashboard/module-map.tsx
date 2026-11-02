"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, MapPinIcon } from "@phosphor-icons/react";
import { setModuleLocation } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Map, MapControls, MapMarker, MarkerContent } from "@/components/ui/map";
import { cn } from "cn";

export type MapModule = {
  id: string;
  label: string;
  online: boolean;
  /** Current values in one line. */
  summary: string;
  href: string;
  selected: boolean;
  latitude: number | null;
  longitude: number | null;
};

type Spot = [longitude: number, latitude: number];

// Where the map opens before any module is placed: Ho Chi Minh City.
const DEFAULT_CENTER: Spot = [106.7, 10.78];

function middle(spots: Spot[]): Spot {
  if (!spots.length) return DEFAULT_CENTER;
  return [spots.reduce((sum, s) => sum + s[0], 0) / spots.length, spots.reduce((sum, s) => sum + s[1], 0) / spots.length];
}

/** Every module at its location, with its current values. Clicking one puts it in focus. */
export function ModuleMap({ modules, className }: { modules: MapModule[]; className?: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  // Holds a dragged pin in place until the saved location comes back from the server.
  const [moved, setMoved] = useState<Record<string, Spot>>({});

  const spotOf = (m: MapModule): Spot | null => moved[m.id] ?? (m.longitude !== null && m.latitude !== null ? [m.longitude, m.latitude] : null);
  const spots = modules.map(spotOf).filter((s) => s !== null);
  const [center] = useState(() => middle(spots));
  const unplaced = modules.length - spots.length;

  async function save(id: string, spot: Spot) {
    setMoved((m) => ({ ...m, [id]: spot }));
    setError((await setModuleLocation({ id, longitude: spot[0], latitude: spot[1] }))?.error);
  }

  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle>Map</CardTitle>
        <CardDescription>
          {error ?? (editing ? "Drag a module to where it sits" : unplaced ? `${unplaced} of ${modules.length} not placed yet` : `${modules.length} placed`)}
        </CardDescription>
        {modules.length > 0 && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setEditing((e) => !e)}>
              {editing ? <CheckIcon data-icon="inline-start" /> : <MapPinIcon data-icon="inline-start" />}
              {editing ? "Done" : "Edit locations"}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <div className="h-80 w-full">
          <Map center={center} zoom={spots.length ? 14 : 11}>
            <MapControls />
            {modules.map((m) => {
              const spot = spotOf(m) ?? (editing ? center : null);
              if (!spot) return null;
              return (
                <MapMarker
                  key={`${m.id}:${editing}`}
                  longitude={spot[0]}
                  latitude={spot[1]}
                  draggable={editing}
                  onClick={() => !editing && router.push(m.href, { scroll: false })}
                  onDragEnd={({ lng, lat }) => save(m.id, [lng, lat])}
                >
                  <MarkerContent>
                    <div className={cn("flex flex-col gap-0.5 border bg-card px-2 py-1 text-xs whitespace-nowrap shadow-sm", m.selected && "border-primary")}>
                      <span className="flex items-center gap-1.5 font-medium">
                        <span className={cn("size-2 rounded-full", m.online ? "bg-status-good" : "bg-muted-foreground")} aria-hidden />
                        {m.label}
                      </span>
                      <span className="text-muted-foreground tabular-nums">{m.summary}</span>
                    </div>
                  </MarkerContent>
                </MapMarker>
              );
            })}
          </Map>
        </div>
      </CardContent>
    </Card>
  );
}
