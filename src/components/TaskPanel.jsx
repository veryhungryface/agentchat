import { useEffect, useMemo, useState } from 'react';
import { getDomain, getFaviconUrl } from '../utils/favicon';

function formatElapsed(ms) {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remain = Math.round(sec % 60);
  return `${min}m ${remain}s`;
}

function TaskPanel({ pipeline, isActive, onSourceClick, onSourcesOpen }) {
  const [collapsedAfterComplete, setCollapsedAfterComplete] = useState(false);
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
  const showCollapsedSummary = pipeline.isComplete && !isActive && collapsedAfterComplete;

  return (
    <div className={`task-panel task-panel-thinking ${pipeline.isComplete ? 'task-panel-complete' : ''}`}>
      {showCollapsedSummary ? (
        <button type="button" className="task-panel-summary" onClick={() => setCollapsedAfterComplete(false)}>
          <span className="task-panel-summary-left">Thinking</span>
          <span className="task-panel-summary-right">{summaryText}</span>
        </button>
      ) : (
        <>
          <div className="task-panel-header">
            <div className="task-panel-header-left">
              <span className="task-panel-title">
                Thinking
                {!pipeline.isComplete && (
                  <span className="task-panel-title-dots" aria-hidden="true">
                    {' '}
                    {thinkingDots}
                  </span>
                )}
              </span>
            </div>

            <div className="task-panel-header-right">
              <span className="task-panel-time">{formatElapsed(elapsedMs)}</span>
              {pipeline.isComplete && !isActive && (
                <button
                  type="button"
                  className="task-panel-collapse-btn"
                  onClick={() => setCollapsedAfterComplete(true)}
                >
                  요약 보기
                </button>
              )}
            </div>
          </div>

          <div className="thinking-activity-list">
            {activities.length === 0 ? (
              <p className="thinking-activity-line">질문을 분석하고 있습니다.</p>
            ) : (
              activities.map((item) => {
                if (item.type === 'sources') {
                  return (
                    <div key={item.id} className="thinking-source-block">
                      <div className="task-note-row">
                        <span className="thinking-source-title">
                          {item.label} · 출처 {item.sources.length}개
                        </span>
                        <button
                          type="button"
                          className="task-source-open-btn"
                          onClick={() =>
                            onSourcesOpen?.({
                              id: item.groupId,
                              label: item.label,
                              note: `출처 ${item.sources.length}개`,
                              sources: item.sources,
                            })
                          }
                        >
                          클릭해서 출처 보기
                        </button>
                      </div>

                      <div className="favicon-strip">
                        {item.sources.map((source, sourceIndex) => (
                          <button
                            key={source.url}
                            type="button"
                            className="favicon-item favicon-animate"
                            style={{ animationDelay: `${sourceIndex * 60}ms` }}
                            title={getDomain(source.url)}
                            onClick={() =>
                              onSourceClick?.(
                                {
                                  id: item.groupId,
                                  label: item.label,
                                  note: `출처 ${item.sources.length}개`,
                                  sources: item.sources,
                                },
                                source,
                              )
                            }
                          >
                            <img
                              src={source.favicon || getFaviconUrl(source.url)}
                              alt=""
                              className="favicon-img"
                              onError={(e) => {
                                e.target.style.display = 'none';
                              }}
                            />
                            <span className="favicon-domain">{getDomain(source.url)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                }

                return (
                  <p key={item.id} className="thinking-activity-line">
                    {item.text}
                  </p>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default TaskPanel;
