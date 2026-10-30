// Pieces shared by the login illustration and the dashboard's system map.
// Motion comes from the .sys-* classes in globals.css and is off for prefers-reduced-motion.

type Connect = { "--connect": string } & React.CSSProperties;

export function connectStyle(seconds: number): Connect {
  return { "--connect": `${seconds}s` };
}

export function GridBackdrop({ width, height }: { width: number; height: number }) {
  return (
    <>
      <defs>
        <pattern id="sys-grid" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" className="fill-foreground/10" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="url(#sys-grid)" />
    </>
  );
}

/**
 * A link and, unless `packets` is off, the traffic on it. Paths should run a few px under the cards
 * at both ends so packets slide out from behind them. Draw this before the cards.
 */
export function Traffic({ id, d, dur, connect, packets = true }: { id: string; d: string; dur: number; connect: number; packets?: boolean }) {
  return (
    <g>
      <path id={id} d={d} className="sys-online sys-dash fill-none stroke-foreground/35" strokeWidth="1.25" style={connectStyle(connect)} />
      {packets && (
        /* Hidden until connected, so packets don't idle at (0,0). */
        <g visibility="hidden" className="motion-reduce:hidden">
          <set attributeName="visibility" to="visible" begin={`${connect}s`} fill="freeze" />
          <circle r="3" className="fill-emerald-500">
            <animateMotion dur={`${dur}s`} begin={`${connect}s`} repeatCount="indefinite">
              <mpath href={`#${id}`} />
            </animateMotion>
          </circle>
          <rect x="-2.5" y="-2.5" width="5" height="5" className="fill-none stroke-sky-500" strokeWidth="1.5">
            <animateMotion
              dur={`${dur}s`}
              begin={`${connect}s`}
              repeatCount="indefinite"
              keyPoints="1;0"
              keyTimes="0;1"
              calcMode="linear"
            >
              <mpath href={`#${id}`} />
            </animateMotion>
          </rect>
        </g>
      )}
    </g>
  );
}

export function Database({ x, y }: { x: number; y: number }) {
  const w = 72;
  const rx = w / 2;
  const ry = 9;
  return (
    <g transform={`translate(${x} ${y})`}>
      <path
        d={`M 0 ${ry} V 70 A ${rx} ${ry} 0 0 0 ${w} 70 V ${ry}`}
        className="fill-card stroke-foreground/40"
        strokeWidth="1.25"
      />
      <ellipse cx={rx} cy={ry} rx={rx} ry={ry} className="fill-card stroke-foreground/40" strokeWidth="1.25" />
      {[24, 40].map((cy, k) => (
        <path
          key={cy}
          d={`M 0 ${cy} A ${rx} ${ry} 0 0 0 ${w} ${cy}`}
          className="sys-blink fill-none stroke-foreground/30"
          strokeWidth="1.25"
          style={{ animationDelay: `${k * 0.4}s` }}
        />
      ))}
    </g>
  );
}

export function Droplet({ x, y }: { x: number; y: number }) {
  return (
    <path
      transform={`translate(${x} ${y})`}
      d="M 3.5 0 C 3.5 0 0 4 0 6 A 3.5 3.5 0 0 0 7 6 C 7 4 3.5 0 3.5 0 Z"
      className="fill-sky-500/70"
    />
  );
}

function barColor(pct: number) {
  if (pct >= 90) return "fill-red-500";
  if (pct >= 70) return "fill-amber-500";
  return "fill-emerald-500";
}

/** Track + fill. Grows in when its group comes online, then eases between values. */
export function ProgressBar({ x, y, width, height, pct }: { x: number; y: number; width: number; height: number; pct: number | null }) {
  const value = Math.min(100, Math.max(0, pct ?? 0));
  const r = height / 2;
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={width} height={height} rx={r} className="fill-foreground/10" />
      <g className="sys-grow">
        <rect
          width={width}
          height={height}
          rx={r}
          className={`transition-[transform,fill] duration-700 ease-out ${barColor(value)}`}
          style={{ transform: `scaleX(${value / 100})`, transformBox: "fill-box", transformOrigin: "left" }}
        />
      </g>
    </g>
  );
}
