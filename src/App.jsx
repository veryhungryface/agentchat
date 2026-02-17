import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import ChatMessage from './components/ChatMessage';
import TaskPanel from './components/TaskPanel';
import SearchDetailPanel from './components/SearchDetailPanel';
import { getFaviconUrl } from './utils/favicon';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const TYPING_SPEED = 4;
const CHARS_PER_TICK = 18;
const MIN_BUFFER_BEFORE_TYPING = 240;

const STATUS_STEP_DELAY_MS = {
  analyze_intent: 450,
  decide_search: 520,
  plan_queries: 460,
  searching: 420,
  analyzing: 420,
  searching_2: 420,
  search_skipped: 240,
  search_failed: 240,
  synthesize: 380,
  thinking: 220,
  streaming: 0,
};

const STATUS_TO_STEP_INDEX = {
  analyze_intent: 0,
  decide_search: 1,
  plan_queries: 2,
  searching: 3,
  analyzing: 4,
  searching_2: 5,
  search_skipped: 5,
  search_failed: 5,
  synthesize: 6,
  thinking: 7,
  streaming: 7,
};

const PIPELINE_TEMPLATE = [
  { id: 'analyze_intent', label: '요청 접수/분석', status: 'pending' },
  { id: 'decide_search', label: '검색 필요 여부 판단', status: 'pending' },
  { id: 'plan_queries', label: 'Todo 리스트 작성', status: 'pending' },
  { id: 'search_1', label: '1차 웹검색 실행', status: 'pending', sources: [] },
  { id: 'analyze_results', label: '검색 결과 검토', status: 'pending' },
  { id: 'search_2', label: '2차 웹검색 실행', status: 'pending', sources: [] },
  { id: 'synthesize', label: '답변 구조 설계', status: 'pending' },
  { id: 'generate', label: '답변 작성', status: 'pending' },
];

const SEARCH_STEP_IDS = new Set(['search_1', 'analyze_results', 'search_2']);

function createPipeline() {
  return {
    steps: PIPELINE_TEMPLATE.map((step) => ({
      ...step,
      status: 'pending',
      sources: step.sources ? [] : undefined,
    })),
    activity: [],
    startTime: Date.now(),
    endTime: null,
    isComplete: false,
  };
}

