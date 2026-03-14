import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import 'katex/dist/katex.min.css';

SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('markup', markup);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('yaml', yaml);

function parseLanguage(className = '', codeText = '') {
  const match = /language-([a-zA-Z0-9_-]+)/.exec(className || '');
  const raw = (match?.[1] || '').toLowerCase();
  if (raw) return raw;

  if (/(^|\n)\s*(git|npm|pnpm|yarn|cd|cp|mv|rm|mkdir|curl|wget|python|node)\b/i.test(codeText)) {
    return 'bash';
  }
  return '';
}

function displayLanguage(lang) {
  if (!lang) return 'Code';
  if (lang === 'sh' || lang === 'bash' || lang === 'zsh' || lang === 'shell') return 'Bash';
  if (lang === 'js' || lang === 'javascript') return 'JavaScript';
  if (lang === 'ts' || lang === 'typescript') return 'TypeScript';
  if (lang === 'py' || lang === 'python') return 'Python';
  return lang[0].toUpperCase() + lang.slice(1);
}

const PREVIEWABLE_LANGS = new Set(['html', 'markup', 'htm', 'svg']);

function isPreviewable(lang, code) {
  if (PREVIEWABLE_LANGS.has(lang)) return true;
  if (!lang && (/<!doctype\s+html/i.test(code) || /<html[\s>]/i.test(code))) return true;
  return false;
}

const IFRAME_BASE_STYLE = 'html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:transparent;color:#1a1a1a;}body{padding:0;}';

const IFRAME_RESIZE_SCRIPT = `<script>
(function(){
  function send(){
    var b=document.body,d=document.documentElement;
    if(!b)return;
    var h=Math.max(b.scrollHeight,b.offsetHeight,b.clientHeight,d.scrollHeight,d.offsetHeight,d.clientHeight);
    // Also check all direct children to find the tallest
    var els=b.children;
    for(var i=0;i<els.length;i++){
      var r=els[i].getBoundingClientRect();
      var bottom=r.top+r.height+16;
      if(bottom>h)h=Math.ceil(bottom);
    }
    parent.postMessage({__iframeHeight:h},'*');
  }
  if(document.readyState==='complete')send();
  window.addEventListener('load',function(){send();setTimeout(send,100);setTimeout(send,500);setTimeout(send,1500);setTimeout(send,3000);});
  document.addEventListener('DOMContentLoaded',send);
  if(window.ResizeObserver){new ResizeObserver(send).observe(document.documentElement);}
  setInterval(send,1000);
  document.addEventListener('click',function(){setTimeout(send,50);setTimeout(send,300);setTimeout(send,800);});
})();
</script>`;

