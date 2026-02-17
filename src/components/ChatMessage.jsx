import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
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
          title={copied ? 'Copied' : 'Copy'}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <SyntaxHighlighter
        language={lang || 'text'}
        style={oneDark}
        customStyle={{ margin: 0, background: 'transparent', padding: '8px 12px' }}
        codeTagProps={{ style: { fontSize: '0.79rem', lineHeight: 1.45 } }}
        PreTag="div"
        wrapLongLines
      >
        {codeText}
      </SyntaxHighlighter>
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
            issamGPT <span className="assistant-meta-tier">Lite</span>
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
