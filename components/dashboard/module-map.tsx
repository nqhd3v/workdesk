"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, MapPinIcon } from "@phosphor-icons/react";
import { setModuleLocation } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Map, MapControls, MapMarker, MarkerContent, MarkerLabel, MarkerPopup, MarkerTooltip, useMap } from "@/components/ui/map";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "cn";

export type MapModule = {
  id: string;
  label: string;
  online: boolean;
  /** Current sensor values. */
  readings: { label: string; value: string }[];
  href: string;
  latitude: number | null;
  longitude: number | null;
};

/** A fixed point the map always keeps in view. */
export type MapPlace = {
  label: string;
  latitude: number;
  longitude: number;
};

type Spot = [longitude: number, latitude: number];
type Bounds = [west: number, south: number, east: number, north: number];

// Where the map opens before anything is placed: Ho Chi Minh City.
const DEFAULT_CENTER: Spot = [106.7, 10.78];
const FIT = { padding: 40, maxZoom: 15 };
// A module this close to a place counts as being there.
const SAME_SPOT_METERS = 200;
const METERS_PER_DEGREE = 111_320;
const CARD = "flex max-w-none flex-col gap-0.5 rounded-none border bg-popover px-2 py-1 text-xs font-normal whitespace-nowrap text-popover-foreground";
// Handlers off rather than `interactive: false`, which would also stop markers from dragging.
const FIXED_VIEW = {
  boxZoom: false,
  doubleClickZoom: false,
  dragPan: false,
  dragRotate: false,
  keyboard: false,
  scrollZoom: false,
  touchPitch: false,
  touchZoomRotate: false,
};
// Keyboard stays off: its handler would also catch arrow keys typed in the location card.
const EDIT_HANDLERS = ["boxZoom", "doubleClickZoom", "dragPan", "scrollZoom", "touchZoomRotate"] as const;
const CUSTOM = "custom";

function middle(spots: Spot[]): Spot {
  if (!spots.length) return DEFAULT_CENTER;
  return [spots.reduce((sum, s) => sum + s[0], 0) / spots.length, spots.reduce((sum, s) => sum + s[1], 0) / spots.length];
}

function boundsOf(spots: Spot[]): Bounds | null {
  if (!spots.length) return null;
  const longitudes = spots.map((s) => s[0]);
  const latitudes = spots.map((s) => s[1]);
  return [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)];
}

function metersBetween(a: Spot, b: Spot) {
  const dx = (a[0] - b[0]) * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dx, a[1] - b[1]) * METERS_PER_DEGREE;
}

