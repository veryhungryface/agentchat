# SVG + CSS + Streaming 비주얼 제작 가이드

> Claude의 `show_widget` 도구에서 SVG와 CSS 애니메이션을 결합해  
> 스트리밍 도중에도 자연스럽게 렌더링되는 비주얼을 만드는 기법입니다.

---

## 1. 핵심 개념 이해

### 왜 SVG + CSS인가?

| 비교 항목 | JavaScript 기반 | SVG + CSS 기반 |
|-----------|----------------|----------------|
| 스트리밍 호환성 | ❌ 스크립트는 스트리밍 완료 후 실행 | ✅ 파싱 즉시 렌더링 |
| 애니메이션 | JS로 직접 제어 | CSS로 선언적 정의 |
| 성능 | 메인 스레드 점유 | GPU 가속 가능 |
| 복잡도 | 높음 | 중간 |

**핵심 원리**: `show_widget`은 코드를 스트리밍으로 전송합니다. SVG 요소는 브라우저가 태그를 받는 즉시 화면에 그리기 시작하고, CSS 애니메이션은 요소가 DOM에 추가되는 순간 자동으로 시작됩니다. 이 조합 덕분에 "점진적으로 나타나는" 자연스러운 효과가 만들어집니다.

---

## 2. 기본 구조

### 2.1 최소 템플릿

```svg
<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">
  <style>
    /* CSS 변수로 테마 대응 */
    text { fill: var(--text-color, #333); }
    
    /* 페이드인 애니메이션 */
    @keyframes fadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    
    .fade-in {
      opacity: 0;
      animation: fadeIn 0.6s ease-out forwards;
    }
  </style>
  
  <!-- 배경 -->
  <rect width="800" height="500" fill="var(--bg-color, #fafafa)" rx="12"/>
  
  <!-- 콘텐츠 -->
  <text x="400" y="250" text-anchor="middle" class="fade-in"
        font-size="24" font-weight="600">
    Hello, SVG + CSS!
  </text>
</svg>
```

### 2.2 HTML 모드에서 SVG 사용

HTML 래퍼 안에 SVG를 넣으면 더 유연한 레이아웃이 가능합니다:

```html
<div style="max-width: 800px; margin: 0 auto;">
  <svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">
    <style>
      /* 여기에 스타일 */
    </style>
    <!-- SVG 콘텐츠 -->
  </svg>
</div>
```

---

## 3. CSS 변수로 다크/라이트 테마 대응

`show_widget`은 CSS 변수를 자동 주입합니다. **반드시 이를 활용해야** 양쪽 테마에서 잘 보입니다.

### 주요 CSS 변수

```css
/* 필수 변수들 */
var(--text-color)        /* 기본 텍스트 색 */
var(--bg-primary)        /* 주 배경색 */
var(--bg-secondary)      /* 보조 배경색 */
var(--border-color)      /* 테두리 색 */
var(--accent-color)      /* 강조색 */
var(--text-secondary)    /* 보조 텍스트 색 */
```

### 적용 예시

```svg
<svg viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg">
  <style>
    .card-bg   { fill: var(--bg-secondary, #f0f0f0); }
    .title     { fill: var(--text-color, #111); font-size: 20px; }
    .subtitle  { fill: var(--text-secondary, #666); font-size: 14px; }
    .accent    { fill: var(--accent-color, #3b82f6); }
    .border    { stroke: var(--border-color, #ddd); fill: none; }
  </style>
  
  <rect width="600" height="300" class="card-bg" rx="16"/>
  <rect width="600" height="300" class="border" rx="16" stroke-width="1"/>
  <text x="30" y="50" class="title">제목</text>
  <text x="30" y="75" class="subtitle">부제목</text>
  <circle cx="550" cy="50" r="20" class="accent"/>
</svg>
```

---

## 4. 스트리밍 친화적 애니메이션 패턴

### 4.1 순차적 페이드인 (animation-delay)

가장 강력한 패턴입니다. 요소마다 `animation-delay`를 다르게 주면 스트리밍으로 도착하는 순서와 맞물려 자연스럽게 나타납니다.

```svg
<style>
  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  
  .item {
    opacity: 0;
    animation: fadeSlideUp 0.5s ease-out forwards;
  }
  .item:nth-child(1) { animation-delay: 0.0s; }
  .item:nth-child(2) { animation-delay: 0.15s; }
  .item:nth-child(3) { animation-delay: 0.3s; }
  .item:nth-child(4) { animation-delay: 0.45s; }
</style>

<g class="item"><rect .../><text ...>항목 1</text></g>
<g class="item"><rect .../><text ...>항목 2</text></g>
<g class="item"><rect .../><text ...>항목 3</text></g>
<g class="item"><rect .../><text ...>항목 4</text></g>
```

