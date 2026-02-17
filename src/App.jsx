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
  { key: 'new-chat', label: '새로운 채팅', icon: 'compose', active: true },
  { key: 'hwp-studio', label: 'HWP Studio', icon: 'hwp', active: false },
  { key: 'work-reduce', label: '업무 경감', icon: 'brief', active: false },
  { key: 'ai-box', label: 'AI Box', icon: 'box', active: false },
  { key: 'ai-mart', label: 'AI Mart', icon: 'mart', active: false },
  { key: 'archive', label: '내 자료함', icon: 'archive', active: false },
  { key: 'class', label: '클래스', icon: 'classroom', active: false },
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

function SidebarIcon({ name, className = '' }) {
  const cls = `sidebar-svg-icon ${className}`.trim();

  if (name === 'logo') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3c0 2.4-1.4 3.8-3.7 4.7 2.2.6 3.7 2.1 3.7 4.6 0-2.5 1.5-4 3.7-4.6C13.4 6.8 12 5.4 12 3Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6.1 10.5c0 1.8-1 2.7-2.8 3.4 1.8.5 2.8 1.6 2.8 3.3 0-1.7 1-2.8 2.8-3.3-1.8-.7-2.8-1.6-2.8-3.4Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17.9 10.5c0 1.8-1 2.7-2.8 3.4 1.8.5 2.8 1.6 2.8 3.3 0-1.7 1-2.8 2.8-3.3-1.8-.7-2.8-1.6-2.8-3.4Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === 'collapse') {
    return (
      <svg className={cls} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect x="6" y="6" width="20" height="20" rx="3" stroke="currentColor" strokeWidth="2" />
        <path d="M11 6V26" stroke="currentColor" strokeWidth="2" />
        <path d="M19.8281 13.0002L16.9997 15.8286L19.8281 18.657" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === 'home') {
    return (
      <svg className={cls} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M15.4268 6.62207C15.771 6.38119 16.229 6.38119 16.5732 6.62207L24.5732 12.2217C24.8405 12.4088 24.9999 12.7148 25 13.041V26H19.7275V21.5C19.7275 20.9478 19.2797 20.5001 18.7275 20.5H13.2725C12.7203 20.5001 12.2725 20.9478 12.2725 21.5V26H7V13.041C7.0001 12.7148 7.15951 12.4088 7.42676 12.2217L15.4268 6.62207Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === 'compose') {
    return (
      <svg className={cls} viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <path d="M9 13.6C9 11.6118 10.6118 10 12.6 10H23.4C25.3882 10 27 11.6118 27 13.6V20.9C27 22.8882 25.3882 24.5 23.4 24.5H22.5L19.169 27.4979C18.5254 28.0771 17.5 27.6204 17.5 26.7546V24.5H12.6C10.6118 24.5 9 22.8882 9 20.9V13.6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === 'agents') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="6.7" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M12 3.4v2.2M12 18.4v2.2M20.6 12h-2.2M5.6 12H3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === 'search') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="10.6" cy="10.6" r="5.7" stroke="currentColor" strokeWidth="1.7" />
        <path d="m15.1 15.1 4.3 4.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === 'library') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7 5.2v13.6M11.5 5.2v13.6M16.8 6.1l2.3 12.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M5 5h13.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === 'hwp') {
    return (
      <svg className={cls} viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <rect x="9" y="9" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.8" />
        <path d="M21.5 9H24C25.6569 9 27 10.3431 27 12V24C27 25.6569 25.6569 27 24 27H21.5C23.1405 26.4631 24.25 24.9326 24.25 23.2065V12.7935C24.25 11.0674 23.1405 9.53689 21.5 9Z" stroke="currentColor" strokeWidth="1.8" />
        <path d="M15.751 18.9746C15.6863 19.0045 15.6226 19.0369 15.5615 19.0732C15.1359 19.3265 14.7958 19.7571 14.7549 20.3301L14.751 20.4473L14.7549 20.5635C14.7958 21.1365 15.1359 21.5671 15.5615 21.8203C15.6234 21.8571 15.6884 21.8888 15.7539 21.9189C15.5075 21.8393 15.2957 21.7385 15.124 21.6182C14.7421 21.3504 14.5216 20.9814 14.5215 20.4473C14.5215 19.9129 14.742 19.5432 15.124 19.2754C15.2951 19.1555 15.5058 19.0541 15.751 18.9746ZM18.248 18.9746C18.4936 19.0541 18.7047 19.1553 18.876 19.2754C19.258 19.5432 19.4785 19.9129 19.4785 20.4473C19.4784 20.9814 19.2579 21.3504 18.876 21.6182C18.7041 21.7386 18.4919 21.8393 18.2451 21.9189C18.3109 21.8887 18.3763 21.8573 18.4385 21.8203C18.8924 21.5502 19.2489 21.0784 19.249 20.4473C19.249 19.8159 18.8925 19.3434 18.4385 19.0732C18.3771 19.0367 18.313 19.0046 18.248 18.9746ZM17 14.9004C17.0666 14.9004 17.1201 14.954 17.1201 15.0205V16.0234H20.0557C20.0802 16.0236 20.0996 16.0438 20.0996 16.0684C20.0995 16.0928 20.0801 16.1121 20.0557 16.1123H13.9443C13.9199 16.1121 13.9005 16.0928 13.9004 16.0684C13.9004 16.0438 13.9198 16.0236 13.9443 16.0234H16.8799V15.0205C16.8799 14.954 16.9334 14.9004 17 14.9004Z" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }

  if (name === 'brief') {
    return (
      <svg className={cls} viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <g clipPath="url(#clip0_1532_2384)">
          <path d="M27.625 19.3137V15.08C27.625 14.4963 27.3748 13.9463 26.9196 13.5338L21.5379 8.64125C21.0896 8.23375 20.4709 8 19.837 8H16.2812C14.9544 8 13.875 8.98125 13.875 10.1875V18.41L12.5 18.2425V17.6875C12.5 17.3037 12.2429 16.9587 11.851 16.8175L8.4135 15.5675C8.09862 15.4525 7.737 15.4863 7.45237 15.6613C7.16912 15.8363 7 16.1263 7 16.4375V27.0625C7 27.3737 7.16912 27.6638 7.45237 27.8388C7.62562 27.9463 7.82913 28 8.03125 28C8.1605 28 8.28975 27.9775 8.4135 27.9325L11.851 26.6825C12.0944 26.5938 12.2759 26.4225 12.3859 26.2175L17.8364 27.8213C18.2063 27.94 18.6078 28 19.0312 28C19.7738 28 20.5011 27.8 21.1474 27.415L27.9495 23.2462C28.6081 22.8337 29 22.1575 29 21.4375V20.8125C29 20.0612 28.4032 19.4625 27.625 19.3137ZM24.1036 13.625H21.7812C21.5942 13.625 21.4375 13.4825 21.4375 13.3125V11.2013L24.1036 13.625ZM15.9375 10.1875C15.9375 10.0175 16.0942 9.875 16.2812 9.875H19.375V13.3125C19.375 14.5187 20.4544 15.5 21.7812 15.5H25.5625V19.585L20.6139 20.6912C20.3004 19.785 19.4438 19.0863 18.3713 18.9588L15.9375 18.6613V10.1875ZM10.4375 25.1775V17.8225L10.4375 18.3225V25.1775ZM26.9375 21.4375C26.9375 21.5875 26.8247 21.6738 26.7876 21.6975L20.0061 25.8537C19.5455 26.1275 18.9749 26.1975 18.4964 26.0463L12.5 24.28V20.1337L18.099 20.8163C18.429 20.855 18.6875 21.1288 18.6875 21.4375C18.6875 21.78 18.3823 22.06 17.9161 22.06C17.9134 22.06 17.9106 22.06 17.9079 22.06L16.4229 21.8725C15.8523 21.8012 15.338 22.1588 15.2583 22.6713C15.1799 23.1838 15.5731 23.6575 16.1382 23.7288L18 23.9375C19.0189 23.9375 19.8989 23.425 20.3746 22.675L26.9375 21.2012V21.4375Z" fill="currentColor" />
        </g>
        <defs>
          <clipPath id="clip0_1532_2384">
            <rect width="22" height="20" fill="white" transform="translate(7 8)" />
          </clipPath>
        </defs>
      </svg>
    );
  }

  if (name === 'box') {
    return (
      <svg className={cls} viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <path d="M9 14.4395C9 13.8256 9 13.5186 9.09806 13.2338C9.19612 12.949 9.38512 12.707 9.76311 12.2232L10.419 11.3837C10.9499 10.7041 11.2153 10.3644 11.5889 10.1822C11.9624 10 12.3935 10 13.2559 10H22.8C23.6833 10 24.1249 10 24.505 10.19C24.885 10.3801 25.15 10.7334 25.68 11.44L26.28 12.24C26.6368 12.7158 26.8153 12.9537 26.9076 13.2308C27 13.5079 27 13.8053 27 14.4V15.8667V22.4C27 24.0971 27 24.9456 26.4728 25.4728C25.9456 26 25.0971 26 23.4 26H12.6C10.9029 26 10.0544 26 9.52721 25.4728C9 24.9456 9 24.0971 9 22.4V15.8667V14.4395Z" stroke="currentColor" strokeWidth="1.8" />
        <path d="M10.2028 11.6344L9.21758 12.8758C9.07668 13.0534 9 13.2734 9 13.5H27C27 13.2729 26.9258 13.052 26.7887 12.871L25.9107 11.7117C25.2743 10.8716 24.9562 10.4515 24.502 10.2258C24.0478 10 23.5208 10 22.4669 10H13.5866C12.5615 10 12.049 10 11.6039 10.215C11.1587 10.43 10.8401 10.8315 10.2028 11.6344Z" stroke="currentColor" strokeWidth="1.8" />
        <path d="M15.3018 17.0996H20.8018" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === 'mart') {
    return (
      <svg className={cls} viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <path d="M8.62127 16.4851C8.33529 15.3411 8.19229 14.7692 8.49257 14.3846C8.79285 14 9.38242 14 10.5616 14H25.4384C26.6176 14 27.2072 14 27.5074 14.3846C27.8077 14.7692 27.6647 15.3411 27.3787 16.4851L25.3787 24.4851C25.1968 25.2126 25.1059 25.5764 24.8346 25.7882C24.5634 26 24.1884 26 23.4384 26H12.5616C11.8116 26 11.4366 26 11.1654 25.7882C10.8941 25.5764 10.8032 25.2126 10.6213 24.4851L8.62127 16.4851Z" fill="white" stroke="currentColor" strokeWidth="1.8" />
        <path d="M10 18H26" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M13 13.4639L15 9.99977" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M23 13.4639L21 9.99977" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === 'archive') {
    return (
      <svg className={cls} viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <rect width="36" height="36" rx="4" fill="transparent" />
        <path d="M9 13.1999C9 11.8882 9 11.2323 9.32553 10.7674C9.44596 10.5954 9.59556 10.4458 9.76756 10.3254C10.2325 9.99987 10.8883 9.99987 12.2 9.99987H19.8C21.1117 9.99987 21.7675 9.99987 22.2324 10.3254C22.4044 10.4458 22.554 10.5954 22.6745 10.7674C23 11.2323 23 11.8882 23 13.1999V15.8665V22.3999C23 24.0969 23 24.9455 22.4728 25.4727C21.9456 25.9999 21.0971 25.9999 19.4 25.9999H12.6C10.9029 25.9999 10.0544 25.9999 9.52721 25.4727C9 24.9455 9 24.0969 9 22.3999V15.8665V13.1999Z" stroke="currentColor" strokeWidth="1.8" />
        <path d="M9 16.4V14H24.6C25.158 14 25.437 14 25.6659 14.0613C26.287 14.2278 26.7722 14.713 26.9387 15.3341C27 15.563 27 15.842 27 16.4V18.4V22.4C27 24.0971 27 24.9456 26.4728 25.4728C25.9456 26 25.0971 26 23.4 26H12.6C10.9029 26 10.0544 26 9.52721 25.4728C9 24.9456 9 24.0971 9 22.4V18.4V16.4Z" fill="white" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }

  if (name === 'classroom') {
    return (
      <svg className={cls} viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <rect x="8" y="11" width="20" height="15" rx="4" stroke="currentColor" strokeWidth="1.8" />
        <path d="M20 18.9004H24C24.6075 18.9004 25.0996 19.3925 25.0996 20V22.0996H18.9004V20C18.9004 19.3925 19.3925 18.9004 20 18.9004Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M9 22H27" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15 11L18 8L21 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === 'project') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3.8 7.5a2 2 0 0 1 2-2h4l1.5 1.8h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2V7.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 10.2v5.6M9.2 13h5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === 'pencil') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m6.2 16.8 9.5-9.5 2.3 2.3-9.5 9.5-3.2.9.9-3.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="m14.8 8.2 2.3 2.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === 'clip') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m9.6 12.8 5.1-5.1a2.6 2.6 0 1 1 3.7 3.7l-6.7 6.7a4.1 4.1 0 0 1-5.8-5.8L12 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === 'image') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="4.7" y="5.4" width="14.6" height="13.2" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="9" cy="10" r="1.5" fill="currentColor" />
        <path d="m8 16 3-2.9L13.2 15l2.2-2 2.6 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === 'spark') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 4.2c.3 2.8 1.4 4 4.2 4.3-2.8.3-4 1.4-4.2 4.2-.3-2.8-1.4-4-4.2-4.2 2.8-.3 3.9-1.5 4.2-4.3Z" fill="currentColor" />
        <path d="M17.8 12.8c.2 1.7.9 2.4 2.6 2.6-1.7.2-2.4.9-2.6 2.6-.2-1.7-.9-2.4-2.6-2.6 1.7-.2 2.4-.9 2.6-2.6Z" fill="currentColor" />
      </svg>
    );
  }

  if (name === 'more') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="8" cy="12" r="1.4" fill="currentColor" />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" />
        <circle cx="16" cy="12" r="1.4" fill="currentColor" />
      </svg>
    );
  }

  if (name === 'history') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2.4" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9 10h6M9 13h6M9 16h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === 'share') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m10.1 8.9 3.8-3.8a3 3 0 1 1 4.2 4.2l-3.8 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="m13.9 15.1-3.8 3.8a3 3 0 1 1-4.2-4.2l3.8-3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="m9.3 14.7 5.4-5.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return null;
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(true);
  const activityIdRef = useRef(0);
  const currentQuestionRef = useRef('');

  const inputRef = useRef(null);
  const chatContainerRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);

  const typeBufferRef = useRef('');
  const displayedRef = useRef('');
  const typeTimerRef = useRef(null);
  const streamDoneRef = useRef(false);

  const statusSequenceRef = useRef(Promise.resolve());
  const lastQueuedStatusRef = useRef('');
  const maxProgressStepRef = useRef(-1);

  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    if (!shouldStickToBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, isLoading]);

  const handleChatScroll = () => {
    const container = chatContainerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceToBottom < 88;
  };

  const scrollMessageToTop = (messageIndex) => {
    const container = chatContainerRef.current;
    if (!container || messageIndex < 0) return;

    const target = container.querySelector(
      `.message-group[data-message-index="${messageIndex}"][data-message-role="user"]`,
    );
    if (!target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const nextTop = container.scrollTop + (targetRect.top - containerRect.top) - 8;

    container.scrollTo({
      top: Math.max(0, nextTop),
      behavior: 'smooth',
    });
  };

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

  const appendThinkingBlock = (text) => {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8);
    lines.forEach((line) => appendThinkingText(line));
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
      alignUserMessageTop,
    } = options;
    const trimmed = (trimmedPrompt || '').trim();
    if (!trimmed || isLoading) return;

    const userMessage = { role: 'user', content: trimmed };
    const nextMessages = appendUser ? [...baseConversation, userMessage] : [...baseConversation];
    const shouldAlignUserMessageTop =
      typeof alignUserMessageTop === 'boolean'
        ? alignUserMessageTop
        : appendUser && baseConversation.length > 0;
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
    shouldStickToBottomRef.current = !shouldAlignUserMessageTop;

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

    if (shouldAlignUserMessageTop && appendUser) {
      const userMessageIndex = nextMessages.length - 1;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollMessageToTop(userMessageIndex);
        });
      });
    }

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
                upsertThinkingProgress(
                  'decide_search',
                  '검색 필요성이 확인되어 웹검색을 진행합니다.',
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
                upsertThinkingProgress(
                  'decide_search',
                  '검색 없이 답변 가능한 요청으로 판단했습니다.',
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

            if (parsed.type === 'thinking_intro') {
              appendThinkingBlock(parsed.data);
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
    await submitPrompt(prompt, { alignUserMessageTop: true });
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

  const firstPrompt = messages.find((message) => message.role === 'user' && message.content)?.content || '';
  const historyItems = firstPrompt ? [firstPrompt] : DEFAULT_HISTORY;

  return (
    <div className={`app-layout ${detailPanelData ? 'panel-open' : ''} ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-inner">
          <div className="brand-row">
            <div className="brand-mark">
              <img
                src="https://issamgpt.com/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Flogo.266e423a.png&w=256&q=75"
                alt="issamGPT"
                className="brand-logo-image"
                loading="eager"
                decoding="async"
              />
            </div>
            {!isSidebarCollapsed && (
              <button
                type="button"
                className="sidebar-collapse-btn"
                aria-label="사이드바 접기"
                title="사이드바 접기"
                onClick={() => setIsSidebarCollapsed(true)}
              >
                <SidebarIcon name="collapse" />
              </button>
            )}
          </div>

          <nav className="sidebar-nav" aria-label="주요 메뉴">
            {isSidebarCollapsed && (
              <button
                type="button"
                className="sidebar-nav-item sidebar-home-nav-item"
                aria-label="사이드바 펼치기"
                title="사이드바 펼치기"
                onClick={() => setIsSidebarCollapsed(false)}
              >
                <span className="sidebar-nav-icon" aria-hidden="true">
                  <SidebarIcon name="home" />
                </span>
                <span className="sidebar-nav-label">홈</span>
              </button>
            )}
            {SIDEBAR_NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`sidebar-nav-item ${item.active ? 'active' : ''}`}
                aria-current={item.active ? 'page' : undefined}
                aria-label={item.label}
                title={item.label}
              >
                <span className="sidebar-nav-icon" aria-hidden="true">
                  <SidebarIcon name={item.icon} />
                </span>
                <span className="sidebar-nav-label">{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-divider" />

          <button
            type="button"
            className="sidebar-history-title"
            aria-label="채팅 기록"
            title="채팅 기록"
            aria-expanded={isHistoryExpanded}
            onClick={() => setIsHistoryExpanded((prev) => !prev)}
          >
            <div className="sidebar-history-title-inner">
              <div className="sidebar-history-title-main">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" className="sidebar-history-title-clock" aria-hidden="true">
                  <path d="M12 18.4C13.6974 18.4 15.3253 17.7257 16.5255 16.5255C17.7257 15.3253 18.4 13.6974 18.4 12C18.4 10.3026 17.7257 8.67475 16.5255 7.47452C15.3253 6.27428 13.6974 5.6 12 5.6C10.3026 5.6 8.67475 6.27428 7.47452 7.47452C6.27428 8.67475 5.6 10.3026 5.6 12C5.6 13.6974 6.27428 15.3253 7.47452 16.5255C8.67475 17.7257 10.3026 18.4 12 18.4ZM12 4C13.0506 4 14.0909 4.20693 15.0615 4.60896C16.0321 5.011 16.914 5.60028 17.6569 6.34315C18.3997 7.08601 18.989 7.96793 19.391 8.93853C19.7931 9.90914 20 10.9494 20 12C20 14.1217 19.1571 16.1566 17.6569 17.6569C16.1566 19.1571 14.1217 20 12 20C7.576 20 4 16.4 4 12C4 9.87827 4.84285 7.84344 6.34315 6.34315C7.84344 4.84285 9.87827 4 12 4ZM12.4 8V12.2L16 14.336L15.4 15.32L11.2 12.8V8H12.4Z" fill="#9F9F9F" />
                </svg>
                <span className="sidebar-history-title-text">채팅 기록</span>
              </div>
              <span className="sidebar-history-title-chevron" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="6" fill="none" className="sidebar-history-title-chevron-icon">
                  {isHistoryExpanded ? (
                    <path fillRule="evenodd" clipRule="evenodd" d="M11.7933 5.80919C11.5176 6.0636 11.0706 6.0636 10.795 5.80919L6 1.38388L1.20502 5.80919C0.929352 6.0636 0.482411 6.0636 0.206747 5.80919C-0.0689172 5.55478 -0.0689172 5.1423 0.206747 4.88788L5.15147 0.324375C5.6201 -0.108125 6.3799 -0.108125 6.84853 0.324375L11.7933 4.88788C12.0689 5.1423 12.0689 5.55478 11.7933 5.80919ZM6.14974 1.24568C6.14967 1.24574 6.14961 1.2458 6.14954 1.24586L6.14974 1.24568ZM5.85046 1.24586C5.85039 1.2458 5.85033 1.24574 5.85026 1.24568L5.85046 1.24586Z" fill="#9F9F9F" />
                  ) : (
                    <path fillRule="evenodd" clipRule="evenodd" d="M11.7933 0.190809C11.5176 -0.0636029 11.0706 -0.0636029 10.795 0.190809L6 4.61612L1.20502 0.190809C0.929352 -0.0636031 0.482411 -0.0636031 0.206747 0.190809C-0.0689172 0.445221 -0.0689172 0.857704 0.206747 1.11212L5.15147 5.67562C5.6201 6.10812 6.3799 6.10813 6.84853 5.67562L11.7933 1.11212C12.0689 0.857704 12.0689 0.445221 11.7933 0.190809ZM6.14974 4.75432C6.14967 4.75426 6.14961 4.7542 6.14954 4.75414L6.14974 4.75432ZM5.85046 4.75414C5.85039 4.7542 5.85033 4.75426 5.85026 4.75432L5.85046 4.75414Z" fill="#9F9F9F" />
                  )}
                </svg>
              </span>
            </div>
          </button>

          {isHistoryExpanded && (
            <div className="sidebar-history" aria-label="채팅 기록 목록">
              {historyItems.map((item, index) => (
                <button
                  key={`${item}-${index}`}
                  type="button"
                  className={`sidebar-history-item ${index === 0 ? 'active' : ''}`}
                  aria-label={item}
                  title={item}
                >
                  <span className="sidebar-history-dot" aria-hidden="true" />
                  <span className="sidebar-history-label">{truncateLabel(item)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="sidebar-profile">
          <div className="sidebar-profile-main">
            <div className="sidebar-user-row">
              <span className="sidebar-user-name">이쌤</span>
              <span className="sidebar-pro-badge">Pro</span>
            </div>
            <p className="sidebar-school">서울교육고등학교</p>
          </div>
          <button type="button" className="sidebar-profile-more" aria-label="프로필 메뉴" title="프로필 메뉴">
            <SidebarIcon name="more" />
          </button>
        </div>
      </aside>

      <div className="app">
        <main ref={chatContainerRef} className="chat-container" onScroll={handleChatScroll}>
          {messages.length === 0 ? (
            <div className="empty-state">
              <p className="empty-title">교사를 위한 AI 비서, issamGPT</p>
              <p className="empty-sub">수업 준비, 문서 작성, 학급 운영 업무를 빠르게 도와드립니다.</p>
            </div>
          ) : (
            <div className="messages">
              {messages.map((message, idx) => (
                <div
                  key={idx}
                  className="message-group"
                  data-message-index={idx}
                  data-message-role={message.role}
                >
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
                          aria-label="답변 재생성"
                          title="답변 재생성"
                          onClick={() => handleRegenerateAnswer(idx)}
                          disabled={isLoading || idx !== messages.length - 1}
                        >
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <path d="M8.50777 6.90321C9.42803 6.41124 10.4554 6.15386 11.4989 6.15385C13.8986 6.15385 15.5075 7.4929 17.1226 9.23077H15.3453C15.0267 9.23077 14.7685 9.48907 14.7685 9.80769C14.7685 10.1263 15.0267 10.3846 15.3453 10.3846H18.4218C18.7319 10.3846 18.9849 10.1398 18.9981 9.83288C19.0004 9.80615 19.0007 9.77908 18.9986 9.75184V6.73077C18.9986 6.41214 18.7404 6.15385 18.4218 6.15385C18.1032 6.15385 17.8449 6.41214 17.8449 6.73077V8.31132C16.211 6.57015 14.3187 5 11.4989 5C10.2657 5.00001 9.0515 5.3042 7.96392 5.88561C6.87634 6.46703 5.94891 7.30773 5.26378 8.33325C4.57865 9.35877 4.15698 10.5375 4.03611 11.7649C3.91524 12.9923 4.0989 14.2306 4.57083 15.3701C5.04276 16.5096 5.78838 17.5151 6.74166 18.2976C7.69494 19.08 8.82644 19.6153 10.0359 19.8559C11.2455 20.0965 12.4956 20.0351 13.6757 19.6771C14.8558 19.319 15.9294 18.6755 16.8015 17.8033C17.0267 17.578 17.0267 17.2127 16.8015 16.9874C16.5762 16.7621 16.211 16.7621 15.9857 16.9874C15.2478 17.7254 14.3394 18.27 13.3408 18.5729C12.3423 18.8758 11.2845 18.9278 10.261 18.7242C9.2376 18.5206 8.28017 18.0677 7.47355 17.4056C6.66693 16.7436 6.03601 15.8928 5.63669 14.9286C5.23737 13.9644 5.08196 12.9166 5.18424 11.878C5.28651 10.8394 5.64331 9.84204 6.22303 8.97429C6.80276 8.10654 7.5875 7.39518 8.50777 6.90321Z" fill="currentColor" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="answer-action-btn"
                          aria-label="답변 복사"
                          title="답변 복사"
                          onClick={() => handleCopyAnswer(message)}
                        >
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <rect x="4" y="8" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.2" />
                            <path d="M15.3462 15H17C18.6569 15 20 13.6569 20 12V7C20 5.34315 18.6569 4 17 4H12C10.3431 4 9 5.34315 9 7V7.53571" stroke="currentColor" strokeWidth="1.2" />
                          </svg>
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
            </div>
          )}
        </main>

        <footer className="input-area">
          <form onSubmit={handleSubmit} className="input-form">
            <div className="input-hint-bar">
              <span className="input-hint-icon" aria-hidden="true"><SidebarIcon name="pencil" /></span>
              <span>오늘은 어떤 도움을 드릴까요?</span>
            </div>
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
              placeholder="수업 자료 제작부터 행정 업무까지 요청해 보세요."
              autoComplete="off"
              spellCheck
              disabled={isLoading}
            />

            <div className="input-toolbar">
              <div className="input-tool-group">
                <button type="button" className="input-icon-btn" aria-label="파일 첨부">
                  <SidebarIcon name="clip" />
                </button>
                <button type="button" className="input-icon-btn" aria-label="이미지 첨부">
                  <SidebarIcon name="image" />
                </button>
              </div>

              <div className="input-action-group">
                <button type="submit" className="generate-btn" aria-label="생성하기" disabled={isLoading || !input.trim()}>
                  <span>생성하기</span>
                  <span className="generate-btn-icon" aria-hidden="true"><SidebarIcon name="spark" /></span>
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
