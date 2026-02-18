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
  const thinkingDots = '.'.repeat(Math.floor(elapsedMs / 450) % 4).padEnd(3, ' ');
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
                {thinkingDots}
              </span>
            )}
          </span>
          <span className="task-panel-chevron" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="6" fill="none" className="task-panel-chevron-icon">
              {showCollapsedSummary ? (
                <path fillRule="evenodd" clipRule="evenodd" d="M11.7933 0.190809C11.5176 -0.0636029 11.0706 -0.0636029 10.795 0.190809L6 4.61612L1.20502 0.190809C0.929352 -0.0636031 0.482411 -0.0636031 0.206747 0.190809C-0.0689172 0.445221 -0.0689172 0.857704 0.206747 1.11212L5.15147 5.67562C5.6201 6.10812 6.3799 6.10813 6.84853 5.67562L11.7933 1.11212C12.0689 0.857704 12.0689 0.445221 11.7933 0.190809ZM6.14974 4.75432C6.14967 4.75426 6.14961 4.7542 6.14954 4.75414L6.14974 4.75432ZM5.85046 4.75414C5.85039 4.7542 5.85033 4.75426 5.85026 4.75432L5.85046 4.75414Z" fill="#9F9F9F" />
              ) : (
                <path fillRule="evenodd" clipRule="evenodd" d="M11.7933 5.80919C11.5176 6.0636 11.0706 6.0636 10.795 5.80919L6 1.38388L1.20502 5.80919C0.929352 6.0636 0.482411 6.0636 0.206747 5.80919C-0.0689172 5.55478 -0.0689172 5.1423 0.206747 4.88788L5.15147 0.324375C5.6201 -0.108125 6.3799 -0.108125 6.84853 0.324375L11.7933 4.88788C12.0689 5.1423 12.0689 5.55478 11.7933 5.80919ZM6.14974 1.24568C6.14967 1.24574 6.14961 1.2458 6.14954 1.24586L6.14974 1.24568ZM5.85046 1.24586C5.85039 1.2458 5.85033 1.24574 5.85026 1.24568L5.85046 1.24586Z" fill="#9F9F9F" />
              )}
            </svg>
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
