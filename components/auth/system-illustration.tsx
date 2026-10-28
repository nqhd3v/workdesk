// Decorative, abstract system diagram for the auth card's right panel:
// two device cards exchange data with a dashboard screen, database behind it.
// Green dots = data up to the screen, blue squares = config back to devices.
// Intro: each device boots "connecting" (red blinking LED, wifi pulse, no border);
// once its --connect delay passes it goes green and its link/traffic appear.
// Pure SVG + SMIL/CSS (no client JS); motion is off for prefers-reduced-motion.

type Connect = { "--connect": string } & React.CSSProperties;

const DEVICES = [
  { id: "link-a", x: 20, y: 36, d: "M 70 92 V 182 H 104", dur: 2.6, connect: 1.6 },
  { id: "link-b", x: 240, y: 268, d: "M 290 268 V 214 H 256", dur: 3.1, connect: 2.4 },
];

// Dashboard charts come alive once the first device is online.
const FIRST_ONLINE = Math.min(...DEVICES.map((d) => d.connect));

function connectStyle(seconds: number): Connect {
  return { "--connect": `${seconds}s` };
}

export function SystemIllustration() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 360 360"
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 size-full text-foreground"
    >
      <defs>
        <pattern id="sys-grid" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" className="fill-foreground/10" />
        </pattern>
      </defs>
      <rect width="360" height="360" fill="url(#sys-grid)" />

      {/* Connectors + traffic */}
      {DEVICES.map(({ id, d, dur, connect }, i) => (
        <g key={id} className="sys-online" style={connectStyle(connect)}>
          <path id={id} d={d} className="sys-dash fill-none stroke-foreground/35" strokeWidth="1.25" />
          {/* Negative begin: packets start mid-flight instead of idling at (0,0). */}
          <g className="motion-reduce:hidden">
            <circle r="3" className="fill-emerald-500">
              <animateMotion dur={`${dur}s`} begin={`-${i * 0.8}s`} repeatCount="indefinite">
                <mpath href={`#${id}`} />
              </animateMotion>
            </circle>
            <rect x="-2.5" y="-2.5" width="5" height="5" className="fill-none stroke-sky-500" strokeWidth="1.5">
              <animateMotion
                dur={`${dur}s`}
                begin={`-${i * 0.8 + dur / 2}s`}
                repeatCount="indefinite"
                keyPoints="1;0"
                keyTimes="0;1"
                calcMode="linear"
              >
                <mpath href={`#${id}`} />
              </animateMotion>
            </rect>
          </g>
        </g>
      ))}

      <Database x={196} y={92} />
      <Screen x={104} y={132} />
      {DEVICES.map(({ id, x, y, connect }) => (
        <DeviceCard key={id} x={x} y={y} connect={connect} />
      ))}
    </svg>
  );
}

function DeviceCard({ x, y, connect }: { x: number; y: number; connect: number }) {
  return (
    <g transform={`translate(${x} ${y})`} style={connectStyle(connect)}>
      <rect width="100" height="56" rx="6" className="sys-border fill-card stroke-foreground/40" strokeWidth="1.25" />
      {/* chip */}
      <rect x="10" y="12" width="18" height="18" rx="3" className="fill-none stroke-foreground/50" strokeWidth="1.25" />
      <rect x="15" y="17" width="8" height="8" rx="1" className="fill-foreground/25" />
      {/* label lines */}
      <rect x="36" y="14" width="28" height="4" rx="2" className="fill-foreground/30" />
      <rect x="36" y="24" width="20" height="4" rx="2" className="fill-foreground/15" />
      {/* wifi: pulses while connecting, settles once online */}
      <g className="sys-wifi fill-none stroke-foreground/60" strokeWidth="1.25" strokeLinecap="round">
        <circle cx="76" cy="20" r="0.9" className="fill-foreground/60 stroke-none" />
        <path d="M 73.5 17.5 A 3.5 3.5 0 0 1 78.5 17.5" />
        <path d="M 71.2 15.2 A 6.8 6.8 0 0 1 80.8 15.2" />
      </g>
      {/* status led: red + blinking while connecting, then green */}
      <circle cx="88" cy="16" r="3" className="sys-led fill-emerald-500" />
      {/* live sparkline */}
      <g className="sys-online">
        <polyline
          points="10,46 22,40 32,43 44,36 56,41 68,34 80,38 90,33"
          className="sys-draw fill-none stroke-emerald-500/70"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      </g>
    </g>
  );
}

function Database({ x, y }: { x: number; y: number }) {
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

const BARS = [18, 30, 22, 36, 26, 32];

function Screen({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {/* stand */}
      <path d="M 66 100 L 62 116 H 90 L 86 100" className="fill-card stroke-foreground/40" strokeWidth="1.25" />
      <line x1="52" y1="116" x2="100" y2="116" className="stroke-foreground/40" strokeWidth="1.25" />
      {/* bezel */}
      <rect width="152" height="100" rx="6" className="fill-card stroke-foreground/50" strokeWidth="1.5" />
      <rect x="8" y="8" width="136" height="84" rx="3" className="fill-muted" />

      {/* dashboard: header */}
      <circle cx="16" cy="16" r="2.5" className="fill-foreground/30" />
      <rect x="23" y="14" width="30" height="4" rx="2" className="fill-foreground/25" />
      {/* stat tiles */}
      {[0, 1, 2].map((k) => (
        <g key={k} transform={`translate(${14 + k * 42} 26)`}>
          <rect width="38" height="18" rx="2" className="fill-card" />
          <rect x="5" y="5" width="16" height="3" rx="1.5" className="fill-foreground/20" />
          <rect x="5" y="11" width={10 + k * 5} height="3" rx="1.5" className="fill-foreground/40" />
        </g>
      ))}
      {/* bar chart */}
      <g transform="translate(14 50)">
        <rect width="62" height="36" rx="2" className="fill-card" />
        <g className="sys-online" style={connectStyle(FIRST_ONLINE)}>
        {BARS.map((h, k) => (
          <rect
            key={k}
            x={6 + k * 9}
            y={32 - h * 0.8}
            width="5"
            height={h * 0.8}
            className="sys-bar fill-sky-500/70"
            style={{ animationDelay: `${k * 0.2}s` }}
          />
        ))}
        </g>
      </g>
      {/* line chart */}
      <g transform="translate(80 50)">
        <rect width="58" height="36" rx="2" className="fill-card" />
        <g className="sys-online" style={connectStyle(FIRST_ONLINE)}>
          <polyline
            points="5,28 13,22 21,25 29,14 37,18 45,9 53,12"
            className="sys-draw fill-none stroke-emerald-500"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </g>
      </g>
    </g>
  );
}
