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
const SIDEBAR_NAV_ITEMS = [
  { key: 'new', label: '새 작업', icon: '✎', active: false },
  { key: 'agents', label: 'Agents', icon: '◉', active: true },
  { key: 'search', label: '검색', icon: '⌕', active: false },
  { key: 'library', label: '라이브러리', icon: '▤', active: false },
];

const DEFAULT_HISTORY = [
  '윤석열 탄핵 사건 정리',
  '중소기업 매출정보 확인 방법',
  '교육 데이터 관리 플랫폼 시장 분석',
];

function truncateLabel(text, max = 26) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

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
        ? { ...item, sources: [...(item.sources || [])], queries: [...(item.queries || [])] }
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

function mergeQueries(existing = [], incoming = []) {
  const dedup = new Set();
  [...existing, ...incoming]
    .map((query) => (query || '').trim())
    .filter(Boolean)
    .forEach((query) => dedup.add(query));
  return [...dedup.values()];
}

function normalizeFollowUps(raw = []) {
  const dedup = new Set();
  const out = [];
  (Array.isArray(raw) ? raw : [])
    .map((item) => (item || '').replace(/\s+/g, ' ').trim())
    .forEach((item) => {
      if (!item) return;
      const key = item.toLowerCase();
      if (dedup.has(key)) return;
      dedup.add(key);
      out.push(item);
    });
  return out.slice(0, 3);
}

function normalizeSourceTitle(source, index) {
  const raw = (source?.title || '').replace(/\s+/g, ' ').trim();
  const safe = raw.replaceAll('[', '').replaceAll(']', '');
  return safe || `출처 ${index + 1}`;
}