function clonePipeline(pipeline) {
  if (!pipeline) return null;
  return {
    ...pipeline,
    steps: pipeline.steps.map((step) => ({
      ...step,
      sources: step.sources ? [...step.sources] : undefined,
    })),
    activity: (pipeline.activity || []).map((item) =>
      item.type === 'sources'
        ? { ...item, sources: [...(item.sources || [])] }
        : { ...item },
    ),
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeSources(existing = [], incoming = []) {
  const dedup = new Map();
  [...existing, ...incoming].forEach((item) => {
    if (item?.url) dedup.set(item.url, item);
  });
  return [...dedup.values()];
}

function applyCursor(pipeline, targetIndex, { completeTarget = false } = {}) {
  pipeline.steps = pipeline.steps.map((step, idx) => {
    if (step.status === 'skipped') return step;

    if (idx < targetIndex) {
      return { ...step, status: 'completed' };
    }

    if (idx === targetIndex) {
      return { ...step, status: completeTarget ? 'completed' : 'active' };
    }

    return { ...step, status: 'pending' };
  });

  return pipeline;
}

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [detailPanelData, setDetailPanelData] = useState(null);
  const activityIdRef = useRef(0);

  const inputRef = useRef(null);
  const messagesEndRef = useRef(null);

  const typeBufferRef = useRef('');
  const displayedRef = useRef('');
  const typeTimerRef = useRef(null);
  const streamDoneRef = useRef(false);

  const statusSequenceRef = useRef(Promise.resolve());
  const lastQueuedStatusRef = useRef('');
  const maxProgressStepRef = useRef(-1);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const updateLatestAssistant = (mutator) => {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i]?.role !== 'assistant') continue;
        const updated = mutator({ ...next[i] }, i, next);
        if (!updated) return prev;
        next[i] = updated;
        return next;
      }
      return prev;
    });
  };

  const updatePipeline = (mutator) => {
    updateLatestAssistant((assistant) => {
      const pipeline = clonePipeline(assistant.taskPipeline);
      if (!pipeline) return assistant;
      assistant.taskPipeline = mutator(pipeline) || pipeline;
      return assistant;
    });
  };

  const setStepNote = (stepId, note) => {
    updatePipeline((pipeline) => {
      pipeline.steps = pipeline.steps.map((step) =>
        step.id === stepId ? { ...step, note: note || '' } : step,
      );
      return pipeline;
    });
  };

  const setStepNoteIfEmpty = (stepId, note) => {
    updatePipeline((pipeline) => {
      pipeline.steps = pipeline.steps.map((step) => {
        if (step.id !== stepId) return step;
        if (step.note) return step;
        return { ...step, note: note || '' };
      });
      return pipeline;
    });
  };

  const setStepSkipped = (stepId, note = '') => {
    updatePipeline((pipeline) => {
      pipeline.steps = pipeline.steps.map((step) =>
        step.id === stepId ? { ...step, status: 'skipped', note } : step,
      );
      return pipeline;
    });
  };

  const appendThinkingText = (text) => {
    const safeText = (text || '').trim();
    if (!safeText) return;

    updatePipeline((pipeline) => {
      const prev = pipeline.activity || [];
      if (prev[prev.length - 1]?.type === 'text' && prev[prev.length - 1]?.text === safeText) {
        return pipeline;
      }

      activityIdRef.current += 1;
      pipeline.activity = [...prev, { id: activityIdRef.current, type: 'text', text: safeText }].slice(-12);
      return pipeline;
    });
  };

  const upsertThinkingSources = ({ groupId, label, sources }) => {
    if (!sources?.length) return;

    updatePipeline((pipeline) => {
      const next = [...(pipeline.activity || [])];
      const existingIndex = next.findIndex((item) => item.type === 'sources' && item.groupId === groupId);

      if (existingIndex >= 0) {
        const existing = next[existingIndex];
        next[existingIndex] = {
          ...existing,
          label,
          sources: mergeSources(existing.sources || [], sources),
        };
      } else {
        activityIdRef.current += 1;
        next.push({
          id: activityIdRef.current,
          type: 'sources',
          groupId,
          label,
          sources: [...sources],
        });
      }

      pipeline.activity = next.slice(-12);
      return pipeline;
    });
  };

  const applyStatusTransition = (status) => {
    updatePipeline((pipeline) => {
      switch (status) {
        case 'analyze_intent':
          return applyCursor(pipeline, 0);
        case 'decide_search':
          return applyCursor(pipeline, 1);
        case 'plan_queries':
          return applyCursor(pipeline, 2);
        case 'searching':
          return applyCursor(pipeline, 3);
        case 'analyzing':
          return applyCursor(pipeline, 4);
        case 'searching_2':
          return applyCursor(pipeline, 5);
        case 'search_skipped':
        case 'search_failed': {
          pipeline.steps = pipeline.steps.map((step) => {
            if (SEARCH_STEP_IDS.has(step.id)) {
              return { ...step, status: 'skipped' };
            }
            return step;
          });
          return applyCursor(pipeline, 2, { completeTarget: true });
        }
        case 'synthesize':
          return applyCursor(pipeline, 6);
        case 'thinking':
        case 'streaming':
          return applyCursor(pipeline, 7);
        default:
          return pipeline;
      }
    });
  };

  const setStatusNarration = (status) => {
    switch (status) {
      case 'analyze_intent':
        setStepNoteIfEmpty('analyze_intent', '사용자 요청을 접수하고 핵심 의도를 분석하는 중');
        break;
      case 'decide_search':
        setStepNoteIfEmpty('decide_search', '최신성/사실성 기준으로 웹검색 필요 여부를 판단하는 중');
        break;
      case 'plan_queries':
        setStepNoteIfEmpty('plan_queries', '실행 순서를 포함한 Todo 리스트를 구성하는 중');
        break;
      case 'searching':
        setStepNoteIfEmpty('search_1', 'Todo 1단계: 1차 웹검색을 실행하는 중');
        break;
      case 'analyzing':
        setStepNoteIfEmpty('analyze_results', 'Todo 2단계: 검색 결과의 신뢰성과 누락 정보를 검토하는 중');
        break;
      case 'searching_2':
        setStepNoteIfEmpty('search_2', 'Todo 3단계: 2차 웹검색을 실행하는 중');
        break;
      case 'synthesize':
        setStepNoteIfEmpty('synthesize', '수집 근거를 바탕으로 답변 구조를 설계하는 중');
        break;
      case 'thinking':
        setStepNoteIfEmpty('generate', '최종 답변을 작성하는 중');
        break;
      case 'streaming':
        break;
      default:
        break;
    }
  };

  const queueStatusEvent = (status) => {
    if (!status) return;

    const nextStepIndex = STATUS_TO_STEP_INDEX[status] ?? -1;
    if (lastQueuedStatusRef.current === status) return;
    if (nextStepIndex !== -1 && nextStepIndex < maxProgressStepRef.current) return;

    setStatusNarration(status);
    lastQueuedStatusRef.current = status;

    statusSequenceRef.current = statusSequenceRef.current
      .then(async () => {
        applyStatusTransition(status);
        if (nextStepIndex !== -1) {
          maxProgressStepRef.current = Math.max(maxProgressStepRef.current, nextStepIndex);
        }
        const delay = STATUS_STEP_DELAY_MS[status] ?? 0;
        if (delay > 0) {
          await sleep(delay);
        }
      })
      .catch(() => {});
  };

  const completePipeline = () => {
    updatePipeline((pipeline) => {
      pipeline.steps = pipeline.steps.map((step) => {
        let nextStep = step;
        if (step.status === 'active') nextStep = { ...step, status: 'completed' };
        else if (step.status === 'pending') nextStep = { ...step, status: 'skipped' };

        if (
          nextStep.id === 'generate' &&
          nextStep.status === 'completed' &&
          (!nextStep.note || nextStep.note === '최종 답변을 작성하는 중')
        ) {
          nextStep = { ...nextStep, note: '답변 작성 완료' };
        }

        return nextStep;
      });
      pipeline.endTime = Date.now();
      pipeline.isComplete = true;
      return pipeline;
    });
  };

  const startTyping = () => {
    if (typeTimerRef.current) return;

    typeTimerRef.current = setInterval(() => {
      if (typeBufferRef.current.length === 0) {
        if (streamDoneRef.current) {
          clearInterval(typeTimerRef.current);
          typeTimerRef.current = null;
        }
        return;
      }

      const chunk = typeBufferRef.current.slice(0, CHARS_PER_TICK);
      typeBufferRef.current = typeBufferRef.current.slice(CHARS_PER_TICK);
      displayedRef.current += chunk;

      const rendered = displayedRef.current;
      updateLatestAssistant((assistant) => ({ ...assistant, content: rendered }));
    }, TYPING_SPEED);
  };

  const maybeStartTyping = (force = false) => {
    if (typeTimerRef.current) return;
    if (!force && typeBufferRef.current.length < MIN_BUFFER_BEFORE_TYPING) return;
    startTyping();
  };

  const attachSearchResult = (payload) => {
    const round = payload.round || 1;
    const stepId = round === 2 ? 'search_2' : 'search_1';

    const sources = (payload.results || [])
      .map((result) => ({
        ...result,
        round,
        query: payload.query,
        favicon: getFaviconUrl(result.url),
      }))
      .filter((item) => item.url);

    updateLatestAssistant((assistant) => {
      const pipeline = clonePipeline(assistant.taskPipeline);
      if (!pipeline) return assistant;

      pipeline.steps = pipeline.steps.map((step) => {
        if (step.id !== stepId) return step;
        return {
          ...step,
          note: `출처 ${sources.length}개 확보`,
          sources: mergeSources(step.sources || [], sources),
        };
      });

      assistant.taskPipeline = pipeline;
      return assistant;
    });

    if (sources.length > 0) {
      upsertThinkingSources({
        groupId: stepId,
        label: round === 2 ? '추가 웹검색 실행' : '웹검색 실행',
        sources,
      });
    }
  };

  const openSourcesPanel = (step, initialSourceUrl = '') => {
    const dedup = new Map();
    (step?.sources || []).forEach((source) => {
      if (source?.url) dedup.set(source.url, source);
    });

    const sources = [...dedup.values()];
    if (sources.length === 0) return;

    setDetailPanelData({
      stepId: step.id,
      stepLabel: step.label,
      note: step.note || `${sources.length}개 출처`,
      sources,
      initialSourceUrl,
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage = { role: 'user', content: trimmed };
    const nextMessages = [...messages, userMessage];

    const assistantMessage = {
      role: 'assistant',
      content: '',
      searchPlan: null,
      secondSearchDecision: null,
      taskPipeline: createPipeline(),
    };

    setInput('');
    setIsLoading(true);

    typeBufferRef.current = '';
    displayedRef.current = '';
    streamDoneRef.current = false;
    if (typeTimerRef.current) {
      clearInterval(typeTimerRef.current);
      typeTimerRef.current = null;
    }

    statusSequenceRef.current = Promise.resolve();
    lastQueuedStatusRef.current = '';
    maxProgressStepRef.current = -1;

    flushSync(() => {
      setMessages([...nextMessages, assistantMessage]);
    });

    queueStatusEvent('analyze_intent');

    try {
      const apiMessages = nextMessages.map((m) => ({ role: m.role, content: m.content }));
      const response = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, searchEnabled: true }),
      });

      if (!response.ok) {
        throw new Error(`서버 오류: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data:')) continue;

          const payloadText = line.slice(5).trim();
          if (payloadText === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payloadText);

            if (parsed.type === 'status') {
              queueStatusEvent(parsed.data);
              continue;
            }

            if (parsed.type === 'search_plan') {
              updateLatestAssistant((assistant) => ({ ...assistant, searchPlan: parsed.data }));

              const firstTopic = parsed.data?.primaryQueries?.[0] || '요청 주제';
              if (parsed.data?.shouldSearch) {
                setStepNote('decide_search', `"${firstTopic}" 관련 최신/근거 확인을 위해 웹검색이 필요합니다.`);
                setStepNote(
                  'plan_queries',
                  parsed.data?.mode === 'multi'
                    ? `Todo 확정: ${(parsed.data?.primaryQueries || []).length}개 쿼리로 단계별 검색을 진행합니다.`
                    : 'Todo 확정: 핵심 쿼리 1개로 검색을 진행합니다.',
                );
              } else {
                setStepNote('decide_search', '현재 질문은 내부 지식만으로 답변 가능한 요청입니다.');
                setStepSkipped('plan_queries', 'Todo 확정: 검색 단계 없이 답변 작성 단계로 이동합니다.');
                setStepSkipped('search_1');
                setStepSkipped('analyze_results');
                setStepSkipped('search_2');
                queueStatusEvent('search_skipped');
              }
              continue;
            }

            if (parsed.type === 'search_decision') {
              updateLatestAssistant((assistant) => ({
                ...assistant,
                secondSearchDecision: parsed.data,
              }));

              if (!parsed.data?.needsMore) {
                setStepNote(
                  'analyze_results',
                  parsed.data?.reason || 'Todo 2단계 완료: 현재 검색 결과만으로 충분한 근거를 확보했습니다.',
                );
                setStepSkipped('search_2', 'Todo 3단계 생략: 추가 검색이 필요하지 않습니다.');
              } else {
                setStepNote(
                  'analyze_results',
                  parsed.data?.reason || 'Todo 2단계 판단: 누락 정보 보강을 위해 추가 검색이 필요합니다.',
                );
                setStepNote(
                  'search_2',
                  `Todo 3단계 확정: ${(parsed.data?.refinedQueries || []).length}개 쿼리를 추가로 실행합니다.`,
                );
              }
              continue;
            }

            if (parsed.type === 'search') {
              attachSearchResult(parsed.data);
              continue;
            }

            if (parsed.type === 'search_error') {
              const stepId = parsed.data?.round === 2 ? 'search_2' : 'search_1';
              setStepNote(stepId, `검색 실패: ${parsed.data?.error || '알 수 없는 오류'}`);
              continue;
            }

            if (parsed.type === 'thinking_text') {
              appendThinkingText(parsed.data);
              continue;
            }

            if (parsed.type === 'content') {
              typeBufferRef.current += parsed.data;
              maybeStartTyping();
            }
          } catch {
            // malformed payload ignore
          }
        }
      }

      streamDoneRef.current = true;
      maybeStartTyping(true);

      if (typeTimerRef.current) {
        await new Promise((resolve) => {
          const waitTimer = setInterval(() => {
            if (!typeTimerRef.current) {
              clearInterval(waitTimer);
              resolve();
            }
          }, 16);
        });
      }
    } catch (err) {
      if (typeTimerRef.current) {
        clearInterval(typeTimerRef.current);
        typeTimerRef.current = null;
      }

      setStepNote('generate', `답변 작성 실패: ${err.message}`);
      appendThinkingText(`오류가 발생했습니다: ${err.message}`);

      updateLatestAssistant((assistant) => ({
        ...assistant,
        content: `오류가 발생했습니다: ${err.message}`,
        isError: true,
      }));
    } finally {
      await statusSequenceRef.current;
      setIsLoading(false);
      completePipeline();
      inputRef.current?.focus();
    }
  };

  const handleClear = () => {
    setMessages([]);
    setDetailPanelData(null);
  };

  return (
    <div className={`app-layout ${detailPanelData ? 'panel-open' : ''}`}>
      <div className="app">
        <header className="header">
          <h1>AI 채팅</h1>
          <div className="header-controls">
            <span className="auto-search-badge">자동 검색 오케스트레이터</span>
            {messages.length > 0 && (
              <button className="clear-btn" onClick={handleClear}>
                초기화
              </button>
            )}
          </div>
        </header>

        <main className="chat-container">
          {messages.length === 0 ? (
            <div className="empty-state">
              <p className="empty-title">무엇이든 물어보세요.</p>
              <p className="empty-sub">질문을 분석해 검색 필요 여부를 자동 판단하고, 필요할 때만 검색 후 답변합니다.</p>
            </div>
          ) : (
            <div className="messages">
              {messages.map((message, idx) => (
                <div key={idx} className="message-group">
                  {message.taskPipeline && (
                    <TaskPanel
                      pipeline={message.taskPipeline}
                      isActive={isLoading && idx === messages.length - 1}
                      onSourcesOpen={(step) => openSourcesPanel(step)}
                      onSourceClick={(step, source) => openSourcesPanel(step, source.url)}
                    />
                  )}

                  {(message.content || message.role === 'user') && (
                    <ChatMessage
                      message={message}
                      isStreaming={isLoading && idx === messages.length - 1}
                    />
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </main>

        <footer className="input-area">
          <form onSubmit={handleSubmit} className="input-form">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="메시지를 입력하세요..."
              disabled={isLoading}
              autoFocus
            />
            <button type="submit" disabled={isLoading || !input.trim()}>
              {isLoading ? '...' : '전송'}
            </button>
          </form>
        </footer>
      </div>

      {detailPanelData && (
        <SearchDetailPanel
          data={detailPanelData}
          onClose={() => setDetailPanelData(null)}
        />
      )}
    </div>
  );
}

export default App;
