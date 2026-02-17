import { useState } from 'react';
import { getDomain, getFaviconUrl } from '../utils/favicon';

function SearchResults({ rounds = [], onResultClick }) {
  const [expanded, setExpanded] = useState(false);

  if (!rounds.length) return null;

  const totalCount = rounds.reduce((sum, round) => sum + (round.results?.length || 0), 0);

  return (
    <div className="search-results">
      <button
        type="button"
        className="search-results-toggle"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="search-icon">&#128269;</span>
        <span>Web Results ({totalCount})</span>
        <span className={`arrow ${expanded ? 'arrow-up' : ''}`}>&#9660;</span>
      </button>

      {expanded && (
        <div className="search-results-body">
          {rounds.map((round, roundIndex) => {
            const label = round.round === 2 ? 'Follow-up Search' : 'Primary Search';
            return (
              <section key={`${round.round}-${roundIndex}`} className="search-round">
                <header className="search-round-header">
                  <span className="search-round-badge">{label}</span>
                  <span className="search-round-query">{round.query}</span>
                </header>

                {round.answer && <p className="search-answer">{round.answer}</p>}

                <ul className="search-list">
                  {(round.results || []).map((result, idx) => {
                    const entry = {
                      ...result,
                      query: round.query,
                      round: round.round,
                      favicon: getFaviconUrl(result.url),
                    };
                    return (
                      <li key={`${round.round}-${roundIndex}-${idx}`} className="search-item">
                        <button
                          type="button"
                          className="search-item-btn"
                          onClick={() => onResultClick?.(entry)}
                        >
                          <span className="search-item-title-row">
                            {entry.favicon && (
                              <img
                                src={entry.favicon}
                                alt=""
                                className="search-item-favicon"
                                onError={(e) => {
                                  e.target.style.display = 'none';
                                }}
                              />
                            )}
                            <span className="search-item-title">{result.title || result.url}</span>
                          </span>
                          <span className="search-item-domain">{getDomain(result.url)}</span>
                          <span className="search-item-snippet">{(result.content || '').slice(0, 180)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default SearchResults;