function stripInlineSourceSections(content) {
  const blocks = [];
  const masked = (content || '').replace(/```[\s\S]*?```/g, (block) => {
    const token = `@@CODE_BLOCK_${blocks.length}@@`;
    blocks.push(block);
    return token;
  });

  const sourceHeadingRegex = /^(?:#{1,6}\s*)?출처\s*[:：]?\s*$/i;
  const inlineSourceRegex = /^(?:[-*]\s*)?출처\s*[:：]\s*.+$/i;
  const sourceItemRegex =
    /^(?:[-*]|\d+[.)])\s+(?:\[[^\]]+\]\(\s*https?:\/\/[^\s)]+(?:\s+"[^"]*")?\s*\)|https?:\/\/\S+|.+\s-\shttps?:\/\/\S+)\s*$/i;
  const linkOnlyRegex = /^\[[^\]]+\]\(\s*https?:\/\/[^\s)]+(?:\s+"[^"]*")?\s*\)\s*$/i;
  const urlOnlyRegex = /^https?:\/\/\S+\s*$/i;

  const lines = masked.replace(/\r/g, '').split('\n');
  const cleaned = [];
  let inSourceBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (sourceHeadingRegex.test(trimmed)) {
      inSourceBlock = true;
      continue;
    }

    if (!inSourceBlock && inlineSourceRegex.test(trimmed)) {
      continue;
    }

    if (inSourceBlock) {
      if (!trimmed) continue;
      if (
        sourceItemRegex.test(trimmed) ||
        linkOnlyRegex.test(trimmed) ||
        urlOnlyRegex.test(trimmed)
      ) {
        continue;
      }
      inSourceBlock = false;
    }

    cleaned.push(line);
  }

  const normalized = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalized.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, idx) => blocks[Number(idx)] || '');
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
  const currentQuestionRef = useRef('');

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
      pipeline.activity = [...prev, { id: activityIdRef.current, type: 'text', text: safeText }].slice(-8);
      return pipeline;
    });
  };

  const upsertThinkingProgress = (stage, text, options = {}) => {
    const safeText = (text || '').trim();
    if (!safeText) return;
    const { spinning = false } = options;

    updatePipeline((pipeline) => {
      const prev = [...(pipeline.activity || [])];
      const existingIndex = prev.findIndex((item) => item.type === 'progress' && item.stage === stage);
      if (existingIndex >= 0) {
        prev[existingIndex] = { ...prev[existingIndex], text: safeText, spinning };
        pipeline.activity = prev.slice(-8);
        return pipeline;
      }

      activityIdRef.current += 1;
      pipeline.activity = [
        ...prev,
        { id: activityIdRef.current, type: 'progress', stage, text: safeText, spinning },
      ].slice(-8);
      return pipeline;
    });
  };

  const upsertThinkingSources = ({ groupId, label, sources, query }) => {
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
          queries: mergeQueries(existing.queries || [], [query]),
        };
      } else {
        activityIdRef.current += 1;
        next.push({
          id: activityIdRef.current,
          type: 'sources',
          groupId,
          label,
          sources: [...sources],
          queries: mergeQueries([], [query]),
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
        upsertThinkingProgress(
          'decide_search',
          `요청 "${(currentQuestionRef.current || '현재 질문').slice(0, 34)}"의 검색 필요성을 확인하고 있습니다.`,
        );
        break;
      case 'plan_queries':
        setStepNoteIfEmpty('plan_queries', '실행 순서를 포함한 Todo 리스트를 구성하는 중');
        break;
      case 'searching':
        setStepNoteIfEmpty('search_1', 'Todo 1단계: 1차 웹검색을 실행하는 중');
        upsertThinkingProgress('searching', '웹검색을 실행하고 있습니다.', { spinning: true });
        break;
      case 'analyzing':
        setStepNoteIfEmpty('analyze_results', 'Todo 2단계: 검색 결과의 신뢰성과 누락 정보를 검토하는 중');
        upsertThinkingProgress('analyzing', '검색 결과를 분석하고 있습니다.');
        break;
      case 'searching_2':
        setStepNoteIfEmpty('search_2', 'Todo 3단계: 2차 웹검색을 실행하는 중');
        upsertThinkingProgress('searching_2', '누락 정보를 보강하기 위해 추가 검색 중입니다.', { spinning: true });
        break;
      case 'synthesize':
        setStepNoteIfEmpty('synthesize', '수집 근거를 바탕으로 답변 구조를 설계하는 중');
        break;
      case 'thinking':
        setStepNoteIfEmpty('generate', '최종 답변을 작성하는 중');
        upsertThinkingProgress('thinking', '신중하게 생각해서 답변을 정리하고 있습니다.', { spinning: true });
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

    const stageKey = round === 2 ? 'searching_2' : 'searching';
    const queryText = payload.query?.trim() || '검색 쿼리';
    upsertThinkingProgress(
      stageKey,
      `웹검색 실행 결과: "${queryText}" 기준 출처 ${sources.length}개를 확보했습니다.`,
      { spinning: false },
    );

    if (sources.length > 0) {
      upsertThinkingSources({
        groupId: stepId,
        label: round === 2 ? '추가 웹검색 실행' : '웹검색 실행',
        sources,
        query: payload.query,
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

  const finalizeLatestAssistant = () => {
    updateLatestAssistant((assistant) => {
      if (!assistant || assistant.isError) return assistant;

      const pipeline = assistant.taskPipeline;
      const currentContent = (assistant.content || '').trim();
      const followUps = normalizeFollowUps(assistant.followUps || []);
      if (!pipeline || !currentContent) {
        return { ...assistant, followUps };
      }

      const dedup = new Map();
      (pipeline.steps || []).forEach((step) => {
        (step.sources || []).forEach((source) => {
          if (source?.url) dedup.set(source.url, source);
        });
      });
      const sources = [...dedup.values()];

      const sanitizedContent = stripInlineSourceSections(currentContent);
      const baseContent = sanitizedContent || currentContent;
      let nextContent = baseContent;

      if (sources.length > 0) {
        const sourceLines = sources
          .slice(0, 8)
          .map((source, index) => `${index + 1}. [${normalizeSourceTitle(source, index)}](${source.url})`);
        nextContent = baseContent
          ? `${baseContent}\n\n### 출처\n${sourceLines.join('\n')}`
          : `### 출처\n${sourceLines.join('\n')}`;
      }

      return {
        ...assistant,
        content: nextContent,
        followUps,
      };
    });
  };

  const submitPrompt = async (trimmedPrompt, options = {}) => {
    const {
      baseConversation = messages,
      appendUser = true,
      clearComposer = true,
    } = options;
    const trimmed = (trimmedPrompt || '').trim();
    if (!trimmed || isLoading) return;

    const userMessage = { role: 'user', content: trimmed };
    const nextMessages = appendUser ? [...baseConversation, userMessage] : [...baseConversation];
    currentQuestionRef.current = trimmed;

    const assistantMessage = {
      role: 'assistant',
      content: '',
      searchPlan: null,
      secondSearchDecision: null,
      taskPipeline: createPipeline(),
      followUps: [],
    };

    if (clearComposer) setInput('');
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
                const requestPreview = (currentQuestionRef.current || firstTopic).slice(0, 42);
                upsertThinkingProgress(
                  'decide_search',
                  `사용자 요청 "${requestPreview}"은 최신 근거 확인이 필요해 검색을 진행합니다.`,
                  { spinning: false },
                );
                setStepNote('decide_search', `"${firstTopic}" 관련 최신/근거 확인을 위해 웹검색이 필요합니다.`);
                setStepNote(
                  'plan_queries',
                  parsed.data?.mode === 'multi'
                    ? `Todo 확정: ${(parsed.data?.primaryQueries || []).length}개 쿼리, 쿼리당 최대 ${parsed.data?.primaryResultCount || 5}건 검색합니다.`
                    : `Todo 확정: 핵심 쿼리 1개, 최대 ${parsed.data?.primaryResultCount || 5}건 검색합니다.`,
                );
              } else {
                const requestPreview = (currentQuestionRef.current || firstTopic).slice(0, 42);
                upsertThinkingProgress(
                  'decide_search',
                  `사용자 요청 "${requestPreview}"은 검색 없이 답변 가능합니다.`,
                  { spinning: false },
                );
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
                  `Todo 3단계 확정: ${(parsed.data?.refinedQueries || []).length}개 쿼리, 쿼리당 최대 ${parsed.data?.additionalResultCount || 10}건 추가 검색합니다.`,
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
              const stageKey = parsed.data?.round === 2 ? 'searching_2' : 'searching';
              upsertThinkingProgress(
                stageKey,
                `웹검색 실행 실패: ${parsed.data?.error || '알 수 없는 오류'}`,
                { spinning: false },
              );
              setStepNote(stepId, `검색 실패: ${parsed.data?.error || '알 수 없는 오류'}`);
              continue;
            }

            if (parsed.type === 'thinking_text') {
              // Thinking 패널은 프론트의 간결한 상태 문구만 노출합니다.
              continue;
            }

            if (parsed.type === 'follow_ups') {
              updateLatestAssistant((assistant) => ({
                ...assistant,
                followUps: normalizeFollowUps(parsed.data),
              }));
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
      completePipeline();
      finalizeLatestAssistant();
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    await submitPrompt(input);
  };

  const handleComposerKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (isLoading || !input.trim()) return;
    void submitPrompt(input);
  };

  const handleFollowUpClick = async (prompt) => {
    await submitPrompt(prompt);
  };

  const handleCopyAnswer = async (message) => {
    const text = (message?.content || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleRegenerateAnswer = async (assistantIndex) => {
    if (isLoading) return;

    const baseConversation = messages.slice(0, assistantIndex);
    let userIndex = -1;
    for (let i = baseConversation.length - 1; i >= 0; i -= 1) {
      if (baseConversation[i]?.role === 'user') {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;

    const prompt = (baseConversation[userIndex]?.content || '').trim();
    if (!prompt) return;

    await submitPrompt(prompt, {
      baseConversation,
      appendUser: false,
      clearComposer: false,
    });
  };

  const recentPrompts = messages
    .filter((message) => message.role === 'user' && message.content)
    .map((message) => message.content)
    .reverse()
    .slice(0, 3);
  const historyItems = recentPrompts.length > 0 ? recentPrompts : DEFAULT_HISTORY;

  return (
    <div className={`app-layout ${detailPanelData ? 'panel-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-row">
            <div className="brand-mark">
              <span className="brand-glyph" aria-hidden="true">✺</span>
              <span className="brand-name">issamGPT</span>
            </div>
            <button type="button" className="sidebar-collapse-btn" aria-label="사이드바 토글">
              <span aria-hidden="true">▮▮</span>
            </button>
          </div>

          <nav className="sidebar-nav" aria-label="주요 메뉴">
            {SIDEBAR_NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`sidebar-nav-item ${item.active ? 'active' : ''}`}
                aria-current={item.active ? 'page' : undefined}
              >
                <span className="sidebar-nav-icon" aria-hidden="true">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <section className="sidebar-section" aria-label="최근 작업">
          <div className="sidebar-section-head">
            <span className="sidebar-section-title">모든 작업</span>
            <button type="button" className="sidebar-add-btn" aria-label="새 작업 추가">＋</button>
          </div>

          <div className="sidebar-history">
            {historyItems.map((item, index) => (
              <button
                key={`${item}-${index}`}
                type="button"
                className={`sidebar-history-item ${index === 0 ? 'active' : ''}`}
              >
                <span className="sidebar-history-icon" aria-hidden="true">◧</span>
                <span className="sidebar-history-label">{truncateLabel(item)}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="sidebar-footer">
          <button type="button" className="sidebar-share-btn">issamGPT 공유하기</button>
        </div>
      </aside>

      <div className="app">
        <header className="header">
          <div className="workspace-title-wrap">
            <h1>issamGPT 1.6 Lite</h1>
            <span className="workspace-title-caret" aria-hidden="true">▾</span>
          </div>
          <div className="header-controls">
            <button type="button" className="trial-btn">무료 체험 시작</button>
            <button type="button" className="top-icon-btn" aria-label="공유">
              <span aria-hidden="true">⤴</span>
            </button>
            <button type="button" className="top-icon-btn" aria-label="설정">
              <span aria-hidden="true">⋯</span>
            </button>
          </div>
        </header>

        <main className="chat-container">
          {messages.length === 0 ? (
            <div className="empty-state">
              <p className="empty-title">issamGPT에게 물어보세요.</p>
              <p className="empty-sub">질문을 분석하고 필요한 경우에만 검색을 실행해 근거 기반 답변을 제공합니다.</p>
            </div>
          ) : (
            <div className="messages">
              {messages.map((message, idx) => (
                <div key={idx} className="message-group">
                  {(() => {
                    const isLatest = idx === messages.length - 1;
                    return message.taskPipeline && (
                      <TaskPanel
                        pipeline={message.taskPipeline}
                        isActive={isLoading && isLatest}
                        onSourcesOpen={(step) => openSourcesPanel(step)}
                        onSourceClick={(step, source) => openSourcesPanel(step, source.url)}
                      />
                    );
                  })()}

                  {(message.content || message.role === 'user') && (
                    <ChatMessage
                      message={message}
                      isStreaming={isLoading && idx === messages.length - 1}
                    />
                  )}

                  {message.role === 'assistant' &&
                    message.content &&
                    !message.isError &&
                    !(isLoading && idx === messages.length - 1) && (
                      <div className="answer-action-row">
                        <button
                          type="button"
                          className="answer-action-btn"
                          aria-label="답변 복사"
                          title="답변 복사"
                          onClick={() => handleCopyAnswer(message)}
                        >
                          ⧉
                        </button>
                        <button
                          type="button"
                          className="answer-action-btn"
                          aria-label="답변 재생성"
                          title="답변 재생성"
                          onClick={() => handleRegenerateAnswer(idx)}
                          disabled={isLoading || idx !== messages.length - 1}
                        >
                          ↻
                        </button>
                      </div>
                    )}

                  {message.role === 'assistant' &&
                    Array.isArray(message.followUps) &&
                    message.followUps.length > 0 &&
                    !(isLoading && idx === messages.length - 1) && (
                      <div className="followup-panel">
                        <p className="followup-title">추천 후속 질문</p>
                        <div className="followup-list">
                          {message.followUps.slice(0, 3).map((question, followIdx) => (
                            <button
                              key={`${question}-${followIdx}`}
                              type="button"
                              className="followup-item"
                              onClick={() => handleFollowUpClick(question)}
                              disabled={isLoading}
                            >
                              <span className="followup-icon" aria-hidden="true">◌</span>
                              <span className="followup-text">{question}</span>
                              <span className="followup-arrow" aria-hidden="true">→</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </main>

        <footer className="input-area">
          <form onSubmit={handleSubmit} className="input-form">
            <label htmlFor="chat-input" className="sr-only">메시지 입력</label>
            <textarea
              id="chat-input"
              ref={inputRef}
              className="input-textarea"
              rows={2}
              name="prompt"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="issamGPT에게 메시지 보내기…"
              autoComplete="off"
              spellCheck
              disabled={isLoading}
            />

            <div className="input-toolbar">
              <div className="input-tool-group">
                <button type="button" className="input-icon-btn" aria-label="도구 추가">
                  <span aria-hidden="true">＋</span>
                </button>
                <button type="button" className="input-icon-btn" aria-label="파일 첨부">
                  <span aria-hidden="true">⌘</span>
                </button>
                <button type="button" className="input-icon-btn" aria-label="에이전트 기능">
                  <span aria-hidden="true">✣</span>
                </button>
              </div>

              <div className="input-action-group">
                <button type="button" className="mic-btn" aria-label="음성 입력">
                  <span aria-hidden="true">⌾</span>
                </button>
                <button type="submit" className="send-btn" aria-label="전송" disabled={isLoading || !input.trim()}>
                  {isLoading ? '…' : '↑'}
                </button>
              </div>
            </div>
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