### 4.2 바 차트 그로우 애니메이션

```svg
<style>
  @keyframes growUp {
    from { transform: scaleY(0); }
    to   { transform: scaleY(1); }
  }
  
  .bar {
    transform-origin: bottom;
    animation: growUp 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }
  .bar-1 { animation-delay: 0.1s; }
  .bar-2 { animation-delay: 0.2s; }
  .bar-3 { animation-delay: 0.3s; }
</style>
```

> **팁**: `scaleY`에 `transform-origin: bottom`을 쓰면 바가 아래에서 위로 자랍니다.

### 4.3 라인 드로잉 (stroke-dashoffset)

SVG의 `stroke-dasharray`와 `stroke-dashoffset`을 조합하면 선이 그려지는 효과를 만들 수 있습니다.

```svg
<style>
  .draw-line {
    stroke-dasharray: 500;
    stroke-dashoffset: 500;
    animation: drawLine 1.5s ease-out forwards;
  }
  
  @keyframes drawLine {
    to { stroke-dashoffset: 0; }
  }
</style>

<path class="draw-line"
      d="M 50 200 Q 200 50 350 180 T 650 150"
      fill="none" stroke="#3b82f6" stroke-width="3"/>
```

### 4.4 펄스 / 글로우 효과

```svg
<style>
  @keyframes pulse {
    0%, 100% { opacity: 0.4; r: 8; }
    50%      { opacity: 1;   r: 12; }
  }
  
  .pulse-dot {
    animation: pulse 2s ease-in-out infinite;
  }
</style>

<circle class="pulse-dot" cx="100" cy="100" r="8" fill="#10b981"/>
```

---

## 5. 실전 레시피

### 5.1 데이터 카드 레이아웃

```svg
<svg viewBox="0 0 800 200" xmlns="http://www.w3.org/2000/svg">
  <style>
    @keyframes cardIn {
      from { opacity: 0; transform: translateY(15px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .card {
      opacity: 0;
      animation: cardIn 0.5s ease-out forwards;
    }
    .card-bg { fill: var(--bg-secondary, #fff); rx: 12; }
    .card-border { stroke: var(--border-color, #e5e7eb); fill: none; rx: 12; }
    .card-title { fill: var(--text-color, #111); font-size: 14px; font-weight: 600; }
    .card-value { fill: var(--accent-color, #3b82f6); font-size: 28px; font-weight: 700; }
    .card-label { fill: var(--text-secondary, #888); font-size: 11px; }
  </style>

  <!-- 카드 1 -->
  <g class="card" style="animation-delay: 0s">
    <rect class="card-bg" x="10" y="10" width="185" height="140"/>
    <rect class="card-border" x="10" y="10" width="185" height="140"/>
    <text class="card-label" x="30" y="45">총 방문자</text>
    <text class="card-value" x="30" y="85">12,847</text>
    <text class="card-title" x="30" y="120" fill="#10b981">↑ 12.5%</text>
  </g>

  <!-- 카드 2 -->
  <g class="card" style="animation-delay: 0.15s">
    <rect class="card-bg" x="210" y="10" width="185" height="140"/>
    <rect class="card-border" x="210" y="10" width="185" height="140"/>
    <text class="card-label" x="230" y="45">전환율</text>
    <text class="card-value" x="230" y="85">3.24%</text>
    <text class="card-title" x="230" y="120" fill="#10b981">↑ 0.8%</text>
  </g>

  <!-- 카드 3, 4도 같은 패턴... -->
</svg>
```

### 5.2 타임라인

```svg
<svg viewBox="0 0 700 400" xmlns="http://www.w3.org/2000/svg">
  <style>
    @keyframes reveal {
      from { opacity: 0; transform: translateX(-20px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .timeline-item {
      opacity: 0;
      animation: reveal 0.5s ease-out forwards;
    }
    /* 중앙 선 드로잉 */
    .timeline-line {
      stroke-dasharray: 350;
      stroke-dashoffset: 350;
      animation: drawLine 1.2s ease-out forwards;
    }
    @keyframes drawLine {
      to { stroke-dashoffset: 0; }
    }
  </style>

  <!-- 중앙 세로선 -->
  <line class="timeline-line"
        x1="100" y1="30" x2="100" y2="370"
        stroke="var(--border-color, #ddd)" stroke-width="2"/>

  <!-- 이벤트들 -->
  <g class="timeline-item" style="animation-delay: 0.3s">
    <circle cx="100" cy="80" r="6" fill="var(--accent-color, #3b82f6)"/>
    <text x="125" y="75" fill="var(--text-color)" font-size="14" font-weight="600">
      2024년 1월
    </text>
    <text x="125" y="95" fill="var(--text-secondary)" font-size="12">
      프로젝트 시작
    </text>
  </g>

  <!-- 추가 이벤트들... -->
</svg>
```

