import { useEffect, useMemo, useState } from 'react';
import { getDomain, getFaviconUrl } from '../utils/favicon';

function formatElapsed(ms) {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remain = Math.round(sec % 60);
  return `${min}m ${remain}s`;
}

function createSourcePayload(item) {
  return {
    id: item.groupId,
    label: item.label,
    note: `출처 ${item.sources.length}개`,
    sources: item.sources,
  };
}

function TaskPanel({ pipeline, isActive, onSourceClick, onSourcesOpen }) {
  const [expandedAfterComplete, setExpandedAfterComplete] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!pipeline) return undefined;

    const updateElapsed = () => {
      const end = pipeline.isComplete ? pipeline.endTime || Date.now() : Date.now();
      setElapsedMs(Math.max(0, end - pipeline.startTime));
    };

    updateElapsed();
    if (pipeline.isComplete) return undefined;

    const timer = setInterval(updateElapsed, 250);
    return () => clearInterval(timer);
  }, [pipeline]);

  const activities = useMemo(() => pipeline.activity || [], [pipeline.activity]);
  const summaryText = formatElapsed(elapsedMs);
  const thinkingDots = '.'.repeat(((Math.floor(elapsedMs / 450) % 3) + 1)).padEnd(3, ' ');
  const showCollapsedSummary = pipeline.isComplete && !isActive && !expandedAfterComplete;

  return (
    <div className={`task-panel task-panel-thinking ${pipeline.isComplete ? 'task-panel-complete' : ''}`}>
      <div className="task-panel-header">
        <button
          type="button"
          className="task-panel-toggle-btn"
          onClick={() => {
            if (!pipeline.isComplete || isActive) return;
            setExpandedAfterComplete((prev) => !prev);
          }}
          aria-expanded={!showCollapsedSummary}
        >
          <span className="task-panel-title">
            Thinking 과정
            {!pipeline.isComplete && (
              <span className="task-panel-title-dots" aria-hidden="true">
                {' '}
                {thinkingDots}
              </span>
            )}
          </span>
          <span className="task-panel-chevron" aria-hidden="true">
            {showCollapsedSummary ? '>' : 'v'}
          </span>
        </button>
        {!showCollapsedSummary && <span className="task-panel-time">{summaryText}</span>}
      </div>

      {!showCollapsedSummary && (
        <div className="thinking-activity-list">
          {activities.length === 0 ? (
            <p className="thinking-activity-line">
              {isActive && <span className="activity-spin" aria-hidden="true" />}
              <span>질문을 분석하고 있습니다.</span>
            </p>
          ) : (
            activities.map((item) => {
              if (item.type === 'sources') {
                return (
                  <div key={item.id} className="thinking-source-block">
                    <div className="task-note-row">
                      <span className="thinking-source-title">
                        <span>{item.label} · 출처 {item.sources.length}개</span>
                      </span>
                      <button
                        type="button"
                        className="task-source-open-btn"
                        onClick={() => onSourcesOpen?.(createSourcePayload(item))}
                      >
                        출처 보기
                      </button>
                    </div>

                    {item.queries?.length > 0 && (
                      <div className="thinking-query-list">
                        {item.queries.map((query) => (
                          <span key={`${item.id}-${query}`} className="thinking-query-chip">
                            "{query}"
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="favicon-strip">
                      {item.sources.map((source, sourceIndex) => (
                        <button
                          key={source.url}
                          type="button"
                          className="favicon-item favicon-animate"
                          style={{ animationDelay: `${sourceIndex * 60}ms` }}
                          title={getDomain(source.url)}
                          onClick={() => onSourceClick?.(createSourcePayload(item), source)}
                        >
                          <img
                            src={source.favicon || getFaviconUrl(source.url)}
                            alt=""
                            className="favicon-img"
                            onError={(event) => {
                              event.target.style.display = 'none';
                            }}
                          />
                          <span className="favicon-domain">{getDomain(source.url)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }

              const showSpin = item.type === 'progress' && Boolean(item.spinning) && isActive;

              return (
                <p key={item.id} className="thinking-activity-line">
                  {showSpin && <span className="activity-spin" aria-hidden="true" />}
                  <span>{item.text}</span>
                </p>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export default TaskPanel;
