import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
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

function MarkdownCode({ inline, className, children, ...props }) {
  const [copied, setCopied] = useState(false);
  const codeText = useMemo(() => String(children || '').replace(/\n$/, ''), [children]);
  const lang = parseLanguage(className, codeText);
  const label = displayLanguage(lang);

  if (inline) {
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
      <div className="md-codeblock-body">
        <SyntaxHighlighter
          language={lang || 'text'}
          style={oneLight}
          customStyle={{ margin: 0, background: 'transparent', padding: '14px 16px', borderRadius: 0 }}
          codeTagProps={{
            style: {
              fontSize: '0.94rem',
              lineHeight: 1.58,
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
                rehypePlugins={[rehypeKatex]}
                components={{ code: MarkdownCode }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )
        ) : isStreaming ? (
          <span className="cursor-blink" />
        ) : null}
      </div>
    </article>
  );
}

export default ChatMessage;