function parseCoordinate(text: string, limit: number) {
  const value = Number(text.replace(",", "."));
  return text.trim() && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

const formatCoordinate = (value: number) => String(Number(value.toFixed(6))).replace(".", ",");

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

function ModuleDetails({ module: m, title }: { module: MapModule; title: string }) {
  return (
    <>
      <span className="flex items-center gap-1.5 font-medium">
        <span className={cn("size-2 rounded-full", m.online ? "bg-status-good" : "bg-status-critical")} aria-hidden />
        {title}
      </span>
      {m.readings.map((r) => (
        <Row key={r.label} {...r} />
      ))}
      {!m.readings.length && <span className="text-muted-foreground">{m.online ? "No sensors" : "Offline"}</span>}
    </>
  );
}

/** Keeps the bounds framed when they change or the map is resized. */
function FitView({ bounds: [west, south, east, north] }: { bounds: Bounds }) {
  const { map } = useMap();

  useEffect(() => {
    if (!map) return;
    const fit = () => map.fitBounds([west, south, east, north], { ...FIT, animate: false });
    fit();
    map.on("resize", fit);
    return () => {
      map.off("resize", fit);
    };
  }, [map, west, south, east, north]);

  return null;
}

/** Lets the map move for as long as it's mounted. */
function MovableView() {
  const { map } = useMap();

  useEffect(() => {
    if (!map) return;
    for (const handler of EDIT_HANDLERS) map[handler].enable();
    return () => {
      for (const handler of EDIT_HANDLERS) map[handler].disable();
    };
  }, [map]);

  return null;
}

/** A decimal-comma number. Holds what's being typed, so a half-typed value isn't reformatted away. */
function CoordinateInput({
  label,
  value,
  limit,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  limit: number;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  const id = useId();
  const [typing, setTyping] = useState<string | null>(null);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        className="tabular-nums"
        value={typing ?? formatCoordinate(value)}
        aria-invalid={typing !== null && parseCoordinate(typing, limit) === null}
        onChange={(e) => {
          const text = e.target.value.replace(".", ",").replace(/[^\d,-]/g, "");
          setTyping(text);
          const parsed = parseCoordinate(text, limit);
          if (parsed !== null) onChange(parsed);
        }}
        onBlur={() => {
          if (typing === null) return;
          setTyping(null);
          onCommit();
        }}
      />
    </div>
  );
}

/** Sets one module's location: from a known place, typed coordinates, or dragging its pin. */
function LocationCard({
  title,
  spot,
  places,
  dirty,
  saving,
  moduleOptions,
  moduleId,
  onModuleChange,
  onChange,
  onSave,
}: {
  title: string;
  spot: Spot;
  places: MapPlace[];
  dirty: boolean;
  saving: boolean;
  moduleOptions: { value: string; label: string }[];
  moduleId: string;
  onModuleChange: (id: string) => void;
  onChange: (spot: Spot) => void;
  onSave: () => void;
}) {
  const { map } = useMap();
  // Lets "Custom" stay picked while the coordinates still match a place.
  const [custom, setCustom] = useState(false);

  const options = [...places.map((p) => ({ value: p.label, label: p.label })), { value: CUSTOM, label: "Custom" }];
  const match = places.find((p) => metersBetween(spot, [p.longitude, p.latitude]) <= SAME_SPOT_METERS);
  const go = (to: Spot) => map?.easeTo({ center: to });

  return (
    <div className="absolute top-2 right-2 z-10 flex w-64 max-w-[calc(100%-1rem)] flex-col gap-2 border bg-popover p-3 text-xs text-popover-foreground shadow-md">
      <p className="truncate font-medium">{title}</p>
      {moduleOptions.length > 1 && (
        <Select items={moduleOptions} value={moduleId} onValueChange={(id) => id && onModuleChange(id)}>
          <SelectTrigger size="sm" aria-label="Module" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {moduleOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {places.length > 0 && (
        <Select
          items={options}
          value={!custom && match ? match.label : CUSTOM}
          onValueChange={(value) => {
            const place = places.find((p) => p.label === value);
            setCustom(!place);
            if (!place) return;
            const to: Spot = [place.longitude, place.latitude];
            onChange(to);
            go(to);
          }}
        >
          <SelectTrigger size="sm" aria-label="Location" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex gap-2">
        <CoordinateInput label="Latitude" value={spot[1]} limit={90} onChange={(latitude) => onChange([spot[0], latitude])} onCommit={() => go(spot)} />
        <CoordinateInput label="Longitude" value={spot[0]} limit={180} onChange={(longitude) => onChange([longitude, spot[1]])} onCommit={() => go(spot)} />
      </div>
      <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

/** Every module as a dot at its location, framed by the view. Hovering one shows its values, clicking pins them and puts it in focus. */
export function ModuleMap({ modules, places, className }: { modules: MapModule[]; places: MapPlace[]; className?: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [activeId, setActiveId] = useState<string>();
  // Unsaved locations. Dropped on save, once the new one comes back from the server, or on Done.
  const [moved, setMoved] = useState<Record<string, Spot>>({});

  const spotOf = (m: MapModule): Spot | null => moved[m.id] ?? (m.longitude !== null && m.latitude !== null ? [m.longitude, m.latitude] : null);
  const placed = modules.map(spotOf).filter((s) => s !== null);
  // Modules only; places are the fallback so an empty map still opens somewhere useful.
  const framed = placed.length ? placed : places.map((p): Spot => [p.longitude, p.latitude]);
  const bounds = boundsOf(framed);
  const [center] = useState(() => middle(framed));
  const unplaced = modules.length - placed.length;

  const placeAt = (spot: Spot) => places.find((p) => metersBetween(spot, [p.longitude, p.latitude]) <= SAME_SPOT_METERS);
  const titleAt = (m: MapModule, spot: Spot) => {
    const place = placeAt(spot);
    return place ? `${m.label} (${place.label})` : m.label;
  };
  // A place with a module on it speaks through that module's card.
  const taken = new Set(editing ? [] : placed.map((s) => placeAt(s)?.label));

  const active = modules.find((m) => m.id === activeId) ?? modules[0];
  const activeSpot = active && (spotOf(active) ?? center);

  async function save(id: string, spot: Spot) {
    setSaving(true);
    const failure = (await setModuleLocation({ id, longitude: spot[0], latitude: spot[1] }))?.error;
    setSaving(false);
    setError(failure);
    if (failure) return;
    setMoved((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== id)));
  }

  function toggleEditing() {
    setEditing(!editing);
    setMoved({});
    setError(undefined);
  }

  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle>Map</CardTitle>
        <CardDescription>
          {error ?? (editing ? "Drag a module, pick a place or type coordinates" : unplaced ? `${unplaced} of ${modules.length} not placed yet` : `${modules.length} placed`)}
        </CardDescription>
        {modules.length > 0 && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={toggleEditing}>
              {editing ? <CheckIcon data-icon="inline-start" /> : <MapPinIcon data-icon="inline-start" />}
              {editing ? "Done" : "Edit locations"}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <div className="h-80 w-full">
          <Map
            center={center}
            zoom={11}
            bounds={bounds ?? undefined}
            fitBoundsOptions={FIT}
            className={cn(!editing && "[&_.maplibregl-canvas-container]:cursor-default!")}
            {...FIXED_VIEW}
          >
            {bounds && !editing && <FitView bounds={bounds} />}
            {editing && <MovableView />}
            {editing && <MapControls position="top-left" />}
            {editing && active && (
              <LocationCard
                key={active.id}
                title={titleAt(active, activeSpot)}
                spot={activeSpot}
                places={places}
                dirty={!!moved[active.id] || active.latitude === null}
                saving={saving}
                moduleOptions={modules.map((m) => ({ value: m.id, label: m.label }))}
                moduleId={active.id}
                onModuleChange={setActiveId}
                onChange={(spot) => setMoved((all) => ({ ...all, [active.id]: spot }))}
                onSave={() => save(active.id, activeSpot)}
              />
            )}
            {places
              .filter((p) => !taken.has(p.label))
              .map((p) => (
                <MapMarker key={p.label} longitude={p.longitude} latitude={p.latitude}>
                  <MarkerContent className="flex size-5 cursor-default items-center justify-center">
                    <span className="size-1.5 rounded-full bg-foreground/50" aria-hidden />
                  </MarkerContent>
                  <MarkerTooltip offset={10}>{p.label}</MarkerTooltip>
                </MapMarker>
              ))}
            {modules.map((m) => {
              const spot = spotOf(m) ?? (editing ? center : null);
              if (!spot) return null;
              return (
                <MapMarker
                  key={`${m.id}:${editing}`}
                  longitude={spot[0]}
                  latitude={spot[1]}
                  draggable={editing}
                  onClick={() => (editing ? setActiveId(m.id) : router.push(m.href, { scroll: false }))}
                  onDragStart={() => setActiveId(m.id)}
                  onDrag={({ lng, lat }) => setMoved((all) => ({ ...all, [m.id]: [lng, lat] }))}
                >
                  {/* The box is the click target; an 8px dot alone is too small to hit. */}
                  <MarkerContent className="flex size-5 items-center justify-center">
                    <span className={cn("size-2 rounded-full", m.online ? "sys-blink bg-status-good" : "bg-status-critical")} aria-hidden />
                    {editing && <MarkerLabel position="bottom">{m.label}</MarkerLabel>}
                  </MarkerContent>
                  {!editing && (
                    <>
                      <MarkerTooltip offset={10} className={CARD}>
                        <ModuleDetails module={m} title={titleAt(m, spot)} />
                      </MarkerTooltip>
                      <MarkerPopup offset={10} className={CARD}>
                        <ModuleDetails module={m} title={titleAt(m, spot)} />
                      </MarkerPopup>
                    </>
                  )}
                </MapMarker>
              );
            })}
          </Map>
        </div>
      </CardContent>
    </Card>
  );
}
