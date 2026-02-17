import { useEffect, useMemo } from 'react';
import { getDomain, getFaviconUrl } from '../utils/favicon';

function normalizePreviewText(text, maxLen = 180) {
  const cleaned = String(text || '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/[#*_>|{}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

function SearchDetailPanel({ data, onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const sources = useMemo(() => {
    if (!data) return [];
    if (Array.isArray(data.sources)) return data.sources.filter((item) => item?.url);
    if (data.url) return [data];
    return [];
  }, [data]);

  if (!data) return null;

  return (
    <div className="search-detail-overlay" onClick={onClose}>
      <aside className="search-detail-panel search-detail-list-only" onClick={(event) => event.stopPropagation()}>
        <header className="search-detail-header">
          <div className="search-detail-title-wrap">
            <h3 className="search-detail-title">{data.stepLabel || '출처 정보'}</h3>
            <p className="search-detail-meta">
              {data.note || `출처 ${sources.length}개`}
              {' · '}
              항목을 누르면 새 탭에서 원문이 열립니다.
            </p>
          </div>
          <button type="button" className="search-detail-close" onClick={onClose} aria-label="패널 닫기">
            ×
          </button>
        </header>

        <div className="search-source-list">
          {sources.map((source) => {
            const domain = getDomain(source.url);
            const preview = normalizePreviewText(source.content);
            const favicon = source.favicon || getFaviconUrl(source.url);

            return (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="search-source-item"
              >
                <div className="search-source-title-row">
                  {favicon && (
                    <img
                      src={favicon}
                      alt=""
                      className="search-source-favicon"
                      onError={(event) => {
                        event.target.style.display = 'none';
                      }}
                    />
                  )}
                  <span className="search-source-title">{source.title || domain}</span>
                </div>
                <p className="search-source-preview">{preview || '미리보기 텍스트가 없습니다.'}</p>
              </a>
            );
          })}
          {sources.length === 0 && <div className="search-detail-content">출처 데이터가 없습니다.</div>}
        </div>
      </aside>
    </div>
  );
}

export default SearchDetailPanel;
