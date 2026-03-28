"use client";

type ActivityStatusProps = {
  title: string;
  detail: string;
  stage: string;
  percent: number;
  kind: "research" | "write";
  elapsedSeconds?: number;
  stats?: string[];
};

export function ActivityStatus({
  title,
  detail,
  stage,
  percent,
  kind,
  elapsedSeconds,
  stats = [],
}: ActivityStatusProps) {
  const clampedPercent = Math.max(0, Math.min(100, Math.round(percent)));

  return (
    <section className={`activity-panel activity-panel--${kind}`}>
      <div className="activity-panel__head">
        <div>
          <div className="activity-panel__eyebrow">Live operator status</div>
          <h3 className="activity-panel__title">{title}</h3>
        </div>
        <div className="activity-panel__percent">{clampedPercent}%</div>
      </div>

      <div className="activity-panel__bar" aria-hidden="true">
        <div className="activity-panel__bar-fill" style={{ width: `${clampedPercent}%` }} />
      </div>

      <div className="activity-panel__meta">
        <span className="activity-panel__stage">{stage}</span>
        {typeof elapsedSeconds === "number" && <span>{elapsedSeconds}s elapsed</span>}
      </div>

      <p className="activity-panel__detail">{detail}</p>

      {stats.length > 0 && (
        <div className="activity-panel__stats">
          {stats.map((stat) => (
            <span key={stat} className="activity-panel__stat-pill">
              {stat}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}