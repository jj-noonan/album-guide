import { useEffect, useRef, useState } from 'react';
import './DistanceDial.css';

/**
 * Five stops, named as terrain.
 *
 * How far the next record sits from this one is much easier to feel as ground
 * than as a number: a sidewalk keeps you on pavement you already know,
 * bushwhacking means no path at all.
 */
export const STOPS: { name: string; blurb: string }[] = [
  { name: 'Sidewalk',    blurb: 'close variations on where you are' },
  { name: 'Footpath',    blurb: 'a gentle turn off the main road' },
  { name: 'Ridgeline',   blurb: 'real ground covered, still a path' },
  { name: 'Backcountry', blurb: 'far out, and it shows' },
  { name: 'Bushwhack',   blurb: 'no path at all' },
];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const toIndex = (v: number) => Math.round(clamp01(v) * (STOPS.length - 1));
const toValue = (i: number) => i / (STOPS.length - 1);

/** Half-moon geometry: 180° on the left through 0° on the right. */
const point = (r: number, i: number) => {
  const rad = (Math.PI * (1 - i / (STOPS.length - 1)));
  return [50 + Math.cos(rad) * r, 50 - Math.sin(rad) * r] as const;
};

interface Props {
  value: number;
  onChange: (v: number) => void;
}

export function DistanceDial({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const index = toIndex(value);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      // The flow's arrow keys shouldn't fire while the picker has focus.
      e.stopPropagation();
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  const [nx, ny] = point(29, index);

  return (
    <div className="dial" ref={box}>
      <button
        className="dial__face"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Terrain: ${STOPS[index].name}. Tap to change.`}
        title={`${STOPS[index].name} — ${STOPS[index].blurb}`}
      >
        <svg viewBox="0 0 100 62" aria-hidden="true">
          {/* Half-moon bezel and cream face */}
          <path className="gauge__bezel" d="M2 50 A48 48 0 0 1 98 50 Z" />
          <path className="gauge__face" d="M7 50 A43 43 0 0 1 93 50 Z" />
          {STOPS.map((_, i) => {
            const [x1, y1] = point(31, i);
            const [x2, y2] = point(40, i);
            const [tx, ty] = point(23, i);
            const on = i <= index;
            return (
              <g key={i} opacity={on ? 1 : 0.34}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ag-ink)" strokeWidth={2.6} strokeLinecap="round" />
                <text x={tx} y={ty + 3.2} textAnchor="middle" className="gauge__num">{i + 1}</text>
              </g>
            );
          })}
          <line className="gauge__needle" x1="50" y1="50" x2={nx} y2={ny} strokeLinecap="round" />
          <circle className="gauge__hub" cx="50" cy="50" r="5.5" />
        </svg>
        <span className="dial__name">{STOPS[index].name}</span>
      </button>

      {open && (
        <div className="dial__pop" role="listbox" aria-label="Terrain">
          <p className="dial__poptitle">How far each step travels</p>
          {STOPS.map((s, i) => (
            <button
              key={s.name}
              className={`dial__opt${i === index ? ' dial__opt--on' : ''}`}
              role="option"
              aria-selected={i === index}
              onClick={() => { onChange(toValue(i)); setOpen(false); }}
            >
              <span className="dial__optnum">{i + 1}</span>
              <span className="dial__opttext">
                <b>{s.name}</b>
                <i>{s.blurb}</i>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