function buildSrcdoc(code) {
  // Always append base style + resize script at the end, regardless of HTML structure
  const styleTag = `<style>${IFRAME_BASE_STYLE}</style>`;
  if (/<!doctype\s+html/i.test(code) || /<html[\s>]/i.test(code)) {
    return code + styleTag + IFRAME_RESIZE_SCRIPT;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styleTag}</head><body>${code}${IFRAME_RESIZE_SCRIPT}</body></html>`;
}

let previewIdCounter = 0;

function HtmlPreview({ code, seamless = false }) {
  const iframeRef = useRef(null);
  const idRef = useRef(`preview-${++previewIdCounter}`);
  const [height, setHeight] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const srcdoc = useMemo(() => {
    const src = buildSrcdoc(code);
    return src.replace('__iframeHeight:', `__iframeId:"${idRef.current}",__iframeHeight:`);
  }, [code]);

  useEffect(() => {
    const id = idRef.current;
    const handler = (e) => {
      if (e.data && e.data.__iframeId === id && typeof e.data.__iframeHeight === 'number') {
        setHeight(e.data.__iframeHeight);
        setLoaded(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      className={seamless ? 'interactive-iframe' : 'md-preview-iframe'}
      style={{
        height: loaded ? `${height}px` : (seamless ? '200px' : '300px'),
        transition: loaded ? 'height 0.2s ease' : 'none',
      }}
      title="HTML 미리보기"
      scrolling="no"
    />
  );
}

function MarkdownCode({ inline, className, children, ...props }) {
  const [copied, setCopied] = useState(false);
  const codeText = useMemo(() => String(children || '').replace(/\n$/, ''), [children]);
  const lang = parseLanguage(className, codeText);
  const label = displayLanguage(lang);
  const canPreview = useMemo(() => isPreviewable(lang, codeText), [lang, codeText]);
  const [showPreview, setShowPreview] = useState(canPreview);

  // Treat as inline: explicit inline, or single-line short code without language tag
  const isShortBlock = !inline && !lang && !codeText.includes('\n') && codeText.length <= 60;
  if (inline || isShortBlock) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  const handleCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(codeText);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-toolbar">
        <span className="md-codeblock-lang">{label}</span>
        <div className="md-codeblock-actions">
          {canPreview && (
            <button
              type="button"
              className={`md-codeblock-preview-btn ${showPreview ? 'active' : ''}`}
              onClick={() => setShowPreview((v) => !v)}
              title={showPreview ? '코드 보기' : '미리보기'}
            >
              {showPreview ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                  <path d="M16 4l4 0 0 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M20 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6"/>
                </svg>
              )}
              <span>{showPreview ? '코드' : '미리보기'}</span>
            </button>
          )}
          <button
            type="button"
            className="md-codeblock-copy"
            onClick={handleCopy}
            aria-label="코드 복사"
            title={copied ? '복사됨' : '복사'}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect x="4" y="8" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
              <path d="M15.3462 15H17C18.6569 15 20 13.6569 20 12V7C20 5.34315 18.6569 4 17 4H12C10.3431 4 9 5.34315 9 7V7.53571" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
        </div>
      </div>
      {showPreview ? (
        <div className="md-preview-container">
          <HtmlPreview code={codeText} />
        </div>
      ) : (
        <div className="md-codeblock-body">
          <SyntaxHighlighter
            language={lang || 'text'}
            style={oneLight}
            customStyle={{ margin: 0, background: 'transparent', padding: '14px 16px', borderRadius: 0 }}
            codeTagProps={{
              style: {
                fontSize: '0.88rem',
                lineHeight: 1.5,
                background: 'transparent',
                borderRadius: 0,
                padding: 0,
                display: 'block',
              },
            }}
            wrapLongLines
          >
            {codeText}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  );
}

function InteractiveMenu({ code }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
    setOpen(false);
  };

  const handleDownload = () => {
    const blob = new Blob([code], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'interactive.html';
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  };

  return (
    <div className="interactive-menu" ref={menuRef}>
      <button
        type="button"
        className="interactive-menu-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="메뉴"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="6" r="1.5" fill="currentColor"/>
          <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
          <circle cx="12" cy="18" r="1.5" fill="currentColor"/>
        </svg>
      </button>
      {open && (
        <div className="interactive-menu-dropdown">
          <button type="button" onClick={handleCopy}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="4" y="8" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.6"/>
              <path d="M15.3 15H17a3 3 0 003-3V7a3 3 0 00-3-3h-5a3 3 0 00-3 3v.5" stroke="currentColor" strokeWidth="1.6"/>
            </svg>
            {copied ? '복사됨!' : '코드 복사'}
          </button>
          <button type="button" onClick={handleDownload}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 3v13m0 0l-4-4m4 4l4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            다운로드
          </button>
        </div>
      )}
    </div>
  );
}

function ChatMessage({ message, isStreaming }) {
  const isUser = message.role === 'user';

  return (
    <article className={`message ${isUser ? 'message-user' : 'message-assistant'} ${message.isError ? 'message-error' : ''}`}>
      {!isUser && (
        <div className="assistant-meta">
          <span className="assistant-meta-logo" aria-hidden="true">✺</span>
          <span className="assistant-meta-name">
            issamGPT <span className="assistant-meta-tier">Pro</span>
          </span>
        </div>
      )}

      <div className="message-content">
        {message.content ? (
          isUser ? message.content : (
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeRaw, rehypeKatex]}
                components={{ code: MarkdownCode }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )
        ) : isStreaming ? (
          <span className="cursor-blink" />
        ) : null}
        {message.interactiveHtml && (
          <div className="interactive-embed">
            <InteractiveMenu code={message.interactiveHtml} />
            <HtmlPreview code={message.interactiveHtml} seamless />
          </div>
        )}
        {message.interactiveCaption && (
          <div className="interactive-caption markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.interactiveCaption}</ReactMarkdown>
          </div>
        )}
      </div>
    </article>
  );
}

export default ChatMessage;