---

## 6. 고급 테크닉

### 6.1 SVG 필터로 블러/그림자

```svg
<defs>
  <filter id="softShadow" x="-10%" y="-10%" width="130%" height="130%">
    <feDropShadow dx="0" dy="4" stdDeviation="6" flood-opacity="0.1"/>
  </filter>
  
  <filter id="glow">
    <feGaussianBlur stdDeviation="3" result="blur"/>
    <feMerge>
      <feMergeNode in="blur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
</defs>

<rect filter="url(#softShadow)" .../>
<circle filter="url(#glow)" .../>
```

### 6.2 그래디언트 활용

```svg
<defs>
  <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#3b82f6"/>
    <stop offset="100%" stop-color="#1d4ed8"/>
  </linearGradient>
  
  <radialGradient id="bgGlow" cx="50%" cy="30%">
    <stop offset="0%" stop-color="var(--accent-color)" stop-opacity="0.08"/>
    <stop offset="100%" stop-color="transparent"/>
  </radialGradient>
</defs>

<rect fill="url(#barGrad)" .../>
<rect fill="url(#bgGlow)" width="800" height="500"/>
```

### 6.3 클리핑과 마스킹

```svg
<defs>
  <clipPath id="roundedClip">
    <rect x="50" y="50" width="200" height="200" rx="20"/>
  </clipPath>
</defs>

<image clip-path="url(#roundedClip)" 
       href="..." x="50" y="50" width="200" height="200"/>
```

---

## 7. 자주 하는 실수 & 해결법

### ❌ 실수 1: transform-origin을 안 잡음

```svg
/* 잘못됨 - SVG에서 transform-origin 기본값이 다름 */
.bar { animation: growUp 0.5s forwards; }

/* 올바름 - 명시적으로 origin 설정 */
.bar { 
  animation: growUp 0.5s forwards;
  transform-origin: center bottom; 
  /* 또는 구체적 좌표: transform-origin: 100px 300px; */
}
```

### ❌ 실수 2: SVG 내에서 CSS 변수 폴백 누락

```svg
/* 잘못됨 - 다크모드에서 안 보일 수 있음 */
text { fill: #333; }

/* 올바름 - CSS 변수 + 폴백 */
text { fill: var(--text-color, #333); }
```

### ❌ 실수 3: viewBox 미설정

```svg
<!-- 잘못됨 - 반응형 안 됨 -->
<svg width="800" height="500">

<!-- 올바름 - 반응형 대응 -->
<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">
```

### ❌ 실수 4: 너무 큰 dasharray 값

```svg
/* stroke-dasharray 값은 실제 path 길이에 맞춰야 함 */
/* getTotalLength()로 확인하거나 넉넉하게 잡기 */
.line {
  stroke-dasharray: 1000;  /* path가 500px인데 1000이면 비효율 */
  stroke-dashoffset: 1000;
}
```

---

## 8. 체크리스트

시작 전 확인사항:

- [ ] `viewBox` 설정했는가?
- [ ] CSS 변수(`var(--text-color)` 등)로 테마 대응했는가?
- [ ] `xmlns="http://www.w3.org/2000/svg"` 포함했는가?
- [ ] `animation-delay`로 순차 등장 효과를 줬는가?
- [ ] `opacity: 0` + `animation-fill-mode: forwards`로 초기 상태 숨김 처리했는가?
- [ ] 복잡한 그래디언트/필터는 `<defs>` 안에 넣었는가?
- [ ] 텍스트에 적절한 `font-family`를 지정했는가?
- [ ] 배경색은 투명하게 두거나 CSS 변수로 처리했는가?

---

## 9. 완성 예제: 미니 대시보드

