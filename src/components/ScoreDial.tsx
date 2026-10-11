import type { Tier } from "@/lib/types";
import styles from "./ScoreDial.module.css";

const COLOR: Record<Tier, string> = { LOW: "var(--low)", MEDIUM: "var(--medium)", HIGH: "var(--high)" };

/** 0–100 score as a 270° arc with tier colour. Pure SVG, no deps. */
export function ScoreDial({ score, tier, size = 160 }: { score: number; tier: Tier; size?: number }) {
  const s = Math.max(0, Math.min(100, score));
  const r = 44;
  const c = 2 * Math.PI * r;
  const sweep = 0.75; // 270°
  const track = c * sweep;
  const fill = track * (s / 100);
  const bandAt = (n: number) => track * (n / 100);

  return (
    <div className={styles.wrap} style={{ width: size, height: size }} role="img" aria-label={`Risk score ${s} of 100, tier ${tier}`}>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <g transform="rotate(135 50 50)">
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--line-2)" strokeWidth="9" strokeDasharray={`${track} ${c}`} strokeLinecap="butt" />
          {/* tier bands, faint */}
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--low)" strokeOpacity="0.22" strokeWidth="9" strokeDasharray={`${bandAt(20)} ${c}`} />
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--medium)" strokeOpacity="0.22" strokeWidth="9" strokeDasharray={`${bandAt(40)} ${c}`} strokeDashoffset={-bandAt(20)} />
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--high)" strokeOpacity="0.22" strokeWidth="9" strokeDasharray={`${bandAt(40)} ${c}`} strokeDashoffset={-bandAt(60)} />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={COLOR[tier]}
            strokeWidth="9"
            strokeLinecap="butt"
            strokeDasharray={`${fill} ${c}`}
            className={styles.fill}
          />
        </g>
        <text x="50" y="52" textAnchor="middle" className={styles.score} fill="var(--fg)">
          {s}
        </text>
        <text x="50" y="66" textAnchor="middle" className={styles.sub} fill="var(--fg-muted)">
          / 100
        </text>
      </svg>
    </div>
  );
}