```svg
<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg">
  <style>
    @keyframes fadeSlideUp {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes growBar {
      from { transform: scaleY(0); }
      to   { transform: scaleY(1); }
    }
    @keyframes drawPath {
      to { stroke-dashoffset: 0; }
    }
    
    .appear { opacity: 0; animation: fadeSlideUp 0.5s ease-out forwards; }
    .bar-grow { transform-origin: center bottom; animation: growBar 0.7s cubic-bezier(0.34,1.56,0.64,1) forwards; }
    
    .heading { font-size: 18px; font-weight: 700; fill: var(--text-color, #111); }
    .label   { font-size: 11px; fill: var(--text-secondary, #888); }
    .value   { font-size: 26px; font-weight: 700; fill: var(--text-color, #111); }
    .card-bg { fill: var(--bg-secondary, #f9fafb); }
    
    .trend-line {
      stroke-dasharray: 600;
      stroke-dashoffset: 600;
      animation: drawPath 1.5s ease-out 0.5s forwards;
    }
  </style>
  
  <defs>
    <linearGradient id="blue" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#60a5fa"/>
      <stop offset="100%" stop-color="#3b82f6"/>
    </linearGradient>
    <linearGradient id="green" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#34d399"/>
      <stop offset="100%" stop-color="#10b981"/>
    </linearGradient>
    <filter id="shadow">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.06"/>
    </filter>
  </defs>
  
  <!-- 제목 -->
  <text class="heading appear" x="30" y="35" style="animation-delay:0s">
    📊 주간 리포트
  </text>
  
  <!-- KPI 카드들 -->
  <g class="appear" style="animation-delay:0.1s" filter="url(#shadow)">
    <rect class="card-bg" x="30" y="55" width="160" height="90" rx="10"/>
    <text class="label" x="50" y="82">매출</text>
    <text class="value" x="50" y="118" fill="#3b82f6">₩2.4M</text>
  </g>
  
  <g class="appear" style="animation-delay:0.2s" filter="url(#shadow)">
    <rect class="card-bg" x="210" y="55" width="160" height="90" rx="10"/>
    <text class="label" x="230" y="82">신규 유저</text>
    <text class="value" x="230" y="118" fill="#10b981">+847</text>
  </g>
  
  <g class="appear" style="animation-delay:0.3s" filter="url(#shadow)">
    <rect class="card-bg" x="390" y="55" width="160" height="90" rx="10"/>
    <text class="label" x="410" y="82">전환율</text>
    <text class="value" x="410" y="118" fill="#f59e0b">3.2%</text>
  </g>
  
  <!-- 바 차트 -->
  <g class="appear" style="animation-delay:0.4s">
    <text class="label" x="30" y="185">일별 매출 (만원)</text>
    
    <rect class="bar-grow" style="animation-delay:0.5s" x="50"  y="250" width="40" height="120" rx="4" fill="url(#blue)"/>
    <rect class="bar-grow" style="animation-delay:0.6s" x="110" y="280" width="40" height="90"  rx="4" fill="url(#blue)"/>
    <rect class="bar-grow" style="animation-delay:0.7s" x="170" y="230" width="40" height="140" rx="4" fill="url(#blue)"/>
    <rect class="bar-grow" style="animation-delay:0.8s" x="230" y="260" width="40" height="110" rx="4" fill="url(#green)"/>
    <rect class="bar-grow" style="animation-delay:0.9s" x="290" y="220" width="40" height="150" rx="4" fill="url(#green)"/>
    
    <text class="label" x="58"  y="390">월</text>
    <text class="label" x="118" y="390">화</text>
    <text class="label" x="178" y="390">수</text>
    <text class="label" x="238" y="390">목</text>
    <text class="label" x="298" y="390">금</text>
  </g>
  
  <!-- 트렌드 라인 -->
  <g class="appear" style="animation-delay:0.5s">
    <text class="label" x="420" y="185">주간 트렌드</text>
    <path class="trend-line"
          d="M 420 350 Q 480 280, 520 300 T 600 260 T 700 220"
          fill="none" stroke="#3b82f6" stroke-width="2.5"
          stroke-linecap="round"/>
    <circle cx="700" cy="220" r="4" fill="#3b82f6" opacity="0"
            style="animation: fadeSlideUp 0.3s ease-out 2s forwards"/>
  </g>
</svg>
```

---

## 10. 요약 & 팁

1. **SVG는 `<style>` 태그 안에 CSS를 쓸 수 있다** — 별도 파일 불필요
2. **`animation-delay`가 핵심** — 0.1~0.2초 간격으로 순차 등장시키면 스트리밍과 시너지
3. **CSS 변수 필수** — `var(--text-color)` 등을 쓰지 않으면 다크모드에서 깨짐
4. **`opacity: 0` + `forwards`** — 애니메이션 전에는 숨기고, 끝난 후 상태 유지
5. **`<defs>`에 재사용 요소 정의** — 그래디언트, 필터, 클립패스 등
6. **`viewBox` 반드시 설정** — 반응형 렌더링의 기본
7. **JS 없이도 대부분 가능** — hover, 펄스, 드로잉 등 CSS만으로 충분
8. **복잡한 인터랙션이 필요하면** HTML 모드에서 SVG + JS 조합 사용

행운을 빕니다! 🎨